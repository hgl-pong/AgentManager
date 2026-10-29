import { existsSync, readFileSync } from 'node:fs';
import { isDeepStrictEqual } from 'node:util';
import { AppError } from '../shared/types.ts';
import type { HookActionRequest, HookActionResponse, HookMatrixReport, HookMatrixCell, SettingsFileDescriptor } from '../shared/types.ts';
import { readSettings, saveSettings, writeAtomically } from './settings.ts';
import { createSnapshot, markSnapshotFailed } from './snapshot.ts';

export interface HooksInput {
  sourcePath: string;
  codexHooks: string;
  snapshotRoot: string;
  settingsFiles: SettingsFileDescriptor[];
}

type ObjectValue = Record<string, unknown>;
type Definitions = Record<string, unknown[]>;
type Source = Record<string, Definitions>;
type Agent = 'claude' | 'codex';
const AGENTS: Agent[] = ['claude', 'codex'];
const CLAUDE_EVENTS = new Set('SessionStart Setup UserPromptSubmit UserPromptExpansion PreToolUse PermissionRequest PermissionDenied PostToolUse PostToolUseFailure PostToolBatch Notification MessageDisplay SubagentStart SubagentStop TaskCreated TaskCompleted Stop StopFailure TeammateIdle InstructionsLoaded ConfigChange CwdChanged DirectoryAdded FileChanged WorktreeCreate WorktreeRemove PreCompact PostCompact PreModelSwitch PostModelSwitch Elicitation ElicitationResult SessionEnd'.split(' '));
const CODEX_EVENTS = new Set('SessionStart SessionEnd SubagentStart SubagentStop PreToolUse PermissionRequest PostToolUse PreCompact PostCompact UserPromptSubmit Stop Interrupt PreModelRequest PostModelRequest'.split(' '));
const EVENTS = [...new Set([...CLAUDE_EVENTS, ...CODEX_EVENTS])].sort();
const TRUST_WARNING = 'Codex 需要 /hooks 重新信任修改后的 hook 才会执行';

