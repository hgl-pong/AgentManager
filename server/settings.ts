import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { AppError } from '../shared/types.ts';
import { SETTINGS_CATALOG } from './settings-catalog.ts';
import { createSnapshot, markSnapshotFailed } from './snapshot.ts';

import type {
  SettingsAgentFiles,
  SettingsField,
  SettingsFileDescriptor,
  SettingsFileState,
  SettingsReport,
  SettingsSaveRequest,
  SettingsSaveResult,
  SnapshotManifest,
} from '../shared/types.ts';

export type {
  SettingsAgentFiles,
  SettingsCatalog,
  SettingsField,
  SettingsFileDescriptor,
  SettingsFileState,
  SettingsReport,
  SettingsSaveRequest,
  SettingsSaveResult,
  SettingsScope,
} from '../shared/types.ts';

/** The registry only needs the fake-home root; every path is derived from it for testability. */
export interface SettingsRegistryConfig {
  home: string;
}

export interface SettingsSaveInput {
  files: SettingsFileDescriptor[];
  snapshotRoot: string;
  request: SettingsSaveRequest;
}

type JsonObject = Record<string, unknown>;

/** Hash used as the optimistic-lock token of a host file; absent files get a fixed sentinel. */
const MISSING_ETAG = 'missing';
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY']);
const RENAME_ATTEMPTS = 6;

