
export const VAULT_SCHEMA_VERSION = 1;
export const EXTRACTOR_VERSION = 1;  // Bump to force re-extraction
export const CHUNKER_VERSION = 1;    // Bump to force re-chunking

export interface VaultCitation {
    documentId: string;
    chunkId: string;
    text: string;           // The exact text content of the chunk
    locator: {
        pageNumber?: number;    // If extractor provided it (best effort)
        charRange: [number, number]; // [start, end] in extracted text
    };
    sourceUri: string;      // Resolved primary source URI
    score: number;          // FTS rank
}

export type IngestionStatus = 'pending' | 'processing' | 'completed' | 'failed';

export interface IngestionJob {
    id: string;
    sourceUri: string;
    status: IngestionStatus;
    errorMessage?: string;
    startedAt: number;
    completedAt?: number;
    documentId?: string;
}

export interface DocumentEntity {
    id: string;
    hash: string;
    mimeType: string;
    sizeBytes: number;
    metadataJson: string;
    addedAt: number;
}

export type ActionPlanStatus = 'draft' | 'approved' | 'executing' | 'done' | 'failed';
export type ActionType = 'fs_write' | 'fs_delete' | 'fs_move' | 'db_insert';
export type ActionStatus = 'pending' | 'executed' | 'failed' | 'rolled_back';

export interface ActionPlan {
    id: string;
    description: string;
    status: ActionPlanStatus;
    createdAt: number;
}

export interface ActionItem {
    id: string;
    planId: string;
    sequenceOrder: number;
    type: ActionType;
    status: ActionStatus;
    payloadJson: string;
    backupPath?: string;
    executedAt?: number;
    errorMessage?: string;
}
