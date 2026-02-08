
import * as fs from 'fs';
import * as path from 'path';
import { getVaultPath } from '../vault/db';

export function getQuarantinePath(planId: string, actionId: string): string {
    const vaultPath = getVaultPath();
    const basePath = path.join(vaultPath, 'backups', planId, actionId);
    if (!fs.existsSync(basePath)) {
        fs.mkdirSync(basePath, { recursive: true });
    }
    return basePath;
}

/**
 * Copies the file at sourcePath to the quarantine directory for the given action plan.
 * Returns the absolute path to the backup file.
 */
export function quarantineFile(
    sourcePath: string,
    planId: string,
    actionId: string
): string {
    const backupDir = getQuarantinePath(planId, actionId);
    const filename = path.basename(sourcePath);
    const destPath = path.join(backupDir, filename);

    if (fs.existsSync(sourcePath)) {
        fs.copyFileSync(sourcePath, destPath);
        return destPath;
    }
    throw new Error(`File not found for quarantine: ${sourcePath}`);
}

/**
 * Restores a file from backup to its original location.
 */
export function restoreFile(backupPath: string, originalPath: string): void {
    if (!fs.existsSync(backupPath)) {
        throw new Error(`Backup file not found: ${backupPath}`);
    }

    const parent = path.dirname(originalPath);
    if (!fs.existsSync(parent)) {
        fs.mkdirSync(parent, { recursive: true });
    }

    // Copy back, preserving the backup (idempotent undo)
    fs.copyFileSync(backupPath, originalPath);
}