/** Every user-level file this engine may read or write. Paths come from createAppConfig's home. */
export function createSettingsRegistry(config: SettingsRegistryConfig): SettingsFileDescriptor[] {
  const home = config.home;
  return [
    {
      id: 'claude-settings',
      agent: 'claude',
      label: 'Claude Code',
      path: join(home, '.claude', 'settings.json'),
      format: 'json',
      role: '设置',
      scope: 'full',
    },
    {
      id: 'claude-mcp',
      agent: 'claude',
      label: 'Claude Code',
      path: join(home, '.claude.json'),
      format: 'json',
      role: '全局 MCP',
      scope: 'mcp',
      mcpKey: 'mcpServers',
      hostPath: join(home, '.claude.json'),
    },
    {
      id: 'codex-config',
      agent: 'codex',
      label: 'Codex',
      path: join(home, '.codex', 'config.toml'),
      format: 'toml',
      role: '设置与 MCP',
      scope: 'full',
      mcpKey: 'mcp_servers',
    },
    {
      id: 'pi-settings',
      agent: 'pi',
      label: 'pi',
      path: join(home, '.pi', 'agent', 'settings.json'),
      format: 'json',
      role: '设置',
      scope: 'full',
    },
    {
      id: 'pi-mcp',
      agent: 'pi',
      label: 'pi',
      path: join(home, '.pi', 'agent', 'mcp.json'),
      format: 'json',
      role: '全局 MCP',
      scope: 'full',
      mcpKey: 'mcpServers',
    },
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

function assertObject(value: unknown, label: string): JsonObject {
  if (!isRecord(value)) throw new AppError(400, `${label}必须是一个对象`);
  return value;
}

function parseDocument(format: 'json' | 'toml', text: string): unknown {
  return format === 'toml' ? parseToml(text) : JSON.parse(text);
}

function ensureTrailingNewline(text: string): string {
  return text.endsWith('\n') ? text : `${text}\n`;
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

function serialize(format: 'json' | 'toml', value: JsonObject): string {
  return format === 'toml' ? ensureTrailingNewline(stringifyToml(value)) : serializeJson(value);
}

/**
 * TOML dates arrive as Date (TomlDate) instances, which would not survive JSON.stringify intact.
 * Every value returned to the browser or compared structurally goes through this conversion.
 */
function toJsonValue(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') return value.toString();
  if (Array.isArray(value)) return value.map((item) => toJsonValue(item));
  if (isRecord(value)) {
    const result: JsonObject = {};
    for (const [key, child] of Object.entries(value)) {
      // defineProperty keeps a data key literally named "__proto__" instead of setting a prototype.
      Object.defineProperty(result, key, {
        value: toJsonValue(child),
        enumerable: true,
        configurable: true,
        writable: true,
      });
    }
    return result;
  }
  return value;
}

interface HostFile {
  exists: boolean;
  text: string;
  etag: string;
  bytes?: number;
}

function readHostFile(path: string): HostFile {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    // Only a genuinely absent file is "missing"; every other failure must stay an I/O error.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return { exists: false, text: '', etag: MISSING_ETAG };
    }
    throw new AppError(500, `读取 ${path} 失败：${errorMessage(error)}`);
  }
  return { exists: true, text, etag: hashText(text), bytes: Buffer.byteLength(text, 'utf8') };
}

/** The MCP map a scope-mcp file exposes (or the map inside a full file's mcpKey). */
function mcpMapping(file: SettingsFileDescriptor, root: JsonObject): JsonObject {
  const key = file.mcpKey;
  if (!key) return {};
  const value = root[key];
  if (value === undefined) return {};
  if (!isRecord(value)) throw new Error(`${key} 必须是对象`);
  return value;
}

function readFileState(file: SettingsFileDescriptor): SettingsFileState {
  const host = readHostFile(file.hostPath ?? file.path);
  const state: SettingsFileState = { ...file, exists: host.exists, etag: host.etag };
  if (!host.exists) return state;

  state.bytes = host.bytes;
  try {
    const parsed = parseDocument(file.format, host.text);
    const root = assertObject(parsed, `${file.path} 的根`);
    if (file.scope === 'mcp') {
      const mapping = mcpMapping(file, root);
      state.data = toJsonValue(mapping);
      state.text = serialize(file.format, mapping);
    } else {
      state.data = toJsonValue(root);
      // Keep dates as TOML dates so canonical text can round-trip them; `data` is JSON-safe.
      state.text = serialize(file.format, root);
    }
  } catch (error) {
    state.parseError = errorMessage(error);
  }
  return state;
}

/** Reads every registered file, grouped by agent, without writing anything. */
export function readSettings(files: SettingsFileDescriptor[]): SettingsReport {
  const agents = new Map<string, SettingsAgentFiles>();
  for (const file of files) {
    const state = readFileState(file);
    const existing = agents.get(file.agent);
    if (existing) existing.files.push(state);
    else agents.set(file.agent, { key: file.agent, label: agentLabel(file.agent), files: [state] });
  }
  return { agents: [...agents.values()] };
}

function agentLabel(key: string): string {
  return SETTINGS_CATALOG.agents.find((agent) => agent.key === key)?.label ?? key;
}

// ---- validation ----

function typeFailure(path: string, expected: string): never {
  throw new AppError(400, `${path} 必须是${expected}`);
}

function validateField(value: unknown, field: SettingsField, path: string): void {
  switch (field.type) {
    case 'string':
      if (typeof value !== 'string') typeFailure(path, '字符串');
      break;
    case 'number':
      if (typeof value !== 'number' || !Number.isFinite(value)) typeFailure(path, '数字');
      break;
    case 'integer':
      if (typeof value !== 'number' || !Number.isInteger(value)) typeFailure(path, '整数');
      break;
    case 'boolean':
      if (typeof value !== 'boolean') typeFailure(path, '布尔值');
      break;
    case 'array': {
      if (!Array.isArray(value)) typeFailure(path, '数组');
      if (field.items) {
        value.forEach((item, index) => validateField(item, field.items as SettingsField, `${path}[${index}]`));
      }
      break;
    }
    case 'object': {
      if (!isRecord(value)) typeFailure(path, '对象');
      if (field.fields) validateKnownFields(value, field.fields, `${path}.`);
      if (field.map && field.mapValue) {
        const known = new Set((field.fields ?? []).map((child) => child.key));
        for (const [key, child] of Object.entries(value)) {
          if (known.has(key)) continue;
          validateField(child, field.mapValue, `${path}.${key}`);
        }
      }
      break;
    }
    case 'json':
      // A free-form field: any value that survived JSON/TOML parsing is acceptable.
      break;
  }

  if (field.enum && !field.enum.some((candidate) => candidate === value)) {
    throw new AppError(400, `${path} 必须是以下值之一：${field.enum.join(', ')}`);
  }
  if (typeof value === 'number') {
    if (field.minimum !== undefined && value < field.minimum) {
      throw new AppError(400, `${path} 不能小于 ${field.minimum}`);
    }
    if (field.maximum !== undefined && value > field.maximum) {
      throw new AppError(400, `${path} 不能大于 ${field.maximum}`);
    }
  }
}

function validateKnownFields(value: JsonObject, fields: SettingsField[], prefix: string): void {
  for (const field of fields) {
    if (!Object.hasOwn(value, field.key)) continue;
    validateField(value[field.key], field, `${prefix}${field.key}`);
  }
}

/** Validates the known top-level keys of a full settings file. Unknown keys are preserved as-is. */
function validateSettingsRoot(agentKey: string, root: JsonObject): void {
  const agent = SETTINGS_CATALOG.agents.find((candidate) => candidate.key === agentKey);
  if (!agent) return;
  for (const section of agent.sections) validateKnownFields(root, section.fields, '');
}

function validateMcpMap(map: JsonObject, mcpKey: string): void {
  for (const [name, value] of Object.entries(map)) {
    if (name.trim() === '') throw new AppError(400, `${mcpKey} 里的 server 名称不能为空`);
    if (/[\\/]/.test(name)) {
      throw new AppError(400, `${mcpKey} 里的 server 名称不能包含路径分隔符：${name}`);
    }

    const path = `${mcpKey}.${name}`;
    if (!isRecord(value)) typeFailure(path, '对象');

    const type = value.type;
    if (type !== undefined && typeof type !== 'string') typeFailure(`${path}.type`, '字符串');
    if (value.command !== undefined && typeof value.command !== 'string') {
      typeFailure(`${path}.command`, '字符串');
    }
    if (value.url !== undefined && typeof value.url !== 'string') typeFailure(`${path}.url`, '字符串');

    const transport = typeof type === 'string' ? type.toLowerCase() : undefined;
    const hasCommand = typeof value.command === 'string' && value.command.trim() !== '';
    const hasUrl = typeof value.url === 'string' && value.url.trim() !== '';
    if (transport === 'http' || transport === 'sse') {
      if (!hasUrl) throw new AppError(400, `${path} 使用 ${String(type)} 传输，必须提供 url`);
    } else if (transport === 'stdio') {
      if (!hasCommand) throw new AppError(400, `${path} 使用 stdio 传输，必须提供 command`);
    } else if (!hasCommand && !hasUrl) {
      throw new AppError(400, `${path} 必须提供 command 或 url`);
    }

    if (value.args !== undefined) {
      if (!Array.isArray(value.args) || value.args.some((argument) => typeof argument !== 'string')) {
        typeFailure(`${path}.args`, '字符串数组');
      }
    }
    for (const property of ['env', 'headers'] as const) {
      const entries = value[property];
      if (entries === undefined) continue;
      if (!isRecord(entries)) typeFailure(`${path}.${property}`, '字符串映射');
      for (const [key, entry] of Object.entries(entries)) {
        if (typeof entry !== 'string') typeFailure(`${path}.${property}.${key}`, '字符串');
      }
    }
  }
}

/** Structural equality for JSON-shaped values; object key order is irrelevant. */
function sameJson(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameJson(item, right[index]))
    );
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every((key) => Object.hasOwn(right, key) && sameJson(left[key], right[key]));
  }
  return false;
}

