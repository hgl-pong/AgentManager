import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import type { SettingsField, SettingsFormat } from '../../../shared/types.ts';

export type JsonObject = Record<string, unknown>;

export interface JsonEntry {
  text: string;
  error?: string;
}

export const MASK = '••••••';

const SECRET_KEY =
  /(api[_-]?key|apikey|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|token|secret|password|passwd|credential|private[_-]?key|authorization)/i;

export function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asObject(value: unknown): JsonObject {
  return isRecord(value) ? value : {};
}

export function errorText(reason: unknown): string {
  if (reason instanceof Error) return reason.message;
  return String(reason);
}

/** Deep-copies JSON-shaped data. Values from the server are always JSON. */
export function clone<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value;
  return JSON.parse(JSON.stringify(value)) as T;
}

export function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) return false;
    return left.every((value, index) => deepEqual(value, right[index]));
  }
  if (isRecord(left) || isRecord(right)) {
    if (!isRecord(left) || !isRecord(right)) return false;
    const leftKeys = Object.keys(left);
    const rightKeys = Object.keys(right);
    if (leftKeys.length !== rightKeys.length) return false;
    return leftKeys.every(
      (key) => Object.hasOwn(right, key) && deepEqual(left[key], right[key]),
    );
  }
  return false;
}

export function getAt(root: unknown, path: readonly string[]): unknown {
  let current: unknown = root;
  for (const key of path) {
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0) return undefined;
      current = current[index];
      continue;
    }
    if (!isRecord(current) || !Object.hasOwn(current, key)) return undefined;
    current = current[key];
  }
  return current;
}

export function setAt(root: JsonObject, path: readonly string[], value: unknown): void {
  if (path.length === 0) return;
  let current: JsonObject = root;
  for (let index = 0; index < path.length - 1; index += 1) {
    const key = path[index] as string;
    const next = current[key];
    if (!isRecord(next)) {
      const created: JsonObject = {};
      current[key] = created;
      current = created;
    } else {
      current = next;
    }
  }
  current[path[path.length - 1] as string] = value;
}

function deleteEmpty(container: JsonObject, path: readonly string[], index: number): boolean {
  const key = path[index] as string;
  if (!Object.hasOwn(container, key)) return false;
  if (index === path.length - 1) {
    delete container[key];
    return Object.keys(container).length === 0;
  }
  const child = container[key];
  if (!isRecord(child)) return false;
  if (deleteEmpty(child, path, index + 1)) {
    delete container[key];
    return Object.keys(container).length === 0;
  }
  return false;
}

/** Deletes a path and prunes objects that became empty, so an emptied group is "unset". */
export function deleteAt(root: JsonObject, path: readonly string[]): void {
  if (path.length === 0) return;
  deleteEmpty(root, path, 0);
}

export function pathLabel(path: readonly string[]): string {
  return path.join('.');
}

export function parsePathText(text: string): string[] | null {
  const parts = text.split('.').map((part) => part.trim());
  if (parts.length === 0 || parts.some((part) => part.length === 0)) return null;
  return parts;
}

export function isSetValue(value: unknown): boolean {
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (isRecord(value)) return Object.keys(value).length > 0;
  return true;
}

export function shortValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 44 ? `${value.slice(0, 44)}…` : value;
  }
  if (value === undefined) return '未设置';
  if (value === null) return 'null';
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch {
    text = String(value);
  }
  return text.length > 60 ? `${text.slice(0, 60)}…` : text;
}

export function typeMismatch(field: SettingsField, value: unknown): boolean {
  if (value === undefined) return false;
  switch (field.type) {
    case 'string':
      return typeof value !== 'string';
    case 'number':
      return typeof value !== 'number' || Number.isNaN(value);
    case 'integer':
      return typeof value !== 'number' || !Number.isInteger(value);
    case 'boolean':
      return typeof value !== 'boolean';
    case 'array':
      return !Array.isArray(value);
    case 'object':
      return !isRecord(value);
    default:
      return false;
  }
}

export type ParseResult = { ok: true; value: JsonObject } | { ok: false; error: string };

/** Converts TOML dates and bigints into plain JSON values before they reach React state. */
export function normalizeJson(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'bigint') {
    const number = Number(value);
    return Number.isSafeInteger(number) ? number : value.toString();
  }
  if (Array.isArray(value)) return value.map(normalizeJson);
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = normalizeJson(item);
    return out;
  }
  return value;
}

