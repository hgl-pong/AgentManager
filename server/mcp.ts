import { readFileSync } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import { AppError } from '../shared/types.ts';
import { readSettings, saveSettings, writeAtomically } from './settings.ts';
import { createSnapshot, markSnapshotFailed } from './snapshot.ts';

import type {
  McpActionRequest,
  McpActionResponse,
  McpAgentInfo,
  McpMatrixCell,
  McpMatrixReport,
  McpMatrixRow,
  McpServerDefinition,
  McpTransport,
  SettingsFileDescriptor,
  SettingsFileState,
  SnapshotManifest,
} from '../shared/types.ts';

export interface McpInput {
  /** <home>/.agents/mcp/servers.json */
  sourcePath: string;
  snapshotRoot: string;
  /** The settings registry; the MCP-bearing files are picked from it by id. */
  settingsFiles: SettingsFileDescriptor[];
}

type JsonObject = Record<string, unknown>;

/** How each agent stores its MCP map. Order is also the importAll fallback order. */
interface McpAgentSpec {
  key: string;
  fileId: string;
  /** Codex: no `type`, headers live in `http_headers`. */
  codexStyle: boolean;
  supportsSse: boolean;
}

const MCP_AGENTS: McpAgentSpec[] = [
  { key: 'claude', fileId: 'claude-mcp', codexStyle: false, supportsSse: true },
  { key: 'codex', fileId: 'codex-config', codexStyle: true, supportsSse: false },
  { key: 'pi', fileId: 'pi-mcp', codexStyle: false, supportsSse: false },
];

const TRANSPORTS: McpTransport[] = ['stdio', 'http', 'sse'];
const STDIO_KEYS = ['command', 'args', 'env', 'cwd'] as const;
const REMOTE_KEYS = ['url', 'headers'] as const;
/** Every key the merge treats as core; anything else in an agent entry is preserved. */
const CORE_KEYS = new Set(['type', 'command', 'args', 'env', 'cwd', 'url', 'headers', 'http_headers']);

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date);
}

// ---- definition validation and normalization ----

export function validateServerName(name: unknown): string {
  if (typeof name !== 'string' || name.trim() === '') throw new AppError(400, 'server 名称不能为空');
  if (name.length > 100) throw new AppError(400, `server 名称不能超过 100 个字符：${name.slice(0, 20)}…`);
  if (/[\\/]/.test(name)) throw new AppError(400, `server 名称不能包含 / 或 \\：${name}`);
  return name;
}

function stringMap(value: unknown, label: string): Record<string, string> | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) throw new AppError(400, `${label} 必须是字符串映射`);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') throw new AppError(400, `${label}.${key} 必须是字符串`);
    result[key] = entry;
  }
  return Object.keys(result).length === 0 ? undefined : result;
}

function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string') throw new AppError(400, `${label} 必须是字符串`);
  return value;
}

/**
 * Validates an agent-neutral definition and returns its canonical form: only the fields that
 * apply to the transport, with empty arrays/maps/strings dropped. Throws AppError(400).
 */
export function normalizeDefinition(value: unknown, label = 'server'): McpServerDefinition {
  if (!isRecord(value)) throw new AppError(400, `${label} 必须是对象`);
  const transport = value.transport;
  if (typeof transport !== 'string' || !TRANSPORTS.includes(transport as McpTransport)) {
    throw new AppError(400, `${label}.transport 必须是 stdio、http 或 sse`);
  }
  return canonical({
    transport: transport as McpTransport,
    command: value.command,
    args: value.args,
    env: value.env,
    cwd: value.cwd,
    url: value.url,
    headers: value.headers,
  }, label);
}

