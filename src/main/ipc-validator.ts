import { IpcMainInvokeEvent, ipcMain } from 'electron';
import { IPC } from '../shared/ipc-channels';
import { CLAUDE_MODELS } from '../shared/models';
import {
  DocumentAttachment,
  ImageAttachment,
  type MCPServerConfig,
  type CapabilityPlatformFlags,
} from '../shared/types';
import { createLogger } from './logger';

const log = createLogger('ipc-validator');

type ValidationSuccess<T> = { valid: true; data: T };
type ValidationFailure = { valid: false; error: string };
type ValidationResult<T> = ValidationSuccess<T> | ValidationFailure;

// Core validator type
export type Validator<T> = (input: unknown) => ValidationResult<T>;

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ValidationError';
  }
}

const MODEL_IDS = CLAUDE_MODELS.map((model) => model.id);
const SEARCH_BACKENDS = ['serper', 'serpapi', 'bing', 'playwright'] as const;
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const;
const ANTHROPIC_KEY_PATTERN = /^sk-ant-[a-zA-Z0-9_-]+$/;
const IMAGE_MIME_PATTERN = /^image\/(png|jpeg|gif|webp)$/;
const NO_PAYLOAD = Symbol('no-payload');

export type NoPayload = typeof NO_PAYLOAD;
export type SearchBackend = (typeof SEARCH_BACKENDS)[number];
export type SettingsKey =
  | 'anthropic_api_key'
  | 'anthropicApiKey'
  | 'hasCompletedSetup'
  | 'selectedModel'
  | 'serper_api_key'
  | 'serpapi_api_key'
  | 'bing_api_key'
  | 'search_backend'
  | 'schemaVersion'
  | 'chat_tab_state'
  | 'browserHistory'
  | 'userAccounts'
  | 'conversations'
  | 'mcpServers';
export type SettingsValue =
  | string
  | boolean
  | number
  | SearchBackend
  | { tabIds: string[]; activeId: string | null }
  | Array<{ id: string; url: string; title: string; timestamp: number }>
  | unknown[]
  | MCPServerConfig[];

export interface ChatSendPayload {
  message: string;
  conversationId?: string;
  images?: ImageAttachment[];
  documents?: DocumentAttachment[];
  messageId?: string;
}

export interface ChatStopPayload {
  conversationId?: string;
}

export interface IdPayload {
  id: string;
}

export interface ChatTabsSetStatePayload {
  tabIds: string[];
  activeId: string | null;
}

export interface ApiKeySetPayload {
  key: string;
}

export interface ApiKeyValidatePayload {
  key: string;
  model: string;
}

export interface ModelSetPayload {
  model: string;
}

export interface SettingsSetPayload {
  key: SettingsKey;
  value: SettingsValue;
}

export interface BrowserNavigatePayload {
  url: string;
}

