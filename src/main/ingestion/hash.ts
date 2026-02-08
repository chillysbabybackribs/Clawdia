
import { createHash } from 'crypto';
import * as fs from 'fs';

export function hashContent(content: string | Buffer): string {
    const hash = createHash('sha256');
    hash.update(content);
    return hash.digest('hex');
}

export function hashFile(filePath: string): string {
    const fileBuffer = fs.readFileSync(filePath);
    return hashContent(fileBuffer);
}
