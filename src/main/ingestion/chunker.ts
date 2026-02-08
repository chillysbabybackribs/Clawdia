
import { createHash } from 'crypto';

export const TARGET_CHUNK_SIZE = 1500;
export const OVERLAP_SIZE = 200;

export interface Chunk {
    content: string;
    content_hash: string;
    start_char_offset: number;
    end_char_offset: number;
    chunk_index: number;
}

function hashContent(text: string): string {
    return createHash('sha256').update(text).digest('hex');
}

/**
 * Deterministic chunking strategy:
 * 1. Normalize newlines.
 * 2. Split by double newlines (paragraphs).
 * 3. Accumulate paragraphs until target size is reached.
 * 4. Handle large paragraphs by splitting at sentence boundaries.
 */
export function chunkText(text: string): Chunk[] {
    const normalizedText = text.replace(/\r\n/g, '\n');
    const paragraphs = normalizedText.split('\n\n');
    const chunks: Chunk[] = [];

    let currentChunkParams: string[] = [];
    let currentLength = 0;

    // Track global offset to provide accurate start/end character positions
    // We need to re-construct positions based on the original text structure
    // This is tricky with normalization. We'll simplify: 
    // We will assume normalized text for offsets.
    let currentOffset = 0;

    for (let i = 0; i < paragraphs.length; i++) {
        let para = paragraphs[i];

        // If paragraph is huge, we need to split it internally
        if (para.length > TARGET_CHUNK_SIZE) {
            // 1. Flush current accumulated chunk if any
            if (currentChunkParams.length > 0) {
                const content = currentChunkParams.join('\n\n');
                chunks.push({
                    content,
                    content_hash: hashContent(content),
                    chunk_index: chunks.length,
                    start_char_offset: currentOffset - content.length, // Approximate
                    end_char_offset: currentOffset
                });
                currentChunkParams = [];
                currentLength = 0;
            }

            // 2. Split large paragraph by sentences
            // Use a simple lookahead for '. ' to split
            const sentences = para.match(/[^.!?]+[.!?]+(\s+|$)/g) || [para];

            let subChunk: string[] = [];
            let subLength = 0;

            for (const sentence of sentences) {
                if (subLength + sentence.length > TARGET_CHUNK_SIZE && subChunk.length > 0) {
                    const content = subChunk.join('');
                    chunks.push({
                        content,
                        content_hash: hashContent(content),
                        chunk_index: chunks.length,
                        start_char_offset: 0, // TODO: track
                        end_char_offset: 0
                    });
                    // Overlap logic for sentences: keep last sentence?
                    // For now, strict split to avoid complexity
                    subChunk = [sentence]; // Start new with current
                    subLength = sentence.length;
                } else {
                    subChunk.push(sentence);
                    subLength += sentence.length;
                }
            }
            if (subChunk.length > 0) {
                // Add remainder to next accumulation or emit?
                // Treat remainder as the start of the next accumulation
                currentChunkParams.push(subChunk.join(''));
                currentLength += subChunk.join('').length;
            }
        } else {
            // Normal paragraph accumulation
            if (currentLength + para.length + 2 > TARGET_CHUNK_SIZE) {
                // Emit current
                const content = currentChunkParams.join('\n\n');
                chunks.push({
                    content,
                    content_hash: hashContent(content),
                    chunk_index: chunks.length,
                    start_char_offset: 0, // TODO: Needs calculation
                    end_char_offset: 0
                });

                // Overlap: Keep last paragraph(s) that fit in OVERLAP_SIZE?
                // This is the semantic overlap.
                let overlapBuffer: string[] = [];
                let overlapLen = 0;
                for (let j = currentChunkParams.length - 1; j >= 0; j--) {
                    const p = currentChunkParams[j];
                    if (overlapLen + p.length < OVERLAP_SIZE) {
                        overlapBuffer.unshift(p);
                        overlapLen += p.length + 2;
                    } else {
                        break;
                    }
                }

                currentChunkParams = [...overlapBuffer, para];
                currentLength = overlapLen + para.length;
            } else {
                currentChunkParams.push(para);
                currentLength += para.length + 2; // +2 for \n\n
            }
        }
    }

    // Flush remaining
    if (currentChunkParams.length > 0) {
        const content = currentChunkParams.join('\n\n');
        chunks.push({
            content,
            content_hash: hashContent(content),
            chunk_index: chunks.length,
            start_char_offset: 0,
            end_char_offset: 0
        });
    }

    // Fix offsets
    // This is a post-processing step to map chunks back to original text roughly
    // Actually, searching for the chunk content in the normalized text is robust enough
    // locally, assuming uniqueness or sequential order.
    let searchStart = 0;
    for (const chunk of chunks) {
        const idx = normalizedText.indexOf(chunk.content, searchStart);
        if (idx !== -1) {
            chunk.start_char_offset = idx;
            chunk.end_char_offset = idx + chunk.content.length;
            // Optimization: move searchStart forward, but allow for overlap!
            // We can move it to just after the start to ensure we find the *next* occurrence
            // properly if there are duplicates (unlikely with large chunks)
            // But with overlap, the next chunk WILL start before this one ends.
            // So we should update searchStart based on the chunk logic, but `indexOf` is safe if we strictly move forward
            // slightly. 
            // Better: `searchStart = idx + 1;` 
            // But if we have excessive overlap, we might skip? No, next chunk starts ~idx + overlap.
            searchStart = idx + 1;
        }
    }

    return chunks;
}