/** TOML has no null/undefined: refuse a serialization that would not read back identically. */
function verifyTomlRoundTrip(root: JsonObject, text: string): void {
  let reparsed: unknown;
  try {
    reparsed = parseToml(text);
  } catch (error) {
    throw new AppError(400, `TOML 序列化结果无法再次解析：${errorMessage(error)}`);
  }
  if (!sameJson(toJsonValue(reparsed), toJsonValue(root))) {
    throw new AppError(400, 'TOML 序列化结果与提交的数据不一致，可能包含 TOML 不支持的值');
  }
}

function serializeStructured(file: SettingsFileDescriptor, root: JsonObject): string {
  const text = serialize(file.format, root);
  if (file.format === 'toml') verifyTomlRoundTrip(root, text);
  return text;
}

// ---- atomic write ----

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function cleanup(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch {
    // The temp file is already gone or locked; the original error is the one that matters.
  }
}

/**
 * Writes a sibling temp file and renames it over the target, retrying the Windows cases where an
 * editor or antivirus briefly holds the destination (EPERM/EBUSY). A failed attempt cleans up.
 */
function writeAtomically(path: string, text: string): void {
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true });

  for (let attempt = 0; ; attempt += 1) {
    const temp = join(directory, `.${basename(path)}.${randomBytes(6).toString('hex')}.tmp`);
    try {
      writeFileSync(temp, text, 'utf8');
      renameSync(temp, path);
      return;
    } catch (error) {
      cleanup(temp);
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!RENAME_RETRY_CODES.has(code) || attempt >= RENAME_ATTEMPTS - 1) throw error;
      sleepSync(20 * (attempt + 1));
    }
  }
}

