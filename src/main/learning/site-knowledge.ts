import Database from 'better-sqlite3';
import path from 'path';
import { app } from 'electron';

export interface KnownApproach {
  working_method: string;
  working_selector: string | null;
  working_coordinates: string | null;
  notes: string | null;
  success_count: number;
  fail_count: number;
}

export class SiteKnowledgeBase {
  private db: Database.Database;

  constructor() {
    const dbPath = path.join(app.getPath('userData'), 'site-knowledge.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initSchema();
  }

  getDatabase(): Database.Database {
    return this.db;
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS site_knowledge (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname TEXT NOT NULL,
        action TEXT NOT NULL,
        target_ref TEXT,
        working_method TEXT,
        working_selector TEXT,
        working_coordinates TEXT,
        success_count INTEGER DEFAULT 0,
        fail_count INTEGER DEFAULT 0,
        last_success DATETIME,
        last_failure DATETIME,
        notes TEXT,
        page_context TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(hostname, action, target_ref)
      );

      CREATE INDEX IF NOT EXISTS idx_site_hostname ON site_knowledge(hostname);
      CREATE INDEX IF NOT EXISTS idx_site_action ON site_knowledge(hostname, action, target_ref);

      CREATE TABLE IF NOT EXISTS site_hints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hostname TEXT NOT NULL UNIQUE,
        hint TEXT NOT NULL,
        confidence INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);
  }

  getKnownApproach(hostname: string, action: string, targetRef: string): KnownApproach | null {
    const row = this.db
      .prepare(
        `
        SELECT working_method, working_selector, working_coordinates, notes, success_count, fail_count
        FROM site_knowledge
        WHERE hostname = ? AND action = ? AND target_ref = ?
          AND success_count > fail_count
        ORDER BY last_success DESC
        LIMIT 1
      `
      )
      .get(hostname, action, targetRef) as KnownApproach | undefined;

    if (!row) return null;
    if (row.success_count < 2) return null;
    return row as KnownApproach;
  }

  recordOutcome(params: {
    hostname: string;
    action: string;
    targetRef: string;
    success: boolean;
    method: string;
    selector?: string;
    coordinates?: string;
    pageContext?: string;
    notes?: string;
  }): void {
    const existing = this.db
      .prepare(
        `SELECT id FROM site_knowledge WHERE hostname = ? AND action = ? AND target_ref = ?`
      )
      .get(params.hostname, params.action, params.targetRef);

    if (existing) {
      if (params.success) {
        this.db
          .prepare(
            `
            UPDATE site_knowledge SET
              success_count = success_count + 1,
              last_success = CURRENT_TIMESTAMP,
              working_method = ?,
              working_selector = COALESCE(?, working_selector),
              working_coordinates = COALESCE(?, working_coordinates),
              notes = COALESCE(?, notes),
              page_context = COALESCE(?, page_context),
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `
          )
          .run(
            params.method,
            params.selector ?? null,
            params.coordinates ?? null,
            params.notes ?? null,
            params.pageContext ?? null,
            (existing as { id: number }).id
          );
      } else {
        this.db
          .prepare(
            `
            UPDATE site_knowledge SET
              fail_count = fail_count + 1,
              last_failure = CURRENT_TIMESTAMP,
              updated_at = CURRENT_TIMESTAMP
            WHERE id = ?
          `
          )
          .run((existing as { id: number }).id);
      }
      return;
    }

    this.db
      .prepare(
        `
        INSERT INTO site_knowledge (
          hostname, action, target_ref, working_method, working_selector, working_coordinates,
          success_count, fail_count, last_success, last_failure, page_context, notes
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `
      )
      .run(
        params.hostname,
        params.action,
        params.targetRef,
        params.success ? params.method : null,
        params.success ? params.selector ?? null : null,
        params.success ? params.coordinates ?? null : null,
        params.success ? 1 : 0,
        params.success ? 0 : 1,
        params.success ? new Date().toISOString() : null,
        params.success ? null : new Date().toISOString(),
        params.pageContext ?? null,
        params.notes ?? null
      );
  }

  getSiteHint(hostname: string): string | null {
    const row = this.db.prepare(`SELECT hint FROM site_hints WHERE hostname = ?`).get(hostname) as
      | { hint: string }
      | undefined;
    return row?.hint ?? null;
  }

  recordSiteHint(hostname: string, hint: string): void {
    this.db
      .prepare(
        `
        INSERT INTO site_hints (hostname, hint)
        VALUES (?, ?)
        ON CONFLICT(hostname) DO UPDATE SET
          hint = excluded.hint,
          confidence = confidence + 1,
          updated_at = CURRENT_TIMESTAMP
      `
      )
      .run(hostname, hint);
  }

  getContextForHostname(hostname: string): string {
    const knowledge = this.db
      .prepare(
        `
        SELECT action, target_ref, working_method, working_selector, notes, success_count
        FROM site_knowledge
        WHERE hostname = ? AND success_count > fail_count AND success_count >= 2
        ORDER BY success_count DESC, last_success DESC
        LIMIT 15
      `
      )
      .all(hostname) as Array<{
        action: string;
        target_ref: string;
        working_method: string;
        working_selector: string | null;
        notes: string | null;
        success_count: number;
      }>;

    const hint = this.getSiteHint(hostname);

    if (knowledge.length === 0 && !hint) return '';

    let context = `\n[Site knowledge for ${hostname}]\n`;
    if (hint) context += `General: ${hint}\n`;
    for (const k of knowledge) {
      context += `${k.action} "${k.target_ref}": use ${k.working_method}`;
      if (k.working_selector) context += ` → ${k.working_selector}`;
      if (k.notes) context += ` (${k.notes})`;
      context += '\n';
    }
    return context;
  }

  getTopSiteContext(limit = 5): string {
    const sites = this.db
      .prepare(
        `
        SELECT hostname, SUM(success_count + fail_count) AS total
        FROM site_knowledge
        GROUP BY hostname
        ORDER BY total DESC
        LIMIT ?
      `
      )
      .all(limit);

    if (sites.length === 0) return '';

    let context = '';
    for (const site of sites as Array<{ hostname: string }>) {
      context += this.getContextForHostname(site.hostname);
    }
    return context;
  }

  prune(): void {
    this.db
      .prepare(
        `
        DELETE FROM site_knowledge
        WHERE updated_at < datetime('now', '-90 days')
          AND success_count < 3
      `
      )
      .run();
  }

  reset(): void {
    this.db.prepare('DELETE FROM site_knowledge').run();
    this.db.prepare('DELETE FROM site_hints').run();
  }

  close(): void {
    this.db.close();
  }
}
