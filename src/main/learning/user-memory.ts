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
        source TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_referenced DATETIME,
        UNIQUE(category, key)
      );

      CREATE INDEX IF NOT EXISTS idx_memory_category ON user_memory(category);
      CREATE INDEX IF NOT EXISTS idx_memory_key ON user_memory(key);
    `);
  }

  private isSensitive(value: string): boolean {
    const lower = value.toLowerCase();
    return lower.includes('password') || lower.includes('api key') || /sk-[a-z0-9]/i.test(value);
  }

  remember(category: string, key: string, value: string, source = 'extracted'): void {
    if (!category || !key || !value) return;
    if (this.isSensitive(value)) return;

    this.db
      .prepare(
        `
        INSERT INTO user_memory (category, key, value, source, last_referenced)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(category, key) DO UPDATE SET
          value = excluded.value,
          confidence = confidence + 1,
          source = excluded.source,
          last_referenced = CURRENT_TIMESTAMP
      `
      )
      .run(category, key, value, source);
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

  getPromptContext(maxChars = 1200): string {
    const memories = this.db
      .prepare(
        `
        SELECT category, key, value
        FROM user_memory
        WHERE confidence >= 1
        ORDER BY
          CASE WHEN last_referenced IS NOT NULL THEN 1 ELSE 2 END,
          COALESCE(last_referenced, created_at) DESC,
          confidence DESC
        LIMIT 30
      `
      )
      .all() as MemoryRecord[];

    if (memories.length === 0) return '';

    let context = '\n[User context]\n';
    let charCount = context.length;

    const grouped: Record<string, MemoryRecord[]> = {};
    for (const m of memories) {
      grouped[m.category] = grouped[m.category] || [];
      grouped[m.category].push(m);
    }

    for (const [category, items] of Object.entries(grouped)) {
      const header = `${category}: `;
      if (charCount + header.length > maxChars) break;
      context += header;
      charCount += header.length;
      for (const item of items) {
        const line = `${item.key} = ${item.value}\n`;
        if (charCount + line.length > maxChars) break;
        context += line;
        charCount += line.length;
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
