
import { getVaultDB } from '../vault/db';
import { ActionPlan, ActionItem, ActionPlanStatus, ActionType, ActionStatus } from '../../shared/vault-types';
import { randomUUID } from 'crypto';

function mapPlan(row: any): ActionPlan {
    return {
        id: row.id,
        description: row.description,
        status: row.status as ActionPlanStatus,
        createdAt: row.created_at
    };
}

function mapAction(row: any): ActionItem {
    return {
        id: row.id,
        planId: row.plan_id,
        sequenceOrder: row.sequence_order,
        type: row.type as ActionType,
        status: row.status as ActionStatus,
        payloadJson: row.payload_json,
        backupPath: row.backup_path,
        executedAt: row.executed_at,
        errorMessage: row.error_message
    };
}

export function createPlan(description: string): ActionPlan {
    const db = getVaultDB();
    const plan: ActionPlan = {
        id: randomUUID(),
        description,
        status: 'draft',
        createdAt: Math.floor(Date.now() / 1000)
    };

    db.prepare(`
        INSERT INTO action_plans (id, description, status, created_at)
        VALUES (@id, @description, @status, @createdAt)
    `).run(plan);

    return plan;
}

export function addAction(
    planId: string,
    type: ActionType,
    payload: any,
    sequenceOrder: number
): ActionItem {
    const db = getVaultDB();
    const action: ActionItem = {
        id: randomUUID(),
        planId,
        sequenceOrder,
        type,
        status: 'pending',
        payloadJson: JSON.stringify(payload)
    };

    db.prepare(`
        INSERT INTO actions (id, plan_id, sequence_order, type, status, payload_json)
        VALUES (@id, @planId, @sequenceOrder, @type, @status, @payloadJson)
    `).run(action);

    return action;
}

export function updateActionStatus(
    id: string,
    status: ActionStatus,
    executedAt?: number,
    errorMessage?: string,
    backupPath?: string
): void {
    const db = getVaultDB();

    const setClause: string[] = [];
    const params: any = { id };

    if (status) { setClause.push('status = @status'); params.status = status; }
    if (executedAt) { setClause.push('executed_at = @executedAt'); params.executedAt = executedAt; }
    if (errorMessage !== undefined) { setClause.push('error_message = @errorMessage'); params.errorMessage = errorMessage; }
    if (backupPath) { setClause.push('backup_path = @backupPath'); params.backupPath = backupPath; }

    if (setClause.length === 0) return;

    db.prepare(`UPDATE actions SET ${setClause.join(', ')} WHERE id = @id`).run(params);
}

export function updatePlanStatus(id: string, status: ActionPlanStatus): void {
    const db = getVaultDB();
    db.prepare('UPDATE action_plans SET status = ? WHERE id = ?').run(status, id);
}

export function getPlan(id: string): ActionPlan | undefined {
    const db = getVaultDB();
    const row = db.prepare('SELECT * FROM action_plans WHERE id = ?').get(id);
    return row ? mapPlan(row) : undefined;
}

export function getActions(planId: string): ActionItem[] {
    const db = getVaultDB();
    const rows = db.prepare('SELECT * FROM actions WHERE plan_id = ? ORDER BY sequence_order ASC').all(planId);
    return rows.map(mapAction);
}

export function getPlanIds(): string[] {
    const db = getVaultDB();
    const rows = db.prepare('SELECT id FROM action_plans ORDER BY created_at DESC').all();
    return rows.map((row: any) => row.id);
}