export interface BrowserSetBoundsPayload {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface BrowserNewTabPayload {
  url?: string;
}

export interface BrowserTabPayload {
  tabId: string;
}

export interface DocumentExtractPayload {
  buffer: number[];
  filename: string;
  mimeType: string;
}

export interface DocumentSavePayload {
  sourcePath: string;
  suggestedName: string;
}

export interface DocumentOpenFolderPayload {
  filePath: string;
}

export interface ClipboardWriteTextPayload {
  text: string;
}

export interface AccountAddPayload {
  domain: string;
  platform: string;
  username: string;
  profileUrl: string;
}

export interface AccountRemovePayload {
  id: string;
}

export interface LogLevelSetPayload {
  level: string;
}

export interface MemoryForgetPayload {
  category: string;
  key: string;
}

export interface SiteKnowledgePayload {
  hostname: string;
}

export interface VaultIngestPayload {
  filePath: string;
}

export interface VaultSearchPayload {
  query: string;
  limit?: number;
}

export interface ActionPlanCreatePayload {
  description: string;
}

export interface ActionAddItemPayload {
  planId: string;
  type: string;
  payload: any;
  sequenceOrder: number;
}

function ok<T>(data: T): ValidationSuccess<T> {
  return { valid: true, data };
}

function fail(error: string): ValidationFailure {
  return { valid: false, error };
}

function describeValue(input: unknown): string {
  if (input === null) return 'null';
  if (input === undefined) return 'undefined';
  if (typeof input === 'string') {
    const preview = input.length > 80 ? `${input.slice(0, 80)}...` : input;
    return `"${preview}"`;
  }
  if (typeof input === 'number' || typeof input === 'boolean') return String(input);
  if (Array.isArray(input)) return `array(${input.length})`;
  if (typeof input === 'object') return 'object';
  return typeof input;
}

function isPlainObject(input: unknown): input is Record<string, unknown> {
  return typeof input === 'object' && input !== null && !Array.isArray(input);
}

export function isString(field: string): Validator<string> {
  return (input: unknown) => {
    if (typeof input !== 'string') {
      return fail(`'${field}' must be a string, got ${describeValue(input)}`);
    }
    return ok(input);
  };
}

export function isNumber(field: string): Validator<number> {
  return (input: unknown) => {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      return fail(`'${field}' must be a finite number, got ${describeValue(input)}`);
    }
    return ok(input);
  };
}

export function isBoolean(field: string): Validator<boolean> {
  return (input: unknown) => {
    if (typeof input !== 'boolean') {
      return fail(`'${field}' must be a boolean, got ${describeValue(input)}`);
    }
    return ok(input);
  };
}

export function isOptionalString(field: string): Validator<string | undefined> {
  return (input: unknown) => {
    if (input === undefined) return ok(undefined);
    return isString(field)(input);
  };
}

export function isNonEmptyString(field: string): Validator<string> {
  return (input: unknown) => {
    if (typeof input !== 'string' || input.trim().length === 0) {
      return fail(`'${field}' must be a non-empty string, got ${describeValue(input)}`);
    }
    return ok(input);
  };
}

export function isStringMaxLength(field: string, max: number): Validator<string> {
  return (input: unknown) => {
    if (typeof input !== 'string') {
      return fail(`'${field}' must be a string, got ${describeValue(input)}`);
    }
    if (input.length > max) {
      return fail(`'${field}' must be at most ${max} characters, got ${input.length}`);
    }
    return ok(input);
  };
}

export function isStringPattern(field: string, pattern: RegExp, hint: string): Validator<string> {
  return (input: unknown) => {
    if (typeof input !== 'string') {
      return fail(`'${field}' must be a string, got ${describeValue(input)}`);
    }
    if (!pattern.test(input)) {
      return fail(`'${field}' must match ${hint}`);
    }
    return ok(input);
  };
}

export function isStringOneOf<T extends string>(field: string, allowed: readonly T[]): Validator<T> {
  return (input: unknown) => {
    if (typeof input !== 'string') {
      return fail(`'${field}' must be a string, got ${describeValue(input)}`);
    }
    if (!allowed.includes(input as T)) {
      return fail(`'${field}' must be one of: ${allowed.join(', ')}`);
    }
    return ok(input as T);
  };
}

export function isOptional<T>(validator: Validator<T>): Validator<T | undefined> {
  return (input: unknown) => {
    if (input === undefined) return ok(undefined);
    return validator(input);
  };
}

export function isNullableString(field: string): Validator<string | null> {
  return (input: unknown) => {
    if (input === null) return ok(null);
    return isString(field)(input);
  };
}

export function isNumberAtLeast(field: string, min: number): Validator<number> {
  return (input: unknown) => {
    const base = isNumber(field)(input);
    if (!base.valid) return base;
    if (base.data < min) {
      return fail(`'${field}' must be at least ${min}, got ${base.data}`);
    }
    return base;
  };
}