export function parseSettingsText(format: SettingsFormat, text: string): ParseResult {
  if (text.trim() === '') return { ok: true, value: {} };
  try {
    const raw: unknown = format === 'toml' ? parseToml(text) : JSON.parse(text);
    const value = normalizeJson(raw);
    if (!isRecord(value)) return { ok: false, error: '根节点必须是对象' };
    return { ok: true, value };
  } catch (error) {
    return { ok: false, error: errorText(error) };
  }
}

export function serializeSettingsText(format: SettingsFormat, value: JsonObject): string {
  const normalized = normalizeJson(value);
  if (format === 'toml') {
    const text = stringifyToml(normalized as never);
    return text.endsWith('\n') ? text : `${text}\n`;
  }
  return `${JSON.stringify(normalized, null, 2)}\n`;
}

/** Validates every catalog-covered scalar in a draft. Map keys are allowed to be free-form. */
export function collectFieldErrors(
  fields: readonly SettingsField[],
  data: JsonObject,
  base: readonly string[] = [],
): Map<string, string> {
  const errors = new Map<string, string>();
  for (const field of fields) {
    const path = [...base, field.key];
    validateField(field, getAt(data, path), path, errors);
  }
  return errors;
}

function validateField(
  field: SettingsField,
  value: unknown,
  path: readonly string[],
  errors: Map<string, string>,
): void {
  if (value !== undefined && field.type !== 'json') {
    const label = pathLabel(path);
    if (field.type === 'number' || field.type === 'integer') {
      if (typeof value !== 'number' || Number.isNaN(value)) {
        errors.set(label, '必须是数字');
      } else if (field.type === 'integer' && !Number.isInteger(value)) {
        errors.set(label, '必须是整数');
      } else {
        if (field.minimum !== undefined && value < field.minimum) {
          errors.set(label, `不能小于 ${field.minimum}`);
        }
        if (field.maximum !== undefined && value > field.maximum) {
          errors.set(label, `不能大于 ${field.maximum}`);
        }
      }
    }
    if (field.enum && !field.enum.some((entry) => entry === value)) {
      errors.set(label, `必须是 ${field.enum.map((entry) => String(entry)).join(' / ')} 之一`);
      return;
    }
    if (field.type === 'array' && !Array.isArray(value)) {
      errors.set(label, '必须是数组');
      return;
    }
    if (field.type === 'object' && !isRecord(value)) {
      errors.set(label, '必须是对象');
      return;
    }
  }
  if (field.type === 'array' && Array.isArray(value) && field.items) {
    value.forEach((item, index) => {
      validateField(field.items as SettingsField, item, [...path, `[${index}]`], errors);
    });
  }
  if (field.type === 'object' && isRecord(value)) {
    if (field.map) {
      if (field.mapValue) {
        for (const [key, item] of Object.entries(value)) {
          validateField(field.mapValue, item, [...path, key], errors);
        }
      }
      return;
    }
    if (field.fields) {
      for (const child of field.fields) {
        validateField(child, getAt(value, [child.key]), [...path, child.key], errors);
      }
    }
  }
}

export function collectSensitivePaths(
  fields: readonly SettingsField[],
  base: readonly string[] = [],
  out: Set<string> = new Set(),
): Set<string> {
  for (const field of fields) {
    const path = [...base, field.key];
    if (field.sensitive) out.add(pathLabel(path));
    if (field.fields) collectSensitivePaths(field.fields, path, out);
  }
  return out;
}

export function isSecretKey(key: string): boolean {
  return SECRET_KEY.test(key);
}

function maskEverything(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(maskEverything);
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [key, item] of Object.entries(value)) out[key] = maskEverything(item);
    return out;
  }
  return MASK;
}

export function maskValue(
  value: unknown,
  sensitivePaths: ReadonlySet<string>,
  path: readonly string[] = [],
): unknown {
  const key = path[path.length - 1] ?? '';
  const sensitive = sensitivePaths.has(pathLabel(path)) || (key !== '' && isSecretKey(key));
  if (sensitive && value !== undefined && value !== null) {
    if (typeof value === 'string' && value === '') return value;
    return typeof value === 'object' ? maskEverything(value) : MASK;
  }
  if (Array.isArray(value)) {
    return value.map((item) => maskValue(item, sensitivePaths, path));
  }
  if (isRecord(value)) {
    const out: JsonObject = {};
    for (const [childKey, item] of Object.entries(value)) {
      out[childKey] = maskValue(item, sensitivePaths, [...path, childKey]);
    }
    return out;
  }
  return value;
}

