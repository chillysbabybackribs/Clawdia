
import * as fs from 'fs/promises';
import { extname } from 'path';

export interface ExtractedContent {
    text: string;
    metadata: Record<string, any>;
    pages?: { pageNumber: number, text: string }[];
}

export type Extractor = (filePath: string) => Promise<ExtractedContent>;

const textExtractor: Extractor = async (filePath: string) => {
    const text = await fs.readFile(filePath, 'utf-8');
    return {
        text,
        metadata: { mimeType: 'text/plain' }
    };
};

const markdownExtractor: Extractor = async (filePath: string) => {
    // For now, treat as plain text. Later can extract frontmatter.
    const text = await fs.readFile(filePath, 'utf-8');
    return {
        text,
        metadata: { mimeType: 'text/markdown' }
    };
};

// Simple router
export async function extractFile(filePath: string): Promise<ExtractedContent> {
    const ext = extname(filePath).toLowerCase();
    switch (ext) {
        case '.md':
        case '.markdown':
            return markdownExtractor(filePath);
        case '.txt':
        case '.json':
        case '.ts':
        case '.js':
        case '.yml':
        case '.yaml':
        case '.sql':
            return textExtractor(filePath);
        default:
            // Fallback to text for unknown files? Or error?
            // For now, if we can read as utf8, we try.
            try {
                return await textExtractor(filePath);
            } catch {
                throw new Error(`Unsupported file type: ${ext}`);
            }
    }
}