export function isIntegerInRange(field: string, min: number, max: number): Validator<number> {
  return (input: unknown) => {
    const base = isNumber(field)(input);
    if (!base.valid) return base;
    if (!Number.isInteger(base.data)) {
      return fail(`'${field}' must be an integer, got ${base.data}`);
    }
    if (base.data < min || base.data > max) {
      return fail(`'${field}' must be between ${min} and ${max}, got ${base.data}`);
    }
    return base;
  };
}

export function allOf<T>(...validators: Validator<T>[]): Validator<T> {
  return (input: unknown) => {
    const errors: string[] = [];
    let finalData: T | undefined;
    for (const validator of validators) {
      const result = validator(input);
      if (!result.valid) {
        errors.push(result.error);
        continue;
      }
      finalData = result.data;
    }
    if (errors.length > 0) {
      return fail(errors.join(', '));
    }
    return ok(finalData as T);
  };
}

export function isObject<T>(schema: Record<string, Validator<unknown>>): Validator<T> {
  return (input: unknown) => {
    if (!isPlainObject(input)) {
      return fail(`Expected object payload, got ${describeValue(input)}`);
    }

    const errors: string[] = [];
    const out: Record<string, unknown> = {};
    for (const [key, validator] of Object.entries(schema)) {
      const value = input[key];
      const result = validator(value);
      if (!result.valid) {
        errors.push(result.error);
        continue;
      }
      out[key] = result.data;
    }

    if (errors.length > 0) {
      return fail(errors.join(', '));
    }

    return ok(out as T);
  };
}

export function isArrayOf<T>(field: string, itemValidator: Validator<T>): Validator<T[]> {
  return (input: unknown) => {
    if (!Array.isArray(input)) {
      return fail(`'${field}' must be an array, got ${describeValue(input)}`);
    }

    const errors: string[] = [];
    const out: T[] = [];
    input.forEach((item, index) => {
      const result = itemValidator(item);
      if (!result.valid) {
        errors.push(`'${field}[${index}]' is invalid: ${result.error}`);
        return;
      }
      out.push(result.data);
    });

    if (errors.length > 0) {
      return fail(errors.join(', '));
    }

    return ok(out);
  };
}

export function isValidUrl(field: string): Validator<string> {
  return (input: unknown) => {
    if (typeof input !== 'string' || input.trim().length === 0) {
      return fail(`'${field}' is required`);
    }

    const normalized = input.trim();
    const withProtocol = normalized.startsWith('http://') || normalized.startsWith('https://')
      ? normalized
      : `https://${normalized}`;

    try {
      const parsed = new URL(withProtocol);
      if (!['http:', 'https:'].includes(parsed.protocol)) {
        return fail(`'${field}' must use http or https protocol`);
      }
      return ok(withProtocol);
    } catch {
      return fail(`'${field}' is not a valid URL`);
    }
  };
}

export const noPayload: Validator<NoPayload> = (input: unknown) => {
  if (input === undefined) return ok(NO_PAYLOAD);
  return fail(`This channel does not accept a payload, got ${describeValue(input)}`);
};

const passthroughValidator: Validator<unknown> = (input: unknown) => ok(input);

const imageAttachmentValidator = isObject<ImageAttachment>({
  base64: isNonEmptyString('base64'),
  mediaType: isStringPattern('mediaType', IMAGE_MIME_PATTERN, 'valid image MIME type'),
  width: isNumberAtLeast('width', 1),
  height: isNumberAtLeast('height', 1),
});

const documentAttachmentValidator = isObject<DocumentAttachment>({
  filename: isNonEmptyString('filename'),
  originalName: isNonEmptyString('originalName'),
  mimeType: isNonEmptyString('mimeType'),
  sizeBytes: isNumberAtLeast('sizeBytes', 0),
  extractedText: isString('extractedText'),
  pageCount: isOptional(isNumberAtLeast('pageCount', 1)),
  sheetNames: isOptional(isArrayOf('sheetNames', isNonEmptyString('sheetName'))),
  truncated: isOptional(isBoolean('truncated')),
});