const SECRET_TEXT =
  /((?:"[^"]*(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|token|secret|password|passwd|credential|private[_-]?key|authorization)[^"]*"|'[^']*(?:api[_-]?key|apikey|auth[_-]?token|access[_-]?token|refresh[_-]?token|bearer|token|secret|password|passwd|credential|private[_-]?key|authorization)[^']*'|\b[A-Za-z0-9_]*(?:API_KEY|APIKEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|AUTHORIZATION)[A-Za-z0-9_]*)\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,}\]]+)/gi;
const SECRET_TEXT_TEST = new RegExp(SECRET_TEXT.source, 'i');

/** Masks a canonical text preview. Invalid text falls back to a conservative regex pass. */
export function maskSettingsText(
  format: SettingsFormat,
  text: string,
  sensitivePaths: ReadonlySet<string>,
): string {
  if (text.trim() === '') return text;
  const parsed = parseSettingsText(format, text);
  if (parsed.ok) {
    try {
      return serializeSettingsText(format, maskValue(parsed.value, sensitivePaths) as JsonObject);
    } catch {
      // Fall through to the regex preview.
    }
  }
  return text.replace(SECRET_TEXT, `$1"${MASK}"`);
}

export function textHasSecrets(text: string): boolean {
  return SECRET_TEXT_TEST.test(text);
}

// ---- MCP servers ----

export type McpTransport = 'stdio' | 'http' | 'sse';

export const MCP_TRANSPORT_LABEL: Record<McpTransport, string> = {
  stdio: 'stdio（本地进程）',
  http: 'http（远程）',
  sse: 'sse（远程）',
};

export function mcpTransport(server: unknown): McpTransport {
  if (isRecord(server)) {
    const type = server.type;
    if (type === 'stdio' || type === 'http' || type === 'sse') return type;
    // Codex has no `type` field (its schema rejects unknown keys); infer from the fields.
    if (typeof server.command === 'string' && server.command.trim() !== '') return 'stdio';
    if (Object.hasOwn(server, 'url')) return 'http';
  }
  return 'stdio';
}

export function mcpSummary(server: unknown): string {
  if (!isRecord(server)) return '无法识别';
  const transport = mcpTransport(server);
  if (transport === 'stdio') {
    const command = typeof server.command === 'string' ? server.command : '';
    const args = Array.isArray(server.args)
      ? server.args.filter((item): item is string => typeof item === 'string')
      : [];
    return [command, ...args].filter(Boolean).join(' ') || '尚未填写 command';
  }
  return typeof server.url === 'string' && server.url.trim() !== '' ? server.url : '尚未填写 url';
}

export function mcpTransportLabel(server: unknown): string {
  return mcpTransport(server);
}

/** Codex rejects unknown keys, so its transport is carried by command/url rather than `type`. */
export function newMcpServer(agentKey: string, transport: McpTransport): JsonObject {
  if (agentKey === 'codex') return transport === 'stdio' ? { command: '' } : { url: '' };
  return { type: transport };
}

export function validateMcpServers(map: JsonObject): Map<string, string> {
  const errors = new Map<string, string>();
  for (const [name, server] of Object.entries(map)) {
    if (name.trim() === '' || name.includes('/') || name.includes('\\')) {
      errors.set(name, '名称不能为空，也不能包含 / 或 \\');
      continue;
    }
    if (!isRecord(server)) {
      errors.set(name, '定义必须是对象');
      continue;
    }
    const transport = mcpTransport(server);
    if (transport === 'stdio') {
      if (typeof server.command !== 'string' || server.command.trim() === '') {
        errors.set(name, 'stdio server 必须填写 command');
        continue;
      }
    } else if (typeof server.url !== 'string' || server.url.trim() === '') {
      errors.set(name, `${transport} server 必须填写 url`);
      continue;
    }
    if (server.args !== undefined) {
      if (
        !Array.isArray(server.args) ||
        server.args.some((item) => typeof item !== 'string')
      ) {
        errors.set(name, 'args 必须是字符串数组');
        continue;
      }
    }
    for (const key of ['env', 'headers', 'http_headers', 'env_http_headers']) {
      const value = server[key];
      if (value === undefined) continue;
      if (!isRecord(value) || Object.values(value).some((item) => typeof item !== 'string')) {
        errors.set(name, `${key} 必须是字符串键值映射`);
        break;
      }
    }
    if (errors.has(name)) continue;
    if (server.enabled !== undefined && typeof server.enabled !== 'boolean') {
      errors.set(name, 'enabled 必须是布尔值');
      continue;
    }
    if (
      server.bearer_token_env_var !== undefined &&
      typeof server.bearer_token_env_var !== 'string'
    ) {
      errors.set(name, 'bearer_token_env_var 必须是字符串');
    }
  }
  return errors;
}
