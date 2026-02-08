
import { chunkText } from './chunker';
import { hashFile } from './hash';
import { extractFile } from './extractors';
import * as db from '../vault/documents';
import { DocumentEntity } from '../../shared/vault-types';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { EventEmitter } from 'events';

export const ingestionEmitter = new EventEmitter();

export class IngestionManager {
    /**
     * Ingests a file into the Vault.
     * Handles deduplication, extraction, chunking, and indexing.
     * @param rawPath - Absolute or relative path to the file.
     * @returns The Document ID.
     */
    static async ingest(rawPath: string): Promise<string> {
        const filePath = path.resolve(rawPath);
        const sourceUri = `file://${filePath}`;

        // 1. Create Job (Persistence for resilience/UI feedback)
        const job = db.createIngestionJob(sourceUri);
        ingestionEmitter.emit('job-update', job);

        try {
            db.updateIngestionJob(job.id, { status: 'processing' });
            ingestionEmitter.emit('job-update', { ...job, status: 'processing' });

            if (!fs.existsSync(filePath)) {
                throw new Error(`File not found: ${filePath}`);
            }

            // 2. Hash Content (SHA-256 of binary)
            // This is the primary key for deduplication.
            const fileHash = hashFile(filePath);

            // 3. Check DB for existing document (Deduplication)
            const existingDoc = db.findDocumentByHash(fileHash);

            if (existingDoc) {
                // Determine if we need to update anything?
                // Just link the source to this existing doc.
                db.upsertDocumentSource(sourceUri, existingDoc.id);

                const finalJob = {
                    ...job,
                    status: 'completed' as const,
                    documentId: existingDoc.id,
                    completedAt: Math.floor(Date.now() / 1000)
                };
                db.updateIngestionJob(job.id, finalJob);
                ingestionEmitter.emit('job-update', finalJob);
                return existingDoc.id;
            }

            // 4. Extract Text & Metadata
            // This runs if content is new.
            const extracted = await extractFile(filePath);

            // 5. Deterministic Chunking
            const chunks = chunkText(extracted.text);

            // 6. Create Document Entity
            const docId = randomUUID();
            const stats = fs.statSync(filePath);

            const doc: DocumentEntity = {
                id: docId,
                hash: fileHash,
                mimeType: extracted.metadata.mimeType || 'application/octet-stream',
                sizeBytes: stats.size,
                metadataJson: JSON.stringify({
                    filename: path.basename(filePath),
                    ...extracted.metadata
                }),
                addedAt: Math.floor(Date.now() / 1000)
            };

            // 7. Atomic Transaction (Save Doc + Source + Chunks)
            db.ingestNewDocument(doc, chunks, sourceUri);

            const finalJob = {
                ...job,
                status: 'completed' as const,
                documentId: docId,
                completedAt: Math.floor(Date.now() / 1000)
            };
            db.updateIngestionJob(job.id, finalJob);
            ingestionEmitter.emit('job-update', finalJob);

            return docId;

        } catch (error: any) {
            const finalJob = {
                ...job,
                status: 'failed' as const,
                errorMessage: error.message
            };
            db.updateIngestionJob(job.id, finalJob);
            ingestionEmitter.emit('job-update', finalJob);
            throw error;
        }
    }
}