const chatTabStateValidator = isObject<{ tabIds: string[]; activeId: string | null }>({
  tabIds: isArrayOf('tabIds', isNonEmptyString('tabId')),
  activeId: isNullableString('activeId'),
});

const browserHistoryEntryValidator = isObject<{ id: string; url: string; title: string; timestamp: number }>({
  id: isNonEmptyString('id'),
  url: isNonEmptyString('url'),
  title: isString('title'),
  timestamp: isNumberAtLeast('timestamp', 0),
});

const mcpToolSchemaValidator = isObject<{ name: string; description: string; inputSchema: Record<string, unknown> }>({
  name: isNonEmptyString('name'),
  description: isString('description'),
  inputSchema: passthroughValidator,
});

const mcpServerConfigValidator = isObject<MCPServerConfig>({
  name: isNonEmptyString('name'),
  command: isNonEmptyString('command'),
  args: isArrayOf('args', isString('arg')),
  tools: isArrayOf('tools', mcpToolSchemaValidator as Validator<{ name: string; description: string; inputSchema: Record<string, unknown> }>),
  idleTimeout: isOptional(isNumberAtLeast('idleTimeout', 0)),
});

const settingsKeyValidator = isStringOneOf<SettingsKey>('key', [
  'anthropic_api_key',
  'anthropicApiKey',
  'hasCompletedSetup',
  'selectedModel',
  'serper_api_key',
  'serpapi_api_key',
  'bing_api_key',
  'search_backend',
  'schemaVersion',
  'chat_tab_state',
  'browserHistory',
  'userAccounts',
  'conversations',
  'mcpServers',
] as const);

const settingsValueValidatorByKey: Record<SettingsKey, Validator<unknown>> = {
  anthropic_api_key: isString('value'),
  anthropicApiKey: isString('value'),
  hasCompletedSetup: isBoolean('value'),
  selectedModel: isStringOneOf('value', MODEL_IDS),
  serper_api_key: isString('value'),
  serpapi_api_key: isString('value'),
  bing_api_key: isString('value'),
  search_backend: isStringOneOf('value', SEARCH_BACKENDS),
  schemaVersion: isNumberAtLeast('value', 0),
  chat_tab_state: chatTabStateValidator as Validator<unknown>,
  browserHistory: isArrayOf('value', browserHistoryEntryValidator as Validator<{ id: string; url: string; title: string; timestamp: number }>),
  userAccounts: isArrayOf('value', passthroughValidator),
  conversations: isArrayOf('value', passthroughValidator),
  mcpServers: isArrayOf('value', mcpServerConfigValidator as Validator<MCPServerConfig>),
};

export const chatSendSchema = isObject<ChatSendPayload>({
  message: allOf(isNonEmptyString('message'), isStringMaxLength('message', 100_000)),
  conversationId: isOptionalString('conversationId'),
  images: isOptional(isArrayOf('images', imageAttachmentValidator)),
  documents: isOptional(isArrayOf('documents', documentAttachmentValidator)),
  messageId: isOptionalString('messageId'),
});

export const chatStopSchema = isOptional(
  isObject<ChatStopPayload>({
    conversationId: isOptionalString('conversationId'),
  })
);

export const idSchema = isObject<IdPayload>({
  id: isNonEmptyString('id'),
});

export const chatTabsSetStateSchema = chatTabStateValidator;

export const apiKeySetSchema = isObject<ApiKeySetPayload>({
  key: allOf(
    isNonEmptyString('key'),
    isStringPattern('key', ANTHROPIC_KEY_PATTERN, 'valid Anthropic API key format')
  ),
});

export const apiKeyValidateSchema = isObject<ApiKeyValidatePayload>({
  key: allOf(
    isNonEmptyString('key'),
    isStringPattern('key', ANTHROPIC_KEY_PATTERN, 'valid Anthropic API key format')
  ),
  model: isNonEmptyString('model'),
});