function canonical(raw: { transport: McpTransport } & Record<string, unknown>, label: string): McpServerDefinition {
  const command = optionalString(raw.command, `${label}.command`);
  if (raw.args !== undefined) {
    if (!Array.isArray(raw.args) || raw.args.some((argument) => typeof argument !== 'string')) {
      throw new AppError(400, `${label}.args 必须是字符串数组`);
    }
  }
  const args = raw.args as string[] | undefined;
  const env = stringMap(raw.env, `${label}.env`);
  const cwd = optionalString(raw.cwd, `${label}.cwd`);
  const url = optionalString(raw.url, `${label}.url`);
  const headers = stringMap(raw.headers, `${label}.headers`);

  const result: McpServerDefinition = { transport: raw.transport };
  if (raw.transport === 'stdio') {
    if (!command || command.trim() === '') throw new AppError(400, `${label} 使用 stdio 传输，必须提供 command`);
    result.command = command;
    if (args && args.length > 0) result.args = [...args];
    if (env) result.env = env;
    if (cwd) result.cwd = cwd;
  } else {
    if (!url || url.trim() === '') throw new AppError(400, `${label} 使用 ${raw.transport} 传输，必须提供 url`);
    result.url = url;
    if (headers) result.headers = headers;
  }
  return result;
}

/** Infers the transport of an agent entry: explicit type wins, otherwise url ⇒ http, else stdio. */
function inferTransport(entry: JsonObject, label: string): McpTransport {
  const type = entry.type;
  if (type === undefined) return typeof entry.url === 'string' && entry.url !== '' ? 'http' : 'stdio';
  if (typeof type !== 'string') throw new AppError(400, `${label}.type 必须是字符串`);
  const lowered = type.toLowerCase();
  if (lowered === 'streamable-http' || lowered === 'http') return 'http';
  if (lowered === 'sse' || lowered === 'stdio') return lowered;
  throw new AppError(400, `${label}.type 不受支持：${type}`);
}

/** Reads an agent-specific entry into the neutral shape. Agent-only fields are ignored. */
export function normalizeAgentEntry(entry: unknown, codexStyle: boolean, label = 'entry'): McpServerDefinition {
  if (!isRecord(entry)) throw new AppError(400, `${label} 不是对象`);
  const transport = inferTransport(entry, label);
  let headers = entry.headers;
  if (codexStyle && entry.http_headers !== undefined) {
    // Codex documents http_headers; a plain headers map is accepted and http_headers wins per key.
    headers = isRecord(entry.headers) && isRecord(entry.http_headers)
      ? { ...entry.headers, ...entry.http_headers }
      : entry.http_headers;
  }
  return canonical({ ...entry, transport, headers }, label);
}

function sameMap(left?: Record<string, string>, right?: Record<string, string>): boolean {
  const leftKeys = Object.keys(left ?? {});
  if (leftKeys.length !== Object.keys(right ?? {}).length) return false;
  return leftKeys.every((key) => Object.hasOwn(right ?? {}, key) && left?.[key] === right?.[key]);
}

export function sameDefinition(left: McpServerDefinition, right: McpServerDefinition): boolean {
  const leftArgs = left.args ?? [];
  const rightArgs = right.args ?? [];
  return (
    left.transport === right.transport &&
    left.command === right.command &&
    left.cwd === right.cwd &&
    left.url === right.url &&
    leftArgs.length === rightArgs.length &&
    leftArgs.every((argument, index) => argument === rightArgs[index]) &&
    sameMap(left.env, right.env) &&
    sameMap(left.headers, right.headers)
  );
}

/**
 * Writes a neutral definition into an agent entry, keeping unknown fields (and key order) of the
 * existing entry. Core keys that no longer apply — including after a transport switch — are dropped.
 */
