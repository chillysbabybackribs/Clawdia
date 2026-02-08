
import * as fs from 'fs';
import * as path from 'path';
import { getActions, updateActionStatus, updatePlanStatus } from './ledger';
import { quarantineFile, restoreFile } from './quarantine';
import { ActionItem } from '../../shared/vault-types';

export class ActionExecutor {
    static async executePlan(planId: string): Promise<void> {
        // 1. Mark plan executing
        updatePlanStatus(planId, 'executing');

        const actions = getActions(planId);

        for (const action of actions) {
            // Skip already executed
            if (action.status === 'executed') continue;

            try {
                const payload = JSON.parse(action.payloadJson);
                let backupPath: string | undefined;

                switch (action.type) {
                    case 'fs_write': {
                        const { path: filePath, content, encoding } = payload;
                        const absPath = path.resolve(filePath);

                        // Quarantine if exists (overwrite protection)
                        if (fs.existsSync(absPath)) {
                            backupPath = quarantineFile(absPath, action.planId, action.id);
                        }

                        // Ensure dir exists
                        const dir = path.dirname(absPath);
                        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

                        fs.writeFileSync(absPath, content, encoding || 'utf-8');
                        break;
                    }
                    case 'fs_delete': {
                        const { path: filePath } = payload;
                        const absPath = path.resolve(filePath);

                        if (fs.existsSync(absPath)) {
                            backupPath = quarantineFile(absPath, action.planId, action.id);
                            fs.unlinkSync(absPath);
                        }
                        break;
                    }
                    case 'fs_move': {
                        const { source, dest } = payload;
                        const absSource = path.resolve(source);
                        const absDest = path.resolve(dest);

                        if (!fs.existsSync(absSource)) {
                            throw new Error(`Source file not found: ${absSource}`);
                        }

                        // If dest exists, backup dest (overwrite protection)
                        // Note: Rename overwrites by default on POSIX? Node fs.rename overwrites.
                        if (fs.existsSync(absDest)) {
                            backupPath = quarantineFile(absDest, action.planId, action.id);
                        }

                        const destDir = path.dirname(absDest);
                        if (!fs.existsSync(destDir)) fs.mkdirSync(destDir, { recursive: true });

                        fs.renameSync(absSource, absDest);
                        break;
                    }
                    default:
                        // No-op or DB insert?
                        break;
                }

                // Update Success
                updateActionStatus(
                    action.id,
                    'executed',
                    Math.floor(Date.now() / 1000),
                    undefined,
                    backupPath
                );

            } catch (error: any) {
                updateActionStatus(action.id, 'failed', undefined, error.message);
                updatePlanStatus(planId, 'failed');
                throw error; // Stop execution of plan
            }
        }

        updatePlanStatus(planId, 'done');
    }

    static async undoPlan(planId: string): Promise<void> {
        // Reverse execution order
        const actions = getActions(planId);
        // We only undo executed actions
        const executedActions = actions.filter(a => a.status === 'executed').reverse();

        for (const action of executedActions) {
            try {
                const payload = JSON.parse(action.payloadJson);

                if (action.type === 'fs_write') {
                    const absPath = path.resolve(payload.path);
                    if (action.backupPath) {
                        // Restore original
                        restoreFile(action.backupPath, absPath);
                    } else {
                        // Created new file -> Delete it
                        if (fs.existsSync(absPath)) fs.unlinkSync(absPath);
                    }
                }
                else if (action.type === 'fs_delete') {
                    const absPath = path.resolve(payload.path);
                    if (action.backupPath) {
                        // Restore deleted file
                        restoreFile(action.backupPath, absPath);
                    }
                }
                else if (action.type === 'fs_move') {
                    const absSource = path.resolve(payload.source);
                    const absDest = path.resolve(payload.dest);

                    // 1. Move back (dest -> source)
                    if (fs.existsSync(absDest)) {
                        fs.renameSync(absDest, absSource);
                    }

                    // 2. Restore overwritten dest if any
                    if (action.backupPath) {
                        restoreFile(action.backupPath, absDest);
                    }
                }

                updateActionStatus(action.id, 'rolled_back');

            } catch (error: any) {
                console.error(`Failed to rollback action ${action.id}:`, error);
                // Continue rolling back others? 
                // Or mark plan as partially rolled back.
                updateActionStatus(action.id, 'failed', undefined, `Rollback failed: ${error.message}`);
            }
        }

        // If all rolled back successfully?
        const check = getActions(planId);
        const allRolledBack = check.filter(a => a.status === 'executed').length === 0;

        if (allRolledBack) {
            updatePlanStatus(planId, 'draft'); // Ready to retry or edit
        } else {
            updatePlanStatus(planId, 'failed'); // Stuck in partial state
        }
    }
}