export const modelSetSchema = isObject<ModelSetPayload>({
  model: isStringOneOf('model', MODEL_IDS),
});

export const settingsSetSchema: Validator<SettingsSetPayload> = (input: unknown) => {
  const base = isObject<{ key: SettingsKey; value: unknown }>({
    key: settingsKeyValidator as Validator<unknown>,
    value: passthroughValidator,
  })(input);
  if (!base.valid) return base;

  const key = base.data.key;
  const valueResult = settingsValueValidatorByKey[key](base.data.value);
  if (!valueResult.valid) {
    return fail(`'value' for '${key}' is invalid: ${valueResult.error}`);
  }

  return ok({
    key,
    value: valueResult.data as SettingsValue,
  });
};

export const browserNavigateSchema = isObject<BrowserNavigatePayload>({
  url: allOf(isStringMaxLength('url', 4096), isValidUrl('url')),
});

export const browserSetBoundsSchema = isObject<BrowserSetBoundsPayload>({
  x: isNumber('x'),
  y: isNumber('y'),
  width: isNumberAtLeast('width', 1),
  height: isNumberAtLeast('height', 1),
});

export const browserTabNewSchema = isObject<BrowserNewTabPayload>({
  url: isOptional(allOf(isStringMaxLength('url', 4096), isValidUrl('url'))),
});

export const browserTabSchema = isObject<BrowserTabPayload>({
  tabId: isNonEmptyString('tabId'),
});

export const documentExtractSchema = isObject<DocumentExtractPayload>({
  buffer: isArrayOf('buffer', isIntegerInRange('bufferByte', 0, 255)),
  filename: isNonEmptyString('filename'),
  mimeType: isNonEmptyString('mimeType'),
});

export const documentSaveSchema = isObject<DocumentSavePayload>({
  sourcePath: isNonEmptyString('sourcePath'),
  suggestedName: isNonEmptyString('suggestedName'),
});

export const documentOpenFolderSchema = isObject<DocumentOpenFolderPayload>({
  filePath: isNonEmptyString('filePath'),
});

export const fileOpenSchema = isObject<{ filePath: string }>({
  filePath: isNonEmptyString('filePath'),
});

export const fileOpenInAppSchema = isObject<{ filePath: string }>({
  filePath: isNonEmptyString('filePath'),
});

export const clipboardWriteTextSchema = isObject<ClipboardWriteTextPayload>({
  text: isString('text'),
});

export const accountAddSchema = isObject<AccountAddPayload>({
  domain: isNonEmptyString('domain'),
  platform: isNonEmptyString('platform'),
  username: isNonEmptyString('username'),
  profileUrl: isString('profileUrl'),
});

export const accountRemoveSchema = isObject<AccountRemovePayload>({
  id: isNonEmptyString('id'),
});

export const logLevelSetSchema = isObject<LogLevelSetPayload>({
  level: isStringOneOf('level', LOG_LEVELS),
});

export const memoryForgetSchema = isObject<MemoryForgetPayload>({
  category: isNonEmptyString('category'),
  key: isNonEmptyString('key'),
});

export const siteKnowledgeSchema = isObject<SiteKnowledgePayload>({
  hostname: isNonEmptyString('hostname'),
});

export const vaultIngestSchema = isObject<VaultIngestPayload>({
  filePath: isNonEmptyString('filePath'),
});

export const vaultSearchSchema = isObject<VaultSearchPayload>({
  query: isNonEmptyString('query'),
  limit: isOptional(isNumberAtLeast('limit', 1)),
});

export const actionCreatePlanSchema = isObject<ActionPlanCreatePayload>({
  description: isNonEmptyString('description'),
});

export const actionAddItemSchema = isObject<ActionAddItemPayload>({
  planId: isNonEmptyString('planId'),
  type: isStringOneOf('type', ['fs_write', 'fs_delete', 'fs_move', 'db_insert']),
  payload: passthroughValidator,
  sequenceOrder: isNumberAtLeast('sequenceOrder', 0),
});