export function mergeAgentEntry(existing: unknown, definition: McpServerDefinition, codexStyle: boolean): JsonObject {
  const next: JsonObject = {
    ...(codexStyle ? {} : { type: definition.transport }),
    command: definition.command,
    args: definition.args,
    env: definition.env,
    cwd: definition.cwd,
    url: definition.url,
    [codexStyle ? 'http_headers' : 'headers']: definition.headers,
  };
  const result: JsonObject = {};
  const put = (key: string, value: unknown) => {
    if (value === undefined) return;
    Object.defineProperty(result, key, { value, enumerable: true, configurable: true, writable: true });
  };
  if (isRecord(existing)) {
    for (const [key, value] of Object.entries(existing)) put(key, CORE_KEYS.has(key) ? next[key] : value);
  }
  for (const [key, value] of Object.entries(next)) if (!Object.hasOwn(result, key)) put(key, value);
  return result;
}

// ---- display summary (mirrors server/config.ts; display only, never compared) ----

const SECRET_FLAG = /^--?(?:api[-_]?key|token|secret|password|auth|access[-_]?token|bearer)$/i;
const TOKEN_PREFIX = /^(?:sk|pk|rk|ghp|gho|ghu|ghs|github_pat|glpat|xox[baprs]|AKIA)[-_A-Za-z0-9]{6,}$/;
const MASK = '••••••';

function looksLikeToken(value: string): boolean {
  if (TOKEN_PREFIX.test(value)) return true;
  return value.length >= 24 && /^[A-Za-z0-9_.=+-]+$/.test(value) && /[0-9]/.test(value) && /[A-Za-z]/.test(value);
}

function summarizeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    return parsed.toString();
  } catch {
    return url.replace(/\/\/[^/@\s]*@/, '//');
  }
}

function summarizeArguments(args: string[]): string[] {
  const masked: string[] = [];
  let redactNext = false;
  for (const argument of args) {
    if (redactNext) {
      masked.push(MASK);
      redactNext = false;
      continue;
    }
    const separator = argument.indexOf('=');
    if (argument.startsWith('-') && separator > 0 && SECRET_FLAG.test(argument.slice(0, separator))) {
      masked.push(`${argument.slice(0, separator)}=${MASK}`);
      continue;
    }
    if (SECRET_FLAG.test(argument)) {
      masked.push(argument);
      redactNext = true;
      continue;
    }
    masked.push(looksLikeToken(argument) ? MASK : argument);
  }
  return masked;
}

export function summarizeDefinition(definition: McpServerDefinition): string {
  if (definition.transport !== 'stdio') return summarizeUrl(definition.url ?? '');
  return [definition.command ?? '', ...summarizeArguments(definition.args ?? [])].filter(Boolean).join(' ');
}

/** Best effort for entries that fail normalization. */
function summarizeRaw(entry: unknown): string | undefined {
  if (!isRecord(entry)) return undefined;
  if (typeof entry.url === 'string') return summarizeUrl(entry.url);
  if (typeof entry.command !== 'string') return undefined;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  return [entry.command, ...summarizeArguments(args)].filter(Boolean).join(' ');
}

// ---- source file ----

interface SourceState {
  exists: boolean;
  bytes?: number;
  error?: string;
  /** Root object, other keys preserved on write. */
  root: JsonObject;
  /** Raw entries; individual entries may be invalid. */
  servers: JsonObject;
}

function readSource(path: string): SourceState {
  let text: string;
  try {
    text = readFileSync(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, root: {}, servers: {} };
    return { exists: false, error: `读取失败：${errorMessage(error)}`, root: {}, servers: {} };
  }
  const bytes = Buffer.byteLength(text, 'utf8');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    return { exists: true, bytes, error: `JSON 无法解析：${errorMessage(error)}`, root: {}, servers: {} };
  }
  if (!isRecord(parsed)) return { exists: true, bytes, error: '根必须是对象', root: {}, servers: {} };
  const servers = parsed.servers ?? {};
  if (!isRecord(servers)) return { exists: true, bytes, error: 'servers 必须是对象', root: parsed, servers: {} };
  return { exists: true, bytes, root: parsed, servers };
}

function writableSource(path: string): SourceState {
  const source = readSource(path);
  if (source.error) throw new AppError(400, `MCP 源文件 ${path} 无效，请先修复：${source.error}`);
  return source;
}

