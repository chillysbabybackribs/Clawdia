import * as fs from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';
import {
  createFileCheckpoint,
  disposeFileCheckpoint,
  restoreFileCheckpoint,
} from './checkpoint-manager';

describe('checkpoint manager', () => {
  it('restores original content for existing files', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'clawdia-cp-existing-'));
    const filePath = path.join(dir, 'example.txt');
    await fs.writeFile(filePath, 'original');

    const checkpoint = await createFileCheckpoint(filePath);
    await fs.writeFile(filePath, 'changed');

    const restored = await restoreFileCheckpoint(checkpoint);
    const final = await fs.readFile(filePath, 'utf-8');

    expect(restored.ok).toBe(true);
    expect(final).toBe('original');

    await disposeFileCheckpoint(checkpoint);
  });

  it('removes newly created files when restoring non-existent checkpoints', async () => {
    const dir = await fs.mkdtemp(path.join(tmpdir(), 'clawdia-cp-new-'));
    const filePath = path.join(dir, 'new.txt');

    const checkpoint = await createFileCheckpoint(filePath);
    expect(checkpoint.existed).toBe(false);

    await fs.writeFile(filePath, 'new');
    const restored = await restoreFileCheckpoint(checkpoint);

    await expect(fs.stat(filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(restored.ok).toBe(true);
  });
});