export const actionIdSchema = isObject<{ planId: string }>({
  planId: isNonEmptyString('planId'),
});

export interface DashboardDismissRulePayload {
  ruleId: string;
}

export interface DashboardSetVisiblePayload {
  visible: boolean;
}

export interface DashboardDismissAlertPayload {
  alertId: string;
}

export const dashboardDismissRuleSchema = isObject<DashboardDismissRulePayload>({
  ruleId: isNonEmptyString('ruleId'),
});

export const dashboardDismissAlertSchema = isObject<DashboardDismissAlertPayload>({
  alertId: isNonEmptyString('alertId'),
});

export const dashboardSetVisibleSchema = isObject<DashboardSetVisiblePayload>({
  visible: isBoolean('visible'),
});

export interface AmbientSettingsSetPayload {
  settings: Record<string, unknown>;
}

export const ambientSettingsSetSchema = isObject<AmbientSettingsSetPayload>({
  settings: (input: unknown) => {
    if (!isPlainObject(input)) return fail(`'settings' must be an object, got ${describeValue(input)}`);
    return ok(input as Record<string, unknown>);
  },
});

export interface CapabilityPlatformFlagsSetPayload {
  flags: Partial<CapabilityPlatformFlags>;
}

const capabilityPlatformFlagsSchema = isObject<Partial<CapabilityPlatformFlags>>({
  enabled: isOptional(isBoolean('enabled')),
  cohort: isOptional(isStringOneOf('cohort', ['internal', 'beta', 'default'] as const)),
  lifecycleEvents: isOptional(isBoolean('lifecycleEvents')),
  installOrchestrator: isOptional(isBoolean('installOrchestrator')),
  checkpointRollback: isOptional(isBoolean('checkpointRollback')),
  mcpRuntimeManager: isOptional(isBoolean('mcpRuntimeManager')),
  containerExecution: isOptional(isBoolean('containerExecution')),
});

export const capabilityPlatformFlagsSetSchema = isObject<CapabilityPlatformFlagsSetPayload>({
  flags: capabilityPlatformFlagsSchema as Validator<Partial<CapabilityPlatformFlags>>,
});

// Autonomy mode
const AUTONOMY_MODES = ['safe', 'guided', 'unrestricted'] as const;

export interface AutonomySetPayload {
  mode: (typeof AUTONOMY_MODES)[number];
  confirmUnrestricted?: boolean;
}

export interface AutonomyRemoveAlwaysApprovalPayload {
  risk: string;
}

export const autonomySetSchema = isObject<AutonomySetPayload>({
  mode: isStringOneOf('mode', AUTONOMY_MODES),
  confirmUnrestricted: isOptional(isBoolean('confirmUnrestricted')),
});

export const autonomyRemoveAlwaysApprovalSchema = isObject<AutonomyRemoveAlwaysApprovalPayload>({
  risk: isNonEmptyString('risk'),
});

// Task payloads
export interface TaskIdPayload { taskId: string }
export interface TaskRunIdPayload { runId: string }

export const taskIdSchema = isObject<TaskIdPayload>({
  taskId: isNonEmptyString('taskId'),
});

export const taskRunIdSchema = isObject<TaskRunIdPayload>({
  runId: isNonEmptyString('runId'),
});

// Telegram
export interface TelegramSetTokenPayload { token: string }
export interface TelegramSetEnabledPayload { enabled: boolean }
export const telegramSetTokenSchema = isObject<TelegramSetTokenPayload>({
  token: isNonEmptyString('token'),
});
export const telegramSetEnabledSchema = isObject<TelegramSetEnabledPayload>({
  enabled: isBoolean('enabled'),
});

export const approvalResponseSchema = isObject<{ id: string; decision: string }>({
  id: isNonEmptyString('id'),
  decision: isStringOneOf('decision', ['APPROVE', 'TASK', 'ALWAYS', 'DENY']),
});