/** Snapshots then atomically replaces the source file. Returns the snapshot id. */
function writeSource(input: McpInput, source: SourceState, servers: JsonObject): string {
  const root: JsonObject = { ...source.root, version: source.root.version ?? 1, servers };
  let snapshot: SnapshotManifest;
  try {
    snapshot = createSnapshot(input.snapshotRoot, 'mcp source', [input.sourcePath], source.exists ? [] : [input.sourcePath]);
  } catch (error) {
    throw new AppError(500, `创建 MCP 源快照失败：${errorMessage(error)}`);
  }
  try {
    writeAtomically(input.sourcePath, `${JSON.stringify(root, null, 2)}\n`);
  } catch (error) {
    markSnapshotFailed(input.snapshotRoot, snapshot.id);
    throw new AppError(500, `写入 ${input.sourcePath} 失败：${errorMessage(error)}`);
  }
  return snapshot.id;
}

// ---- agent files ----

interface AgentState {
  spec: McpAgentSpec;
  file: SettingsFileState;
  /** Raw JSON-safe map, or undefined with `error` when the file cannot be read as an MCP map. */
  map?: JsonObject;
  error?: string;
}

function agentDescriptors(input: McpInput): Array<{ spec: McpAgentSpec; descriptor: SettingsFileDescriptor }> {
  return MCP_AGENTS.map((spec) => {
    const descriptor = input.settingsFiles.find((file) => file.id === spec.fileId);
    if (!descriptor) throw new AppError(500, `设置注册表缺少 ${spec.fileId}`);
    return { spec, descriptor };
  });
}

function readAgents(input: McpInput): AgentState[] {
  const pairs = agentDescriptors(input);
  const files = readSettings(pairs.map((pair) => pair.descriptor)).agents.flatMap((agent) => agent.files);
  return pairs.map(({ spec }) => {
    const file = files.find((candidate) => candidate.id === spec.fileId) as SettingsFileState;
    if (file.parseError) return { spec, file, error: `${file.path} 无法解析：${file.parseError}` };
    if (!file.exists) return { spec, file, map: {} };
    if (file.scope === 'mcp') return { spec, file, map: (file.data ?? {}) as JsonObject };
    const value = (file.data as JsonObject | undefined)?.[file.mcpKey ?? 'mcpServers'];
    if (value === undefined) return { spec, file, map: {} };
    if (!isRecord(value)) return { spec, file, error: `${file.path} 的 ${file.mcpKey} 必须是对象` };
    return { spec, file, map: value };
  });
}

function agentInfo(state: AgentState): McpAgentInfo {
  return { key: state.spec.key, label: state.file.label, file: state.file.path, format: state.file.format };
}

function writableMap(agent: AgentState): JsonObject {
  if (agent.error || !agent.map) throw new AppError(400, agent.error ?? `${agent.file.path} 不可写`);
  return agent.map;
}

/**
 * Saves a new MCP map through saveSettings (etag, validation, snapshot, atomic write).
 * TOML goes through `text` so the rest of config.toml keeps its native values (dates).
 */
function saveAgentMap(input: McpInput, agent: AgentState, map: JsonObject): string {
  const file = agent.file;
  const key = file.mcpKey ?? 'mcpServers';
  const empty = Object.keys(map).length === 0;
  let body: { data?: unknown; text?: string };
  if (file.scope === 'mcp') {
    body = { data: map };
  } else if (file.format === 'toml') {
    const root = (file.exists ? parseToml(file.text ?? '') : {}) as JsonObject;
    if (empty) delete root[key];
    else root[key] = map;
    body = { text: stringifyToml(root) };
  } else {
    const root: JsonObject = { ...((file.data as JsonObject | undefined) ?? {}) };
    if (empty) delete root[key];
    else root[key] = map;
    body = { data: root };
  }
  const result = saveSettings({
    files: input.settingsFiles,
    snapshotRoot: input.snapshotRoot,
    request: { fileId: file.id, etag: file.etag, ...body },
  });
  return result.snapshotId;
}

