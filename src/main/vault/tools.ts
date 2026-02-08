
import { Tool } from '../../shared/types';
import { VaultSearch } from './search';
import { IngestionManager } from '../ingestion/manager';
import { createPlan, addAction, getPlan, getActions, getPlanIds } from '../actions/ledger';
import { ActionExecutor } from '../actions/executor';

export const VAULT_TOOL_DEFINITIONS: Tool[] = [
    {
        name: 'vault_search',
        description: 'Search the Knowledge Vault for documents and text chunks. Use this to find information in ingested files.',
        input_schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'The search query string.',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum number of results to return (default 20).',
                },
            },
            required: ['query'],
        },
    },
    {
        name: 'vault_ingest',
        description: 'Ingest a file into the Knowledge Vault. Handles text extraction, chunking, and indexing. Supports duplication detection.',
        input_schema: {
            type: 'object',
            properties: {
                path: {
                    type: 'string',
                    description: 'Absolute path to the file to ingest.',
                },
            },
            required: ['path'],
        },
    },
    {
        name: 'action_create_plan',
        description: 'Create a new Action Plan to track a sequence of reversible file operations.',
        input_schema: {
            type: 'object',
            properties: {
                description: {
                    type: 'string',
                    description: 'Description of what this plan intends to do.',
                },
            },
            required: ['description'],
        },
    },
    {
        name: 'action_add_item',
        description: 'Add an action item (step) to an existing Action Plan.',
        input_schema: {
            type: 'object',
            properties: {
                planId: {
                    type: 'string',
                    description: 'The ID of the Action Plan.',
                },
                type: {
                    type: 'string',
                    enum: ['fs_write', 'fs_delete', 'fs_move', 'db_insert'],
                    description: 'The type of action.',
                },
                payload: {
                    type: 'object',
                    description: 'The parameters for the action (e.g., { path, content } for fs_write).',
                },
                sequenceOrder: {
                    type: 'number',
                    description: 'The order of this action in the plan (1-indexed).',
                },
            },
            required: ['planId', 'type', 'payload', 'sequenceOrder'],
        },
    },
    {
        name: 'action_execute_plan',
        description: 'Execute all pending actions in an Action Plan transactionally. Backs up files for undo capability.',
        input_schema: {
            type: 'object',
            properties: {
                planId: {
                    type: 'string',
                    description: 'The ID of the Action Plan to execute.',
                },
            },
            required: ['planId'],
        },
    },
    {
        name: 'action_undo_plan',
        description: 'Undo an executed Action Plan, restoring all files to their previous state.',
        input_schema: {
            type: 'object',
            properties: {
                planId: {
                    type: 'string',
                    description: 'The ID of the Action Plan to undo.',
                },
            },
            required: ['planId'],
        },
    },
    {
        name: 'action_list_plans',
        description: 'List all action plans.',
        input_schema: {
            type: 'object',
            properties: {},
        }
    }
];

export async function executeVaultTool(
    name: string,
    input: Record<string, unknown>
): Promise<string> {
    try {
        switch (name) {
            case 'vault_search': {
                const query = input.query as string;
                const limit = (input.limit as number) || 20;
                const results = await VaultSearch.search(query, limit);
                if (results.length === 0) return 'No results found.';
                return JSON.stringify(results, null, 2);
            }

            case 'vault_ingest': {
                const path = input.path as string;
                const docId = await IngestionManager.ingest(path);
                return `Successfully ingested file. Document ID: ${docId}`;
            }

            case 'action_create_plan': {
                const desc = input.description as string;
                const plan = createPlan(desc);
                return JSON.stringify(plan, null, 2);
            }

            case 'action_add_item': {
                const planId = input.planId as string;
                const type = input.type as any;
                const payload = input.payload as any;
                const order = input.sequenceOrder as number;
                const item = addAction(planId, type, payload, order);
                return `Added action item ${item.id} to plan ${planId}`;
            }

            case 'action_execute_plan': {
                const planId = input.planId as string;
                await ActionExecutor.executePlan(planId);
                return `Successfully executed plan ${planId}`;
            }

            case 'action_undo_plan': {
                const planId = input.planId as string;
                await ActionExecutor.undoPlan(planId);
                return `Successfully undone plan ${planId}`;
            }

            case 'action_list_plans': {
                const ids = getPlanIds();
                const plans = ids.map(id => getPlan(id));
                return JSON.stringify(plans, null, 2);
            }

            default:
                throw new Error(`Unknown vault tool: ${name}`);
        }
    } catch (error: any) {
        return `Error executing ${name}: ${error.message}`;
    }
}