export function validate<T>(input: unknown, validator: Validator<T>): T {
  const result = validator(input);
  if (result.valid) return result.data;
  throw new ValidationError(result.error);
}

export function handleValidated<TInput, TOutput>(
  channel: string,
  validator: Validator<TInput>,
  handler: (event: IpcMainInvokeEvent, data: TInput) => Promise<TOutput> | TOutput
): void {
  log.info(`[IPC] Registering handler for channel: ${channel}`);
  ipcMain.handle(channel, async (event, ...rawArgs: unknown[]) => {
    const rawPayload = rawArgs.length === 0 ? undefined : rawArgs.length === 1 ? rawArgs[0] : rawArgs;
    try {
      const data = validate(rawPayload, validator);
      return await handler(event, data);
    } catch (err) {
      if (err instanceof ValidationError) {
        const message = `IPC validation failed [${channel}]: ${err.message}`;
        log.warn(`IPC validation failed [${channel}]`, { error: err.message });
        return { error: message, code: 'INVALID_PAYLOAD' as const };
      }
      throw err;
    }
  });
}

export const ipcSchemas = {
  [IPC.CHAT_SEND]: chatSendSchema,
  [IPC.CHAT_STOP]: chatStopSchema,
  [IPC.CHAT_NEW]: noPayload,
  [IPC.CHAT_LIST]: noPayload,
  [IPC.CHAT_LOAD]: idSchema,
  [IPC.CHAT_DELETE]: idSchema,
  [IPC.CHAT_GET_TITLE]: idSchema,
  [IPC.CHAT_TABS_GET_STATE]: noPayload,
  [IPC.CHAT_TABS_SET_STATE]: chatTabsSetStateSchema,
  [IPC.API_KEY_GET]: noPayload,
  [IPC.API_KEY_SET]: apiKeySetSchema,
  [IPC.HAS_COMPLETED_SETUP]: noPayload,
  [IPC.API_KEY_CLEAR]: noPayload,
  [IPC.API_KEY_VALIDATE]: apiKeyValidateSchema,
  [IPC.MODEL_GET]: noPayload,
  [IPC.MODEL_SET]: modelSetSchema,
  [IPC.SETTINGS_GET]: noPayload,
  [IPC.SETTINGS_SET]: settingsSetSchema,
  [IPC.WINDOW_MINIMIZE]: noPayload,
  [IPC.WINDOW_MAXIMIZE]: noPayload,
  [IPC.WINDOW_CLOSE]: noPayload,
  [IPC.DOCUMENT_EXTRACT]: documentExtractSchema,
  [IPC.DOCUMENT_SAVE]: documentSaveSchema,
  [IPC.DOCUMENT_OPEN_FOLDER]: documentOpenFolderSchema,
  [IPC.FILE_OPEN]: fileOpenSchema,
  [IPC.FILE_OPEN_IN_APP]: fileOpenInAppSchema,
  [IPC.CLIPBOARD_WRITE_TEXT]: clipboardWriteTextSchema,
  [IPC.LOG_LEVEL_SET]: logLevelSetSchema,
  [IPC.STORE_RESET]: noPayload,
  [IPC.BROWSER_NAVIGATE]: browserNavigateSchema,
  [IPC.BROWSER_BACK]: noPayload,
  [IPC.BROWSER_FORWARD]: noPayload,
  [IPC.BROWSER_REFRESH]: noPayload,
  [IPC.BROWSER_SET_BOUNDS]: browserSetBoundsSchema,
  [IPC.BROWSER_TAB_NEW]: browserTabNewSchema,
  [IPC.BROWSER_TAB_LIST]: noPayload,
  [IPC.BROWSER_TAB_SWITCH]: browserTabSchema,
  [IPC.BROWSER_TAB_CLOSE]: browserTabSchema,
  [IPC.BROWSER_HISTORY_GET]: noPayload,
  [IPC.BROWSER_HISTORY_CLEAR]: noPayload,
  [IPC.BROWSER_COOKIES_CLEAR]: noPayload,
  [IPC.BROWSER_CLEAR_ALL]: noPayload,
  [IPC.ACCOUNTS_LIST]: noPayload,
  [IPC.ACCOUNTS_ADD]: accountAddSchema,
  [IPC.ACCOUNTS_REMOVE]: accountRemoveSchema,
  [IPC.MEMORY_GET_ALL]: noPayload,
  [IPC.MEMORY_FORGET]: memoryForgetSchema,
  [IPC.MEMORY_RESET]: noPayload,
  [IPC.SITE_KNOWLEDGE_GET]: siteKnowledgeSchema,
  [IPC.SITE_KNOWLEDGE_RESET]: noPayload,
  [IPC.VAULT_INGEST_FILE]: vaultIngestSchema,
  [IPC.VAULT_SEARCH]: vaultSearchSchema,
  [IPC.VAULT_GET_JOB]: idSchema,
  [IPC.VAULT_GET_DOC]: idSchema,
  [IPC.ACTION_CREATE_PLAN]: actionCreatePlanSchema,
  [IPC.ACTION_ADD_ITEM]: actionAddItemSchema,
  [IPC.ACTION_EXECUTE_PLAN]: actionIdSchema,
  [IPC.ACTION_UNDO_PLAN]: actionIdSchema,
  [IPC.ACTION_GET_PLAN]: actionIdSchema,
  [IPC.ACTION_GET_ITEMS]: actionIdSchema,
  [IPC.DASHBOARD_GET]: noPayload,
  [IPC.DASHBOARD_DISMISS_RULE]: dashboardDismissRuleSchema,
  [IPC.DASHBOARD_DISMISS_ALERT]: dashboardDismissAlertSchema,
  [IPC.DASHBOARD_SET_VISIBLE]: dashboardSetVisibleSchema,
  [IPC.AMBIENT_SETTINGS_GET]: noPayload,
  [IPC.AMBIENT_SETTINGS_SET]: ambientSettingsSetSchema,
  [IPC.TASK_LIST]: noPayload,
  [IPC.TASK_GET]: taskIdSchema,
  [IPC.TASK_DELETE]: taskIdSchema,
  [IPC.TASK_PAUSE]: taskIdSchema,
  [IPC.TASK_RESUME]: taskIdSchema,
  [IPC.TASK_RUN_NOW]: taskIdSchema,
  [IPC.TASK_APPROVE_RUN]: taskRunIdSchema,
  [IPC.TASK_DISMISS_RUN]: taskRunIdSchema,
  [IPC.TASK_GET_UNREAD]: noPayload,
  [IPC.TASK_CLEAR_UNREAD]: noPayload,
  [IPC.TASK_GET_RUNS]: taskIdSchema,
  [IPC.TASK_GET_EXECUTOR]: taskIdSchema,
  [IPC.TELEGRAM_GET_CONFIG]: noPayload,
  [IPC.TELEGRAM_SET_TOKEN]: telegramSetTokenSchema,
  [IPC.TELEGRAM_SET_ENABLED]: telegramSetEnabledSchema,
  [IPC.TELEGRAM_CLEAR_AUTH]: noPayload,
  [IPC.APPROVAL_RESPONSE]: approvalResponseSchema,
  [IPC.AUTONOMY_GET]: noPayload,
  [IPC.AUTONOMY_SET]: autonomySetSchema,
  [IPC.CAPABILITY_PLATFORM_STATUS_GET]: noPayload,
  [IPC.CAPABILITY_PLATFORM_FLAGS_SET]: capabilityPlatformFlagsSetSchema,
  [IPC.AUTONOMY_GET_ALWAYS_APPROVALS]: noPayload,
  [IPC.AUTONOMY_REMOVE_ALWAYS_APPROVAL]: autonomyRemoveAlwaysApprovalSchema,
} as const;
