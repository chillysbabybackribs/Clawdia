
import { executeTool as executeBrowserTool } from '../browser/tools';
import { executeLocalTool } from '../local/tools';
import { resolveModelId } from '../../shared/models';
import { createLogger } from '../logger';
import type { Page } from 'playwright';
import type { AnthropicClient } from '../llm/client';
import type {
    TaskExecutor,
    ExecutorStep,
    ExpectCondition,
    ExecutorRunResult,
} from '../../shared/task-types';

const log = createLogger('executor-runner');

/**
 * Runs a cached TaskExecutor WITHOUT the full LLM tool loop.
 * Steps through the executor's steps array sequentially, routing
 * tool calls through the existing dispatch functions and LLM calls
 * through Haiku via client.complete().
 */
export class ExecutorRunner {
    private variables: Map<string, any> = new Map();
    private client: AnthropicClient;
    private isolatedPage: Page | null = null;

    constructor(client: AnthropicClient, isolatedPage?: Page | null) {
        this.client = client;
        this.isolatedPage = isolatedPage ?? null;
    }

    async run(executor: TaskExecutor): Promise<ExecutorRunResult> {
        const startMs = Date.now();
        const totalSteps = executor.steps.length;

        for (const [i, step] of executor.steps.entries()) {
            // Check timeout
            if (executor.validation.max_duration_ms > 0) {
                const elapsed = Date.now() - startMs;
                if (elapsed > executor.validation.max_duration_ms) {
                    log.warn(`[Executor] Timed out at step ${i + 1}/${totalSteps} after ${elapsed}ms`);
                    return { success: false, failedAt: i, reason: 'step_error', error: new Error('Executor timeout') };
                }
            }

            try {
                const result = await this.executeStep(step, i, totalSteps);

                // Check expect conditions if present
                if ('expect' in step && step.expect && !this.checkExpect(step.expect, result)) {
                    log.warn(`[Executor] Step ${i + 1}/${totalSteps}: ${this.stepLabel(step)} — expect condition failed`);
                    return { success: false, failedAt: i, reason: 'expect_failed' };
                }

                // Store result if step has store_as
                if ('store_as' in step && step.store_as) {
                    this.variables.set(step.store_as, result);
                }
            } catch (error: any) {
                log.error(`[Executor] Step ${i + 1}/${totalSteps}: ${this.stepLabel(step)} — error: ${error?.message || error}`);
                return { success: false, failedAt: i, reason: 'step_error', error };
            }
        }

        // Build final result from template
        const resultStep = executor.steps.find(s => s.type === 'result');
        const finalResult = resultStep && resultStep.type === 'result'
            ? this.interpolate(resultStep.template)
            : this.variables.get('summary') || 'Task completed';

        const totalMs = Date.now() - startMs;
        log.info(`[Executor] Completed in ${totalMs}ms (${totalSteps} steps)`);

        return { success: true, result: finalResult };
    }

    private async executeStep(step: ExecutorStep, index: number, total: number): Promise<any> {
        const label = `Step ${index + 1}/${total}`;
        const t0 = Date.now();

        switch (step.type) {
            case 'tool': {
                // Route to the correct executor by tool name prefix,
                // same dispatch logic as tool-loop.ts.
                const interpolatedInput = this.interpolateObject(step.tool_input);
                let result: string;

                if (step.tool_name.startsWith('browser_') || step.tool_name === 'cache_read') {
                    result = await executeBrowserTool(step.tool_name, interpolatedInput, this.isolatedPage);
                } else {
                    result = await executeLocalTool(step.tool_name, interpolatedInput);
                }

                const ms = Date.now() - t0;
                log.info(`[Executor] ${label}: ${step.tool_name} ✓ (${ms}ms, ${result.length} chars)`);
                return result;
            }

            case 'llm': {
                // Uses Haiku via client.complete() — the only step that costs money.
                const prompt = this.interpolate(step.prompt_template);
                const haikuModel = resolveModelId('haiku');
                const response = await this.client.complete(
                    [{ role: 'user' as const, content: prompt }],
                    { model: haikuModel, maxTokens: step.max_tokens || 500 },
                );

                const ms = Date.now() - t0;
                log.info(`[Executor] ${label}: llm (haiku) ✓ (${ms}ms, ${response.text.length} chars)`);
                return response.text;
            }

            case 'condition': {
                const condResult = this.evaluateCondition(step.expression);
                if (!condResult && step.on_true === 'abort') {
                    throw new Error(step.message || 'Condition not met');
                }
                log.info(`[Executor] ${label}: condition → ${condResult}`);
                return condResult;
            }

            case 'result': {
                const result = this.interpolate(step.template);
                log.info(`[Executor] ${label}: result → formatted ✓`);
                return result;
            }
        }
    }

    private interpolate(template: string): string {
        return template.replace(/\{\{(\w+(?:[\.\[\]\w]*)*)\}\}/g, (_, key) => {
            return this.resolveVariable(key) ?? `[missing: ${key}]`;
        });
    }

    private interpolateObject(obj: Record<string, any>): Record<string, any> {
        const result: Record<string, any> = {};
        for (const [k, v] of Object.entries(obj)) {
            if (typeof v === 'string') {
                result[k] = this.interpolate(v);
            } else if (Array.isArray(v)) {
                result[k] = v.map(item =>
                    typeof item === 'string' ? this.interpolate(item)
                        : (typeof item === 'object' && item !== null) ? this.interpolateObject(item)
                            : item
                );
            } else if (typeof v === 'object' && v !== null) {
                result[k] = this.interpolateObject(v);
            } else {
                result[k] = v;
            }
        }
        return result;
    }

    private resolveVariable(key: string): string | undefined {
        const parts = key.split('.');
        let value: any = this.variables.get(parts[0]);
        for (let i = 1; i < parts.length && value != null; i++) {
            // Handle bracket notation: articles[0]
            const part = parts[i];
            const bracketMatch = part.match(/^(\w+)\[(\d+)\]$/);
            if (bracketMatch) {
                value = value[bracketMatch[1]];
                if (Array.isArray(value)) value = value[Number(bracketMatch[2])];
            } else {
                value = value[part];
            }
        }
        return value != null ? String(value) : undefined;
    }

    private evaluateCondition(expression: string): boolean {
        const interpolated = this.interpolate(expression);
        if (interpolated.includes('!= empty')) {
            const val = interpolated.replace('!= empty', '').trim();
            return val !== '' && !val.includes('[missing:');
        }
        if (interpolated.includes('.length >')) {
            const match = interpolated.match(/(\d+)\s*>\s*(\d+)/);
            return match ? Number(match[1]) > Number(match[2]) : false;
        }
        return interpolated !== '' && !interpolated.includes('[missing:');
    }

    private checkExpect(expect: ExpectCondition, result: any): boolean {
        if (expect.contains_text && typeof result === 'string') {
            if (!result.includes(expect.contains_text)) return false;
        }
        if (expect.min_results !== undefined && typeof result === 'string') {
            try {
                const parsed = JSON.parse(result);
                if (Array.isArray(parsed) && parsed.length < expect.min_results) return false;
            } catch {
                const lines = result.split('\n').filter((l: string) => l.trim());
                if (lines.length < expect.min_results) return false;
            }
        }
        return true;
    }

    private stepLabel(step: ExecutorStep): string {
        switch (step.type) {
            case 'tool': return step.tool_name;
            case 'llm': return 'llm (haiku)';
            case 'condition': return 'condition';
            case 'result': return 'result';
        }
    }
}
