
import { getVaultDB } from './db';
import { DocumentEntity, IngestionJob, IngestionStatus } from '../../shared/vault-types';
import { Chunk } from '../ingestion/chunker';
import { randomUUID } from 'crypto';

export interface DBChunk extends Chunk {
    id: string;
    documentId: string;
    pageNumber?: number;
}

// Map SQL row to DocumentEntity
function mapDocument(row: any): DocumentEntity {
    return {
        id: row.id,
        hash: row.hash,
        mimeType: row.mime_type,
        sizeBytes: row.size_bytes,
        metadataJson: row.metadata_json,
        addedAt: row.added_at,
    };
}

// Map SQL row to IngestionJob
function mapJob(row: any): IngestionJob {
    return {
        id: row.id,
        sourceUri: row.source_uri,
        status: row.status as IngestionStatus,
        errorMessage: row.error_message,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        documentId: row.document_id,
    };
}

export function findDocumentByHash(hash: string): DocumentEntity | undefined {
    const db = getVaultDB();
    const row = db.prepare('SELECT * FROM documents WHERE hash = ?').get(hash);
    return row ? mapDocument(row) : undefined;
}

export function getDocumentSources(documentId: string): string[] {
    const db = getVaultDB();
    const rows = db.prepare('SELECT source_uri FROM document_sources WHERE document_id = ?').all(documentId);
    return rows.map((r: any) => r.source_uri);
}

export function createIngestionJob(uri: string): IngestionJob {
    const db = getVaultDB();
    const job: IngestionJob = {
        id: randomUUID(),
        sourceUri: uri,
        status: 'pending',
        startedAt: Math.floor(Date.now() / 1000),
    };

    db.prepare(`
        INSERT INTO ingestion_jobs (id, source_uri, status, started_at)
        VALUES (@id, @sourceUri, @status, @startedAt)
    `).run(job);

    return job;
}

export function getIngestionJob(id: string): IngestionJob | undefined {
    const db = getVaultDB();
    const row = db.prepare('SELECT * FROM ingestion_jobs WHERE id = ?').get(id);
    return row ? mapJob(row) : undefined;
}

export function updateIngestionJob(
    id: string,
    updates: {
        status: IngestionStatus;
        errorMessage?: string;
        documentId?: string;
        completedAt?: number
    }
): void {
    const db = getVaultDB();

    const setClause: string[] = [];
    const params: any = { id };

    if (updates.status) {
        setClause.push('status = @status');
        params.status = updates.status;
    }
    if (updates.errorMessage !== undefined) {
        setClause.push('error_message = @errorMessage');
        params.errorMessage = updates.errorMessage;
    }
    if (updates.documentId !== undefined) {
        setClause.push('document_id = @documentId');
        params.documentId = updates.documentId;
    }
    if (updates.completedAt !== undefined) {
        setClause.push('completed_at = @completedAt');
        params.completedAt = updates.completedAt;
    }

    if (setClause.length === 0) return;

    db.prepare(`UPDATE ingestion_jobs SET ${setClause.join(', ')} WHERE id = @id`).run(params);
}

export function upsertDocumentSource(uri: string, documentId: string): void {
    const db = getVaultDB();
    const now = Math.floor(Date.now() / 1000);

    // Upsert: If exists, update last_seen_at. If not, insert.
    // However, source_uri is PK.
    // If we have a conflict (uri exists), we update document_id (in case file content changed!) 
    // and last_seen_at.

    db.prepare(`
        INSERT INTO document_sources (source_uri, document_id, last_seen_at)
        VALUES (?, ?, ?)
        ON CONFLICT(source_uri) DO UPDATE SET
            document_id = excluded.document_id,
            last_seen_at = excluded.last_seen_at
    `).run(uri, documentId, now);
}

/**
 * Transactionally inserts a new document, its source mapping, and all its chunks.
 */
export function ingestNewDocument(
    doc: DocumentEntity,
    chunks: Chunk[],
    sourceUri: string
): void {
    const db = getVaultDB();

    const insertDoc = db.prepare(`
        INSERT INTO documents (id, hash, mime_type, size_bytes, metadata_json, added_at)
        VALUES (@id, @hash, @mimeType, @sizeBytes, @metadataJson, @addedAt)
    `);

    const insertSource = db.prepare(`
        INSERT INTO document_sources (source_uri, document_id, last_seen_at)
        VALUES (@sourceUri, @documentId, @addedAt)
        ON CONFLICT(source_uri) DO UPDATE SET
            document_id = excluded.document_id,
            last_seen_at = excluded.last_seen_at
    `);

    const insertChunk = db.prepare(`
        INSERT INTO chunks (
            id, document_id, content, content_hash, chunk_index, 
            page_number, start_char_offset, end_char_offset
        )
        VALUES (
            @id, @documentId, @content, @contentHash, @chunkIndex, 
            @pageNumber, @startCharOffset, @endCharOffset
        )
    `);

    const ingestTransaction = db.transaction(() => {
        insertDoc.run(doc);
        insertSource.run({ sourceUri, documentId: doc.id, addedAt: doc.addedAt });

        for (const chunk of chunks) {
            insertChunk.run({
                id: randomUUID(),
                documentId: doc.id,
                content: chunk.content,
                contentHash: chunk.content_hash,
                chunkIndex: chunk.chunk_index,
                pageNumber: null, // Basic text extraction has no pages yet
                startCharOffset: chunk.start_char_offset,
                endCharOffset: chunk.end_char_offset
            });
        }
    });

    ingestTransaction();
}

/**
 * Removes a source mapping. 
 * If the document has no other sources pointing to it, should we delete it?
 * For now, we keep orphaned documents (maybe archival later).
 */
export function removeDocumentSource(uri: string): void {
    const db = getVaultDB();
    db.prepare('DELETE FROM document_sources WHERE source_uri = ?').run(uri);
}