function agentByKey(agents: AgentState[], key: unknown): AgentState {
  const found = agents.find((agent) => agent.spec.key === key);
  if (!found) throw new AppError(400, `未知的 agent：${String(key)}`);
  return found;
}

// ---- report ----

function cellFor(agent: AgentState, source: McpServerDefinition, name: string): McpMatrixCell {
  if (agent.error) return { state: 'invalid', error: agent.error };
  const entry = agent.map?.[name];
  if (source.transport === 'sse' && !agent.spec.supportsSse) {
    const cell: McpMatrixCell = { state: 'unsupported', error: `${agent.file.label} 不支持 sse 传输` };
    const summary = entry === undefined ? undefined : summarizeRaw(entry);
    if (summary) cell.summary = summary;
    return cell;
  }
  if (entry === undefined) return { state: 'missing' };
  try {
    const definition = normalizeAgentEntry(entry, agent.spec.codexStyle, name);
    return { state: sameDefinition(definition, source) ? 'synced' : 'drift', summary: summarizeDefinition(definition) };
  } catch (error) {
    const cell: McpMatrixCell = { state: 'invalid', error: errorMessage(error) };
    const summary = summarizeRaw(entry);
    if (summary) cell.summary = summary;
    return cell;
  }
}

function orphanCell(agent: AgentState, entry: unknown, name: string): McpMatrixCell {
  try {
    return { state: 'orphan', summary: summarizeDefinition(normalizeAgentEntry(entry, agent.spec.codexStyle, name)) };
  } catch (error) {
    const cell: McpMatrixCell = { state: 'orphan', error: errorMessage(error) };
    const summary = summarizeRaw(entry);
    if (summary) cell.summary = summary;
    return cell;
  }
}

/** Live matrix of the source against every agent. Reads only; never cached. */
export function buildMcpReport(input: McpInput): McpMatrixReport {
  const source = readSource(input.sourcePath);
  const agents = readAgents(input);
  const rows: McpMatrixRow[] = [];

  for (const [name, raw] of Object.entries(source.servers)) {
    const row: McpMatrixRow = { name, inSource: true, cells: {} };
    let definition: McpServerDefinition | undefined;
    let problem: string | undefined;
    try {
      validateServerName(name);
      definition = normalizeDefinition(raw, name);
      row.source = definition;
    } catch (error) {
      problem = `源定义无效：${errorMessage(error)}`;
    }
    for (const agent of agents) {
      row.cells[agent.spec.key] = definition ? cellFor(agent, definition, name) : { state: 'invalid', error: problem };
    }
    rows.push(row);
  }

  const orphans = new Map<string, McpMatrixRow>();
  for (const agent of agents) {
    for (const [name, entry] of Object.entries(agent.map ?? {})) {
      if (Object.hasOwn(source.servers, name)) continue;
      const row = orphans.get(name) ?? { name, inSource: false, cells: {} };
      row.cells[agent.spec.key] = orphanCell(agent, entry, name);
      orphans.set(name, row);
    }
  }
  rows.push(...orphans.values());
  rows.sort((left, right) => Number(right.inSource) - Number(left.inSource) || left.name.localeCompare(right.name));

  return {
    source: {
      path: input.sourcePath,
      exists: source.exists,
      ...(source.bytes !== undefined ? { bytes: source.bytes } : {}),
      ...(source.error ? { error: source.error } : {}),
      serverCount: Object.keys(source.servers).length,
    },
    agents: agents.map(agentInfo),
    rows,
    scannedAt: new Date().toISOString(),
  };
}

// ---- actions ----

interface ActionResult {
  message: string;
  snapshotIds: string[];
  warnings: string[];
}

