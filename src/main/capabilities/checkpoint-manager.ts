import { randomUUID } from 'crypto';
import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { createLogger } from '../logger';

const log = createLogger('checkpoint-manager');

const CHECKPOINT_ROOT = path.join(tmpdir(), 'clawdia-checkpoints');

export interface FileCheckpoint {
  id: string;
  filePath: string;
  backupPath: string | null;
  existed: boolean;
  createdAt: number;
}

async function ensureRoot(): Promise<void> {
  await fs.mkdir(CHECKPOINT_ROOT, { recursive: true });
}

export async function createFileCheckpoint(filePath: string): Promise<FileCheckpoint> {
  await ensureRoot();
  const id = randomUUID();
  const backupPath = path.join(CHECKPOINT_ROOT, `${id}.bak`);
  const createdAt = Date.now();

  try {
    await fs.stat(filePath);
    await fs.copyFile(filePath, backupPath);
    return { id, filePath, backupPath, existed: true, createdAt };
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      return { id, filePath, backupPath: null, existed: false, createdAt };
    }
    throw err;
  }
}

export async function restoreFileCheckpoint(checkpoint: FileCheckpoint): Promise<{ ok: boolean; detail: string }> {
  try {
    if (checkpoint.existed) {
      if (!checkpoint.backupPath) {
        return { ok: false, detail: 'Checkpoint backup missing for existing file.' };
      }
      await fs.mkdir(path.dirname(checkpoint.filePath), { recursive: true });
      await fs.copyFile(checkpoint.backupPath, checkpoint.filePath);
    } else {
      await fs.unlink(checkpoint.filePath).catch((err: any) => {
        if (err?.code !== 'ENOENT') throw err;
      });
    }
    return { ok: true, detail: 'Checkpoint restored.' };
  } catch (err: any) {
    log.warn(`[Checkpoint] Restore failed for ${checkpoint.filePath}: ${err?.message || err}`);
    return { ok: false, detail: err?.message || 'restore failed' };
  }
}

export async function disposeFileCheckpoint(checkpoint: FileCheckpoint): Promise<void> {
  if (!checkpoint.backupPath) return;
  await fs.unlink(checkpoint.backupPath).catch(() => {
    // best effort cleanup
  });
}

