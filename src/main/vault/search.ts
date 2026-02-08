
import { getVaultDB } from './db';
import { VaultCitation } from '../../shared/vault-types';
import * as fs from 'fs';

export class VaultSearch {
    /**
     * Search usage:
     * const results = await VaultSearch.search('machine learning', 10);
     */
    static async search(query: string, limit: number = 20): Promise<VaultCitation[]> {
        const db = getVaultDB();

        // FTS5 query with snippets (optional) or just full content
        // We retrieve chunk metadata and join with rank
        // Note: 'rank' in FTS5 is a hidden column representing match quality (lower is better usually for default rank)
        // But let's use bm25() for scoring if possible, or just trust 'rank'.
        // Standard FTS5: ORDER BY rank

        // We need to join with `chunks` table to get real IDs and offsets, 
        // because `chunks_fts` might not store everything or we want the canonical data.
        // `chunks_fts` content_rowid maps to `chunks.chunk_rowid`.

        const sql = `
            SELECT 
                c.id as chunk_id,
                c.document_id,
                c.content,
                c.page_number,
                c.start_char_offset,
                c.end_char_offset,
                fts.rank as score
            FROM chunks_fts fts
            JOIN chunks c ON c.chunk_rowid = fts.rowid
            WHERE fts.chunks_fts MATCH @query
            ORDER BY fts.rank ASC
            LIMIT @limit
        `;

        const rows = db.prepare(sql).all({ query, limit }) as any[];

        const citations: VaultCitation[] = [];

        for (const row of rows) {
            // Resolve best source
            // We do this per result (N+1 query? N is small, e.g. 10-20. It's fine for local SQLite)
            const sourceUri = this.resolveSource(row.document_id);

            citations.push({
                documentId: row.document_id,
                chunkId: row.chunk_id,
                text: row.content,
                locator: {
                    pageNumber: row.page_number,
                    charRange: [row.start_char_offset, row.end_char_offset]
                },
                sourceUri: sourceUri || 'unknown://',
                // FTS5 rank is lower-is-better (usually negative or small float). 
                // We might want to normalize or just return raw.
                // Let's invert it or document it. User expects high score = good match? 
                // Let's just return raw rank for now.
                score: row.score
            });
        }

        return citations;
    }

    /**
     * Determines the best source URI for a document.
     * Prefers local files that exist, then recent files.
     */
    private static resolveSource(documentId: string): string | null {
        const db = getVaultDB();
        const sources = db.prepare(`
            SELECT source_uri, last_seen_at 
            FROM document_sources 
            WHERE document_id = ?
            ORDER BY last_seen_at DESC
        `).all(documentId) as any[];

        if (sources.length === 0) return null;

        // Strategy:
        // 1. Find the first 'file://' URI that actually exists on disk.
        // 2. Fallback to the most recent 'file://' even if check fails (maybe transient issue).
        // 3. Fallback to any other URI (https://).

        let bestFile: string | null = null;
        let recentFile: string | null = null;
        let other: string | null = null;

        for (const src of sources) {
            const uri = src.source_uri as string;

            if (uri.startsWith('file://')) {
                if (!recentFile) recentFile = uri; // First one is most recent

                // Check existence
                try {
                    const p = uri.replace('file://', ''); // Naive parsing, fine for unix
                    // Decode URI component if needed? path.resolve handles basic paths.
                    // But `file:///home/user/Space%20Name.txt` needs decoding.
                    const decodedPath = decodeURIComponent(p);
                    if (fs.existsSync(decodedPath)) {
                        bestFile = uri;
                        break; // Found best local file
                    }
                } catch {
                    // Ignore error
                }
            } else {
                if (!other) other = uri;
            }
        }

        return bestFile || recentFile || other || (sources[0] as any).source_uri;
    }
}