function hostRootForMerge(file: SettingsFileDescriptor, text: string): JsonObject {
  let parsed: unknown;
  try {
    parsed = parseDocument(file.format, text);
  } catch (error) {
    throw new AppError(400, `${file.path} 无法解析，不能合并 MCP 配置：${errorMessage(error)}`);
  }
  if (!isRecord(parsed)) throw new AppError(400, `${file.path} 的根必须是对象，不能合并 MCP 配置`);
  return parsed;
}

/**
 * Saves one registered file. Reads the host text, rejects a stale etag, validates the submitted
 * value, snapshots the host file, then replaces it atomically. Synchronous by design so the HTTP
 * layer can run it inside its existing write queue.
 */
export function saveSettings(input: SettingsSaveInput): SettingsSaveResult {
  const request = input.request;
  if (!request || typeof request !== 'object' || Array.isArray(request)) {
    throw new AppError(400, '请求体必须是 JSON 对象');
  }

  const fileId = request.fileId;
  if (typeof fileId !== 'string' || fileId === '') throw new AppError(400, '缺少 fileId');
  const file = input.files.find((candidate) => candidate.id === fileId);
  if (!file) throw new AppError(404, `未知的设置文件：${fileId}`);
  if (typeof request.etag !== 'string') throw new AppError(400, '缺少 etag');

  const hostPath = file.hostPath ?? file.path;
  const current = readHostFile(hostPath);
  if (current.etag !== request.etag) {
    throw new AppError(409, `${file.path} 已被外部修改，请重新加载后再保存`);
  }

  let suppliedText: string | undefined;
  if (request.text !== undefined) {
    if (typeof request.text !== 'string') throw new AppError(400, 'text 必须是字符串');
    suppliedText = request.text;
  }

  let provided: unknown;
  if (suppliedText !== undefined) {
    try {
      provided = parseDocument(file.format, suppliedText);
    } catch (error) {
      throw new AppError(400, `内容不是合法的 ${file.format.toUpperCase()}：${errorMessage(error)}`);
    }
  } else {
    if (!Object.hasOwn(request, 'data')) throw new AppError(400, '缺少 data 或 text');
    provided = request.data;
  }

  let nextText: string;
  if (file.scope === 'mcp') {
    const mapping = assertObject(provided, 'MCP 映射');
    validateMcpMap(mapping, file.mcpKey ?? 'mcpServers');

    // ~/.claude.json carries state (projects, history, …). Only its mcpServers key may change.
    const hostRoot = current.exists ? hostRootForMerge(file, current.text) : {};
    const nextRoot: JsonObject = { ...hostRoot };
    const key = file.mcpKey ?? 'mcpServers';
    if (Object.keys(mapping).length === 0) delete nextRoot[key];
    else nextRoot[key] = mapping;
    nextText = serialize(file.format, nextRoot);
  } else {
    const root = assertObject(provided, '配置根');
    validateSettingsRoot(file.agent, root);
    if (file.mcpKey && root[file.mcpKey] !== undefined) {
      const mapping = assertObject(root[file.mcpKey], `${file.mcpKey}`);
      validateMcpMap(mapping, file.mcpKey);
    }
    // Raw text keeps the author's formatting; structured data gets a canonical serialization.
    nextText = suppliedText === undefined ? serializeStructured(file, root) : ensureTrailingNewline(suppliedText);
  }

  let snapshot: SnapshotManifest;
  try {
    snapshot = createSnapshot(
      input.snapshotRoot,
      `settings ${file.id}`,
      [hostPath],
      current.exists ? [] : [hostPath],
    );
  } catch (error) {
    throw new AppError(500, `创建 ${file.path} 的快照失败：${errorMessage(error)}`);
  }

  try {
    writeAtomically(hostPath, nextText);
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw new AppError(500, `写入 ${file.path} 失败：${errorMessage(error)}`);
  }

  return { snapshotId: snapshot.id, file: readFileState(file) };
}