function sourceDefinition(source: SourceState, name: string): McpServerDefinition {
  if (!Object.hasOwn(source.servers, name)) throw new AppError(404, `MCP 源里没有 ${name}`);
  return normalizeDefinition(source.servers[name], name);
}

/** Writes the given source servers into each agent, saving each changed file once. */
function syncServers(
  input: McpInput,
  agents: AgentState[],
  servers: Array<[string, McpServerDefinition]>,
  result: ActionResult,
): number {
  let written = 0;
  for (const agent of agents) {
    const current = writableMap(agent);
    const next: JsonObject = { ...current };
    let changed = false;
    for (const [name, definition] of servers) {
      if (definition.transport === 'sse' && !agent.spec.supportsSse) {
        result.warnings.push(`${name}：${agent.file.label} 不支持 sse 传输，已跳过`);
        continue;
      }
      const existing = current[name];
      if (existing !== undefined) {
        try {
          if (sameDefinition(normalizeAgentEntry(existing, agent.spec.codexStyle, name), definition)) continue;
        } catch {
          // An invalid entry is simply replaced.
        }
      }
      next[name] = mergeAgentEntry(existing, definition, agent.spec.codexStyle);
      changed = true;
    }
    if (!changed) continue;
    result.snapshotIds.push(saveAgentMap(input, agent, next));
    written += 1;
  }
  return written;
}

function targetAgents(agents: AgentState[], keys: unknown): AgentState[] {
  if (keys === undefined) return agents;
  if (!Array.isArray(keys)) throw new AppError(400, 'agents 必须是数组');
  return [...new Set(keys)].map((key) => agentByKey(agents, key));
}

function runImport(input: McpInput, request: McpActionRequest, result: ActionResult): void {
  const name = validateServerName(request.name);
  const source = writableSource(input.sourcePath);
  const agent = agentByKey(readAgents(input), request.agent);
  const map = writableMap(agent);
  if (!Object.hasOwn(map, name)) throw new AppError(404, `${agent.file.label} 里没有 ${name}`);
  const definition = normalizeAgentEntry(map[name], agent.spec.codexStyle, name);
  result.snapshotIds.push(writeSource(input, source, { ...source.servers, [name]: definition }));
  result.message = `已从 ${agent.file.label} 导入 ${name} 到 MCP 源`;
}

function runImportAll(input: McpInput, request: McpActionRequest, result: ActionResult): void {
  const source = writableSource(input.sourcePath);
  const agents = readAgents(input);
  const prefer = request.prefer ?? 'claude';
  const preferred = agentByKey(agents, prefer);
  const order = [preferred, ...agents.filter((agent) => agent !== preferred)];

  const names = new Set<string>();
  for (const agent of agents) {
    if (agent.error) result.warnings.push(`${agent.file.label}：${agent.error}`);
    for (const name of Object.keys(agent.map ?? {})) names.add(name);
  }

  const servers: JsonObject = { ...source.servers };
  const imported: string[] = [];
  for (const name of [...names].sort((left, right) => left.localeCompare(right))) {
    if (Object.hasOwn(servers, name)) continue;
    try {
      validateServerName(name);
    } catch (error) {
      result.warnings.push(`${name}：${errorMessage(error)}，已跳过`);
      continue;
    }
    const candidates: Array<{ agent: AgentState; definition: McpServerDefinition }> = [];
    for (const agent of order) {
      const entry = agent.map?.[name];
      if (entry === undefined) continue;
      try {
        candidates.push({ agent, definition: normalizeAgentEntry(entry, agent.spec.codexStyle, name) });
      } catch {
        // Invalid entries never win; the next agent's definition is used.
      }
    }
    const chosen = candidates[0];
    if (!chosen) {
      result.warnings.push(`${name}：没有可导入的有效定义，已跳过`);
      continue;
    }
    if (candidates.some((candidate) => !sameDefinition(candidate.definition, chosen.definition))) {
      result.warnings.push(`${name}：以 ${chosen.agent.file.label} 为准`);
    }
    servers[name] = chosen.definition;
    imported.push(name);
  }

  if (imported.length === 0) {
    result.message = '没有需要导入的 MCP server';
    return;
  }
  result.snapshotIds.push(writeSource(input, source, servers));
  result.message = `已导入 ${imported.length} 个 MCP server：${imported.join(', ')}`;
}