function object(value: unknown): value is ObjectValue {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function fail(message: string): never { throw new AppError(400, message); }
function eventName(value: unknown): string {
  if (typeof value !== 'string' || !EVENTS.includes(value)) fail(`未知的 hook event：${String(value)}`);
  return value;
}
function agentName(value: unknown): Agent {
  if (value !== 'claude' && value !== 'codex') fail(`不支持的 hooks agent：${String(value)}`);
  return value;
}
function supports(agent: Agent, event: string): boolean {
  return (agent === 'claude' ? CLAUDE_EVENTS : CODEX_EVENTS).has(event);
}
function validateDefinitions(value: unknown): asserts value is Definitions {
  if (!object(value)) fail('definitions 必须是对象');
  for (const [key, groups] of Object.entries(value)) {
    const agent = agentName(key);
    if (!Array.isArray(groups)) fail(`${agent} 必须是数组`);
    for (const group of groups) {
      if (!object(group)) fail('matcher 组必须是对象');
      if (group.matcher !== undefined && typeof group.matcher !== 'string') fail('matcher 必须是字符串');
      if (!Array.isArray(group.hooks)) fail('hooks 必须是数组');
      for (const handler of group.hooks) {
        if (!object(handler) || typeof handler.type !== 'string') fail('handler 必须是对象且 type 必须是字符串');
        const allowed = agent === 'claude' ? ['command', 'http', 'mcp_tool', 'prompt', 'agent'] : ['command', 'mcp_tool', 'prompt', 'agent'];
        if (!allowed.includes(handler.type)) fail(`${agent} 不支持 handler type ${handler.type}`);
        const required = handler.type === 'command' ? ['command'] : handler.type === 'http' ? ['url'] : handler.type === 'mcp_tool' ? ['server', 'tool'] : [];
        for (const field of required) {
          if (typeof handler[field] !== 'string' || !(handler[field] as string).trim()) fail(`${handler.type} 必须提供非空 ${field}`);
        }
      }
    }
  }
}

function readJson(path: string): { exists: boolean; bytes?: number; data: ObjectValue; error?: string } {
  let text: string;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { exists: false, data: {} };
    return { exists: true, data: {}, error: String(error) };
  }
  try {
    const data: unknown = JSON.parse(text);
    if (!object(data)) fail('JSON 根必须是对象');
    return { exists: true, bytes: Buffer.byteLength(text), data };
  } catch (error) { return { exists: true, bytes: Buffer.byteLength(text), data: {}, error: String(error) }; }
}
function readSource(input: HooksInput) {
  const file = readJson(input.sourcePath);
  let hooks: Source = {};
  if (!file.error && file.exists) {
    try {
      if (file.data.version !== 1 || !object(file.data.hooks)) fail('hooks source 必须包含 version: 1 与 hooks 对象');
      for (const [event, definitions] of Object.entries(file.data.hooks)) {
        eventName(event);
        validateDefinitions(definitions);
      }
      hooks = file.data.hooks as Source;
    } catch (error) { file.error = String(error); }
  }
  return { ...file, hooks };
}
function readAgents(input: HooksInput) {
  const settings = readSettings(input.settingsFiles);
  const claude = settings.agents.flatMap((agent) => agent.files).find((file) => file.id === 'claude-settings');
  if (!claude) fail('缺少 claude-settings 注册项');
  const codex = readJson(input.codexHooks);
  const roots = { claude: object(claude.data) ? claude.data : {}, codex: codex.data };
  const errors: Partial<Record<Agent, string>> = { claude: claude.parseError, codex: codex.error };
  const hooks: Record<Agent, ObjectValue> = { claude: {}, codex: {} };
  for (const agent of AGENTS) {
    const value = roots[agent].hooks;
    if (value !== undefined && !object(value)) errors[agent] = 'hooks 必须是对象';
    else hooks[agent] = value as ObjectValue ?? {};
  }
  const config = settings.agents.flatMap((agent) => agent.files).find((file) => file.id === 'codex-config');
  const features = object(config?.data) ? config.data.features : undefined;
  const warnings = object(features) && features.hooks === false ? ['Codex [features].hooks = false，hooks 被禁用'] : [];
  return { claude, roots, hooks, errors, warnings };
}
function summary(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const handlers = value.flatMap((group) => object(group) && Array.isArray(group.hooks) ? group.hooks : []);
  const details = handlers.map((handler: unknown) => {
    if (!object(handler)) return '?';
    // Only display handler type and a redacted command, never URLs, headers or payloads.
    const command = typeof handler.command === 'string' ? handler.command
      .replace(/((?:[\w-]*(?:token|secret|password|api[_-]?key)[\w-]*)[=\s]+)(?:"[^"]*"|'[^']*'|[^\s]+)/gi, '$1***')
      .replace(/\b(?:sk-|ghp_|github_pat_)[A-Za-z0-9_-]+/g, '***')
      .replace(/(\bBearer\s+)[^\s"']+/gi, '$1***')
      .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, '$1***@')
      .replace(/([?&](?:access_token|token|api_key|key|secret|password)=)[^&\s"']+/gi, '$1***') : '';
    return `${String(handler.type)}${command ? `: ${command.slice(0, 120)}` : ''}`;
  });
  return `${value.length} 组 / ${handlers.length} handlers${details.length ? ` · ${details.join('; ')}` : ''}`;
}

export function buildHooksReport(input: HooksInput): HookMatrixReport {
  const source = readSource(input);
  const agents = readAgents(input);
  const names = [...new Set([...Object.keys(source.hooks), ...AGENTS.flatMap((agent) => Object.keys(agents.hooks[agent]))])];
  names.sort((a, b) => Number(Object.hasOwn(source.hooks, b)) - Number(Object.hasOwn(source.hooks, a)) || a.localeCompare(b));
  return {
    source: { path: input.sourcePath, exists: source.exists, bytes: source.bytes, error: source.error, eventCount: Object.keys(source.hooks).length },
    agents: [
      { key: 'claude', label: 'Claude Code', file: agents.claude.path, format: 'json', supported: true },
      { key: 'codex', label: 'Codex', file: input.codexHooks, format: 'json', supported: true },
      { key: 'pi', label: 'pi', file: '', format: 'json', supported: false },
    ],
    rows: names.map((event) => {
      const definitions = source.hooks[event];
      const cells: Record<string, HookMatrixCell> = { pi: { state: 'unsupported' } };
      for (const agent of AGENTS) {
        const actual = agents.hooks[agent][event];
        const defined = definitions && Object.hasOwn(definitions, agent);
        const expected = definitions?.[agent];
        let state: HookMatrixCell['state'];
        if (!supports(agent, event)) state = 'unsupported';
        else if (!defined) state = actual === undefined ? 'none' : 'orphan';
        else if ((actual === undefined || (Array.isArray(actual) && !actual.length)) && !expected?.length) state = 'synced';
        else if (actual === undefined || (Array.isArray(actual) && !actual.length)) state = 'missing';
        else state = isDeepStrictEqual(actual, expected) ? 'synced' : 'drift';
        cells[agent] = { state, summary: summary(actual), error: agents.errors[agent] };
      }
      return { event, inSource: !!definitions, sourceAgents: Object.keys(definitions ?? {}), ...(definitions ? { source: definitions } : {}), cells };
    }),
    warnings: agents.warnings, events: EVENTS, scannedAt: new Date().toISOString(),
  };
}

function writeJsonSnapshot(input: HooksInput, path: string, data: unknown, operation: string): string {
  const snapshot = createSnapshot(input.snapshotRoot, operation, [path], existsSync(path) ? [] : [path]);
  try { writeAtomically(path, `${JSON.stringify(data, null, 2)}\n`); }
  catch (error) { markSnapshotFailed(input.snapshotRoot, snapshot.id); throw error; }
  return snapshot.id;
}

export function runHooksAction(input: HooksInput, request: HookActionRequest): HookActionResponse {
  if (!object(request)) fail('请求必须是对象');
  const source = readSource(input);
  if (source.error) fail(`hooks source 无法读取：${source.error}`);
  const agents = readAgents(input);
  const snapshotIds: string[] = [];
  const warnings: string[] = [];
  const hooks = source.hooks;
  const action = request.action;
  const selected = request.agents === undefined ? AGENTS : (() => {
    if (!Array.isArray(request.agents)) fail('agents 必须是数组');
    return [...new Set(request.agents.map(agentName))];
  })();
  const requireAgent = () => {
    const agent = agentName(request.agent);
    if (agents.errors[agent]) fail(`${agent} hooks 无法读取：${agents.errors[agent]}`);
    return agent;
  };
  const saveSource = () => {
    for (const [event, definitions] of Object.entries(hooks)) { eventName(event); validateDefinitions(definitions); }
    snapshotIds.push(writeJsonSnapshot(input, input.sourcePath, { version: 1, hooks }, 'hooks source'));
  };
  const updates = new Map<Agent, ObjectValue>();
  const update = (agent: Agent) => {
    if (agents.errors[agent]) fail(`${agent} hooks 无法读取：${agents.errors[agent]}`);
    if (!updates.has(agent)) updates.set(agent, { ...agents.hooks[agent] });
    return updates.get(agent)!;
  };
  const sync = (events: string[]) => {
    for (const agent of selected) {
      for (const event of events) {
        if (!supports(agent, event)) { warnings.push(`${agent} 不支持 ${event}，已跳过`); continue; }
        const definitions = hooks[event];
        if (!definitions || !Object.hasOwn(definitions, agent)) continue;
        const target = update(agent);
        if (agent === 'codex' && !warnings.includes(TRUST_WARNING)) warnings.push(TRUST_WARNING);
        if (definitions[agent]!.length) target[event] = definitions[agent];
        else delete target[event];
      }
    }
  };
  switch (action) {
    case 'import': {
      const event = eventName(request.event);
      const agent = requireAgent();
      const value = agents.hooks[agent][event];
      if (value === undefined) fail(`${agent} 没有 ${event}`);
      const definitions = { ...hooks[event], [agent]: value };
      validateDefinitions(definitions);
      hooks[event] = definitions;
      saveSource();
      break;
    }
    case 'importAll':
      for (const agent of AGENTS) {
        if (agents.errors[agent]) fail(`${agent} hooks 无法读取：${agents.errors[agent]}`);
        for (const [event, value] of Object.entries(agents.hooks[agent])) {
          eventName(event);
          validateDefinitions({ [agent]: value });
          if (hooks[event] && Object.hasOwn(hooks[event], agent)) {
            if (!isDeepStrictEqual(hooks[event]![agent], value)) warnings.push(`${event}/${agent} 与源冲突，保留源定义`);
          } else hooks[event] = { ...hooks[event], [agent]: value as unknown[] };
        }
      }
      saveSource();
      break;
    case 'saveSource': {
      const event = eventName(request.event);
      validateDefinitions(request.definitions);
      if (Object.keys(request.definitions).length) hooks[event] = request.definitions;
      else delete hooks[event];
      // Preflight target readability before committing the source.
      if (request.agents?.length) sync([event]);
      saveSource();
      break;
    }
    case 'deleteSource':
      delete hooks[eventName(request.event)];
      saveSource();
      break;
    case 'sync':
      sync(request.event === undefined ? Object.keys(hooks) : [eventName(request.event)]);
      break;
    case 'remove': {
      const event = eventName(request.event);
      delete update(requireAgent())[event];
      break;
    }
    default: fail(`未知的 hooks 动作：${String(action)}`);
  }
  for (const [agent, mapping] of updates) {
    if (isDeepStrictEqual(mapping, agents.hooks[agent])) continue;
    const root = { ...agents.roots[agent], hooks: mapping };
    if (agent === 'claude') {
      snapshotIds.push(saveSettings({ files: input.settingsFiles, snapshotRoot: input.snapshotRoot,
        request: { fileId: 'claude-settings', etag: agents.claude.etag, data: root } }).snapshotId);
    } else {
      snapshotIds.push(writeJsonSnapshot(input, input.codexHooks, root, 'hooks codex'));
      if (!warnings.includes(TRUST_WARNING)) warnings.push(TRUST_WARNING);
    }
  }
  return { message: `Hooks ${action} 完成`, snapshotIds, warnings, report: buildHooksReport(input) };
}
