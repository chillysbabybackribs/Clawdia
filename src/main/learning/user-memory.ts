import Database from 'better-sqlite3';

export interface MemoryRecord {
  category: string;
  key: string;
  value: string;
}

export class UserMemory {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.initSchema();
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS user_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        category TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        confidence INTEGER DEFAULT 1,
        source TEXT DEFAULT 'extracted',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_referenced DATETIME,
        UNIQUE(category, key)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_category ON user_memory(category);
      CREATE INDEX IF NOT EXISTS idx_memory_key ON user_memory(key);
    `);

    // Add source column for databases created before it existed
    try { this.db.exec(`ALTER TABLE user_memory ADD COLUMN source TEXT DEFAULT 'extracted'`); } catch { /* already exists */ }

    // FTS5 virtual table for relevance search
    this.db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS user_memory_fts
      USING fts5(key, value, content=user_memory, content_rowid=id);
    `);

    // Sync triggers to keep FTS5 in sync with user_memory
    this.db.exec(`
      CREATE TRIGGER IF NOT EXISTS user_memory_ai AFTER INSERT ON user_memory BEGIN
        INSERT INTO user_memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
      END;
      CREATE TRIGGER IF NOT EXISTS user_memory_ad AFTER DELETE ON user_memory BEGIN
        INSERT INTO user_memory_fts(user_memory_fts, rowid, key, value) VALUES('delete', old.id, old.key, old.value);
      END;
      CREATE TRIGGER IF NOT EXISTS user_memory_au AFTER UPDATE ON user_memory BEGIN
        INSERT INTO user_memory_fts(user_memory_fts, rowid, key, value) VALUES('delete', old.id, old.key, old.value);
        INSERT INTO user_memory_fts(rowid, key, value) VALUES (new.id, new.key, new.value);
      END;
    `);

    // Rebuild FTS index for any existing data
    this.db.exec(`INSERT INTO user_memory_fts(user_memory_fts) VALUES('rebuild')`);
  }

  private isSensitive(value: string): boolean {
    const lower = value.toLowerCase();
    return lower.includes('password') || lower.includes('api key') || /sk-[a-z0-9]/i.test(value);
  }

  remember(category: string, key: string, value: string, source: 'user' | 'extracted' | 'flush' = 'extracted'): void {
    if (!category || !key || !value) return;
    if (this.isSensitive(value)) return;

    const initialConfidence = source === 'user' ? 5 : source === 'flush' ? 2 : 1;

    this.db
      .prepare(
        `
        INSERT INTO user_memory (category, key, value, source, confidence, last_referenced)
        VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(category, key) DO UPDATE SET
          value = CASE
            WHEN user_memory.source = 'user' AND excluded.source != 'user'
            THEN user_memory.value
            ELSE excluded.value
          END,
          confidence = confidence + 1,
          source = CASE
            WHEN user_memory.source = 'user' AND excluded.source != 'user'
            THEN user_memory.source
            ELSE excluded.source
          END,
          last_referenced = CURRENT_TIMESTAMP
      `
      )
      .run(category, key, value, source, initialConfidence);
  }

  recall(category: string, key: string): string | null {
    const row = this.db
      .prepare('SELECT value FROM user_memory WHERE category = ? AND key = ?')
      .get(category, key);
    if (row) {
      this.db
        .prepare('UPDATE user_memory SET last_referenced = CURRENT_TIMESTAMP WHERE category = ? AND key = ?')
        .run(category, key);
    }
    return (row as { value?: string } | undefined)?.value ?? null;
  }

  recallCategory(category: string): MemoryRecord[] {
    return this.db
      .prepare(
        `
        SELECT category, key, value FROM user_memory
        WHERE category = ?
        ORDER BY confidence DESC, COALESCE(last_referenced, created_at) DESC
      `
      )
      .all(category) as MemoryRecord[];
  }

  recallAll(): MemoryRecord[] {
    return this.db
      .prepare(
        `
        SELECT category, key, value
        FROM user_memory
        ORDER BY confidence DESC, COALESCE(last_referenced, created_at) DESC
      `
      )
      .all() as MemoryRecord[];
  }

  searchByQuery(query: string, limit = 10): MemoryRecord[] {
    const tokens = query
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length > 2);
    if (tokens.length === 0) return [];

    const ftsQuery = tokens.map((t) => `"${t}"`).join(' AND ');
    try {
      return this.db
        .prepare(
          `
          SELECT um.category, um.key, um.value
          FROM user_memory_fts fts
          JOIN user_memory um ON um.id = fts.rowid
          WHERE user_memory_fts MATCH ?
          ORDER BY (1.0 / (1.0 + fts.rank)) + (um.confidence * 0.1) DESC
          LIMIT ?
        `
        )
        .all(ftsQuery, limit) as MemoryRecord[];
    } catch {
      return [];
    }
  }

  getPromptContext(maxChars = 1200, currentMessage?: string): string {
    // Pass 1 — Always-inject tier: user-sourced and high-confidence memories
    const pass1Budget = Math.floor(maxChars / 2);
    const alwaysInject = this.db
      .prepare(
        `
        SELECT category, key, value
        FROM user_memory
        WHERE source = 'user' OR confidence >= 5
        ORDER BY last_referenced DESC
        LIMIT 30
      `
      )
      .all() as MemoryRecord[];

    let context = '';
    let charCount = 0;

    if (alwaysInject.length > 0) {
      context = '\n[User context]\n';
      charCount = context.length;

      const grouped: Record<string, MemoryRecord[]> = {};
      for (const m of alwaysInject) {
        grouped[m.category] = grouped[m.category] || [];
        grouped[m.category].push(m);
      }

      for (const [category, items] of Object.entries(grouped)) {
        const header = `${category}: `;
        if (charCount + header.length > pass1Budget) break;
        context += header;
        charCount += header.length;
        for (const item of items) {
          const line = `${item.key} = ${item.value}\n`;
          if (charCount + line.length > pass1Budget) break;
          context += line;
          charCount += line.length;
        }
      }
    }

    // Pass 2 — Relevance-ranked tier: FTS5 search based on current message
    if (currentMessage) {
      const pass2Budget = maxChars - charCount;
      const relevant = this.searchByQuery(currentMessage, 15);

      // Filter out entries already in Pass 1
      const pass1Keys = new Set(alwaysInject.map((m) => `${m.category}:${m.key}`));
      const novel = relevant.filter((m) => !pass1Keys.has(`${m.category}:${m.key}`));

      if (novel.length > 0) {
        if (!context) {
          context = '\n[User context]\n';
          charCount = context.length;
        }
        for (const item of novel) {
          const line = `${item.category}: ${item.key} = ${item.value}\n`;
          if (charCount + line.length > maxChars) break;
          context += line;
          charCount += line.length;
        }
      }
    }

    return context.trimEnd();
  }

  forget(category: string, key: string): void {
    this.db.prepare('DELETE FROM user_memory WHERE category = ? AND key = ?').run(category, key);
  }

  reset(): void {
    this.db.prepare('DELETE FROM user_memory').run();
  }

  contradict(category: string, key: string): void {
    this.db
      .prepare(
        `
        UPDATE user_memory
        SET confidence = MAX(0, confidence - 2)
        WHERE category = ? AND key = ?
      `
      )
      .run(category, key);
    this.db.prepare('DELETE FROM user_memory WHERE confidence <= 0').run();
  }

  prune(): void {
    this.db
      .prepare(
        `
        DELETE FROM user_memory
        WHERE last_referenced < datetime('now', '-60 days')
          AND confidence < 3
      `
      )
      .run();
  }
}