function runSaveSource(input: McpInput, request: McpActionRequest, result: ActionResult): void {
  const name = validateServerName(request.name);
  const definition = normalizeDefinition(request.server, name);
  const source = writableSource(input.sourcePath);
  const agents = readAgents(input);
  const targets = request.agents === undefined ? [] : targetAgents(agents, request.agents);
  result.snapshotIds.push(writeSource(input, source, { ...source.servers, [name]: definition }));
  const written = syncServers(input, targets, [[name, definition]], result);
  result.message = targets.length > 0
    ? `已保存 ${name} 并同步到 ${written} 个 agent 文件`
    : `已保存 ${name} 到 MCP 源`;
}

function runDeleteSource(input: McpInput, request: McpActionRequest, result: ActionResult): void {
  const name = validateServerName(request.name);
  const source = writableSource(input.sourcePath);
  if (!Object.hasOwn(source.servers, name)) throw new AppError(404, `MCP 源里没有 ${name}`);
  const servers = { ...source.servers };
  delete servers[name];
  result.snapshotIds.push(writeSource(input, source, servers));
  result.message = `已从 MCP 源删除 ${name}；agent 配置未改动`;
}

function runSync(input: McpInput, request: McpActionRequest, result: ActionResult): void {
  const source = writableSource(input.sourcePath);
  const agents = readAgents(input);
  const targets = targetAgents(agents, request.agents ?? (request.agent === undefined ? undefined : [request.agent]));
  const servers: Array<[string, McpServerDefinition]> = [];
  if (request.name !== undefined) {
    const name = validateServerName(request.name);
    servers.push([name, sourceDefinition(source, name)]);
  } else {
    for (const name of Object.keys(source.servers)) {
      try {
        servers.push([name, normalizeDefinition(source.servers[name], name)]);
      } catch (error) {
        result.warnings.push(`${name}：源定义无效，已跳过（${errorMessage(error)}）`);
      }
    }
  }
  const written = syncServers(input, targets, servers, result);
  result.message = written === 0 ? '所有目标已是最新，未写入文件' : `已同步到 ${written} 个 agent 文件`;
}

function runRemove(input: McpInput, request: McpActionRequest, result: ActionResult): void {
  const name = validateServerName(request.name);
  writableSource(input.sourcePath);
  const agent = agentByKey(readAgents(input), request.agent);
  const map = writableMap(agent);
  if (!Object.hasOwn(map, name)) throw new AppError(404, `${agent.file.label} 里没有 ${name}`);
  const next = { ...map };
  delete next[name];
  result.snapshotIds.push(saveAgentMap(input, agent, next));
  result.message = `已从 ${agent.file.label} 删除 ${name}`;
}

const ACTIONS = {
  import: runImport,
  importAll: runImportAll,
  saveSource: runSaveSource,
  deleteSource: runDeleteSource,
  sync: runSync,
  remove: runRemove,
} as const;

/** Runs one MCP action synchronously (the HTTP layer wraps it in its write queue). */
export function runMcpAction(input: McpInput, request: McpActionRequest): McpActionResponse {
  if (!isRecord(request)) throw new AppError(400, '请求体必须是 JSON 对象');
  const kind = request.action;
  if (typeof kind !== 'string' || !Object.hasOwn(ACTIONS, kind)) {
    throw new AppError(400, `未知的 MCP 动作：${String(kind)}`);
  }
  const result: ActionResult = { message: '', snapshotIds: [], warnings: [] };
  ACTIONS[kind as keyof typeof ACTIONS](input, request, result);
  return { ...result, report: buildMcpReport(input) };
}
