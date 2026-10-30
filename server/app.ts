import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import type { IncomingMessage, Server, ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, resolve } from 'node:path';
import { importSkill, linkSkill, removeSkill, unlinkSkill } from './actions.ts';
import { scanConfig } from './config.ts';
import { alignPrompt, initPrompts, readPromptSource, savePromptSource, scanPrompts } from './prompts.ts';
import { buildMcpReport, runMcpAction } from './mcp.ts';
import { buildHooksReport, runHooksAction } from './hooks.ts';
import { getModelsReport } from './models.ts';
import { isInside, scanMatrix } from './scan.ts';
import { SETTINGS_CATALOG } from './settings-catalog.ts';
import { createSettingsRegistry, readSettings, saveSettings } from './settings.ts';
import { listSnapshots, restoreSnapshot } from './snapshot.ts';
import { VERSION } from './version.ts';
import { AppError } from '../shared/types.ts';
import type {
  AgentSpec,
  ConfigFileSpec,
  MatrixResponse,
  McpActionRequest,
  HookActionRequest,
  PromptActionRequest,
  PromptTargetSpec,
  SettingsFileDescriptor,
  SettingsSaveRequest,
  SkillActionRequest,
} from '../shared/types.ts';

/** Base64-encoded UI files, keyed by path relative to dist/. Used by the standalone build. */
export interface StaticAssets {
  [relativePath: string]: string;
}

export interface AppConfigInput {
  projectRoot: string;
  home?: string;
  dataDir?: string;
  distDir?: string;
  assets?: StaticAssets;
  version?: string;
  host?: string;
}

export interface AppConfig {
  home: string;
  projectRoot: string;
  dataDir: string;
  snapshotRoot: string;
  distDir: string;
  assets?: StaticAssets;
  version: string;
  host: string;
  source: string;
  agents: AgentSpec[];
  promptSource: string;
  promptTargets: PromptTargetSpec[];
  configFiles: ConfigFileSpec[];
  settingsFiles: SettingsFileDescriptor[];
  /** Single MCP source: <home>/.agents/mcp/servers.json. */
  mcpSource: string;
  hooksSource: string;
  codexHooks: string;
  openable: Set<string>;
}

export interface AppHooks {
  port: number;
  startedAt: string;
  onQuit?: () => void;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

/** Builds every path the app touches. Tests and the launcher both call this with explicit roots. */
export function createAppConfig(input: AppConfigInput): AppConfig {
  const home = input.home ?? process.env.AGENT_MANAGER_HOME ?? homedir();
  const projectRoot = input.projectRoot;
  const dataDir = input.dataDir ?? process.env.AGENT_MANAGER_DATA ?? join(projectRoot, 'data');
  const snapshotRoot = process.env.AGENT_MANAGER_SNAPSHOTS ?? join(dataDir, 'snapshots');
  const distDir = input.distDir ?? process.env.AGENT_MANAGER_DIST ?? join(projectRoot, 'dist');
  const host = input.host ?? '127.0.0.1';

  const source = join(home, '.agents', 'skills');
  const agents: AgentSpec[] = [
    { key: 'claude', label: 'Claude Code', root: join(home, '.claude', 'skills') },
    { key: 'codex', label: 'Codex', root: join(home, '.codex', 'skills') },
    { key: 'pi', label: 'pi', root: join(home, '.pi', 'agent', 'skills') },
  ];

  const promptSource = join(home, '.agents', 'prompts', 'global.md');
  const promptTargets: PromptTargetSpec[] = [
    { key: 'claude', label: 'Claude Code', path: join(home, '.claude', 'CLAUDE.md') },
    { key: 'codex', label: 'Codex', path: join(home, '.codex', 'AGENTS.md') },
    { key: 'pi', label: 'pi', path: join(home, '.pi', 'agent', 'AGENTS.md') },
  ];

  const configFiles: ConfigFileSpec[] = [
    {
      agent: 'claude',
      label: 'Claude Code',
      path: join(home, '.claude', 'settings.json'),
      format: 'json',
      role: '设置与 MCP',
    },
    {
      agent: 'claude',
      label: 'Claude Code',
      path: join(home, '.claude.json'),
      format: 'json',
      role: '全局 MCP',
      listKeys: false,
    },
    {
      agent: 'codex',
      label: 'Codex',
      path: join(home, '.codex', 'config.toml'),
      format: 'toml',
      role: '设置与 MCP',
    },
    {
      agent: 'pi',
      label: 'pi',
      path: join(home, '.pi', 'agent', 'settings.json'),
      format: 'json',
      role: '设置',
    },
    {
      agent: 'pi',
      label: 'pi',
      path: join(home, '.pi', 'agent', 'mcp.json'),
      format: 'json',
      role: '全局 MCP',
      listKeys: false,
    },
  ];

  const settingsFiles = createSettingsRegistry({ home });
  const mcpSource = join(home, '.agents', 'mcp', 'servers.json');
  const hooksSource = join(home, '.agents', 'hooks', 'hooks.json');
  const codexHooks = join(home, '.codex', 'hooks.json');

  const openable = new Set(
    [
      ...configFiles.map((file) => file.path),
      ...settingsFiles.flatMap((file) => [
        file.path,
        ...(file.hostPath && file.hostPath !== file.path ? [file.hostPath] : []),
      ]),
      promptSource,
      ...promptTargets.map((target) => target.path),
      mcpSource,
      hooksSource,
      codexHooks,
    ].map((path) => path.toLowerCase()),
  );

  return {
    home,
    projectRoot,
    dataDir,
    snapshotRoot,
    distDir,
    ...(input.assets ? { assets: input.assets } : {}),
    version: input.version ?? VERSION,
    host,
    source,
    agents,
    promptSource,
    promptTargets,
    configFiles,
    settingsFiles,
    mcpSource,
    hooksSource,
    codexHooks,
    openable,
  };
}

function currentMatrix(config: AppConfig): MatrixResponse {
  const started = performance.now();
  const matrix = scanMatrix({ source: config.source, agents: config.agents });
  return {
    ...matrix,
    scannedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
  };
}

/**
 * The matrix that follows a write. A scan failure must never make the client think the write
 * failed, so it retries once and then answers with an empty but well-formed matrix plus a warning.
 */
export function safeMatrix(config: AppConfig): MatrixResponse {
  let lastError: unknown;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return currentMatrix(config);
    } catch (error) {
      lastError = error;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  return {
    source: { path: config.source, skills: [] },
    agents: config.agents.map((agent) => ({ ...agent, detected: false })),
    rows: [],
    scannedAt: new Date().toISOString(),
    durationMs: 0,
    warning: `写操作已完成，但重新扫描失败：${message}`,
  };
}

function agentFor(config: AppConfig, key: string): AgentSpec {
  const agent = config.agents.find((candidate) => candidate.key === key);
  if (!agent) throw new AppError(400, `未知的 agent：${key}`);
  return agent;
}

/** Every path a snapshot restore may touch: the source, agent skill roots, prompt and settings files. */
function restoreRoots(config: AppConfig): string[] {
  return [
    config.source,
    ...config.agents.map((agent) => agent.root),
    config.promptSource,
    ...config.promptTargets.map((target) => target.path),
    ...config.settingsFiles.map((file) => file.hostPath ?? file.path),
    config.mcpSource,
    config.hooksSource,
    config.codexHooks,
  ];
}

/** Serializes every write so two browser actions can never interleave on disk. */
interface WriteQueue {
  run<T>(task: () => T | Promise<T>): Promise<T>;
}

function createWriteQueue(): WriteQueue {
  let tail: Promise<unknown> = Promise.resolve();
  return {
    run<T>(task: () => T | Promise<T>): Promise<T> {
      const next = tail.then(task, task);
      tail = next.then(
        () => undefined,
        () => undefined,
      );
      return next;
    },
  };
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  });
  response.end(JSON.stringify(body));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new AppError(400, '请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  let data: unknown;
  try {
    data = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new AppError(400, '请求体不是合法 JSON');
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new AppError(400, '请求体必须是 JSON 对象');
  }
  return data as Record<string, unknown>;
}

/**
 * Write endpoints answer only to this machine's page: the Host must name the loopback address,
 * any Origin must be the same origin, and the body must be declared as JSON.
 */
function assertLocalWrite(request: IncomingMessage, port: number): void {
  const host = String(request.headers.host ?? '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) {
    throw new AppError(403, `拒绝来自 ${host || '未知 Host'} 的写请求`);
  }
  const origin = request.headers.origin;
  if (origin !== undefined && String(origin).toLowerCase() !== `http://${host}`) {
    throw new AppError(403, '跨源写请求被拒绝');
  }
  const mediaType = String(request.headers['content-type'] ?? '')
    .split(';')[0]
    ?.trim()
    .toLowerCase();
  if (mediaType !== 'application/json') {
    throw new AppError(415, 'Content-Type 必须是 application/json');
  }
}

/** Picks the embedded asset for a request without ever reading Object.prototype entries. */
export function selectAsset(
  assets: StaticAssets,
  relativePath: string,
): { key: string; encoded: string } | null {
  const key = Object.hasOwn(assets, relativePath) ? relativePath : 'index.html';
  if (!Object.hasOwn(assets, key)) return null;
  return { key, encoded: assets[key] as string };
}

function serveStatic(pathname: string, response: ServerResponse, config: AppConfig): boolean {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);

  if (config.assets) {
    const asset = selectAsset(config.assets, relativePath);
    if (!asset) return false;
    const body = Buffer.from(asset.encoded, 'base64');
    response.writeHead(200, {
      'content-type': MIME[extname(asset.key)] ?? 'application/octet-stream',
      'content-length': body.length,
      'cache-control': asset.key === 'index.html' ? 'no-store' : 'public, max-age=31536000, immutable',
    });
    response.end(body);
    return true;
  }

  // Resolve both sides before comparing so `..`, mixed slashes and drive-letter case cannot escape.
  const distRoot = resolve(config.distDir);
  const candidate = resolve(distRoot, relativePath);
  if (
    !isInside(candidate, distRoot) ||
    !existsSync(candidate) ||
    !statSync(candidate).isFile()
  ) {
    // Client-side routing: unknown paths fall back to the single page.
    const fallback = join(distRoot, 'index.html');
    if (!existsSync(fallback)) return false;
    response.writeHead(200, { 'content-type': MIME['.html'] as string, 'cache-control': 'no-store' });
    createReadStream(fallback).pipe(response);
    return true;
  }
  response.writeHead(200, {
    'content-type': MIME[extname(candidate)] ?? 'application/octet-stream',
  });
  createReadStream(candidate).pipe(response);
  return true;
}

function openWithSystem(path: string): void {
  const [command, args] =
    process.platform === 'win32'
      ? (['cmd', ['/c', 'start', '', path]] as const)
      : process.platform === 'darwin'
        ? (['open', [path]] as const)
        : (['xdg-open', [path]] as const);
  spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

function mcpInput(config: AppConfig) {
  return { sourcePath: config.mcpSource, snapshotRoot: config.snapshotRoot, settingsFiles: config.settingsFiles };
}

function promptInput(config: AppConfig) {
  return {
    source: config.promptSource,
    snapshotRoot: config.snapshotRoot,
    targets: config.promptTargets,
    primaryKey: 'claude',
  };
}

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  config: AppConfig,
  hooks: AppHooks,
  writes: WriteQueue,
): Promise<void> {
  const { pathname } = new URL(request.url ?? '/', `http://${config.host}:${hooks.port}`);

  if (request.method === 'POST') assertLocalWrite(request, hooks.port);

  if (pathname === '/api/health' && request.method === 'GET') {
    json(response, 200, {
      app: 'agent-manager',
      version: config.version,
      pid: process.pid,
      port: hooks.port,
      url: `http://${config.host}:${hooks.port}`,
      source: config.source,
      dataDir: config.dataDir,
      startedAt: hooks.startedAt,
      uptimeSeconds: Math.round(process.uptime()),
    });
    return;
  }

  if (pathname === '/api/app/quit' && request.method === 'POST') {
    json(response, 200, { stopping: true });
    setTimeout(() => hooks.onQuit?.(), 100);
    return;
  }

  if (pathname === '/api/matrix' && request.method === 'GET') {
    json(response, 200, currentMatrix(config));
    return;
  }

  if (pathname === '/api/skills' && request.method === 'POST') {
    const body = (await readJson(request)) as unknown as SkillActionRequest;
    const kind = body.action;
    if (kind !== 'link' && kind !== 'import' && kind !== 'remove' && kind !== 'unlink') {
      throw new AppError(400, `未知的 skills 动作：${String(kind)}`);
    }
    const payload = await writes.run(() => {
      const agent = agentFor(config, String(body.agent));
      const input = {
        source: config.source,
        agentRoot: agent.root,
        agentLabel: agent.label,
        name: String(body.name),
        snapshotRoot: config.snapshotRoot,
      };
      const action =
        kind === 'import'
          ? importSkill(input)
          : kind === 'remove'
            ? removeSkill(input)
            : kind === 'unlink'
              ? unlinkSkill(input)
              : linkSkill(input);
      return { message: action.message, snapshotId: action.snapshotId, matrix: safeMatrix(config) };
    });
    json(response, 200, payload);
    return;
  }

  if (pathname === '/api/prompts' && request.method === 'GET') {
    json(response, 200, scanPrompts(config.promptSource, config.promptTargets));
    return;
  }

  if (pathname === '/api/prompts' && request.method === 'POST') {
    const body = (await readJson(request)) as unknown as PromptActionRequest;
    const action = body.action;
    if (action !== 'init' && action !== 'align') {
      throw new AppError(400, `未知的提示词动作：${String(action)}`);
    }
    const result = await writes.run(() =>
      action === 'align' ? alignPrompt(promptInput(config), String(body.agent)) : initPrompts(promptInput(config)),
    );
    json(response, 200, result);
    return;
  }

  if (pathname === '/api/prompts/content' && request.method === 'GET') {
    json(response, 200, readPromptSource(config.promptSource));
    return;
  }

  if (pathname === '/api/prompts/content' && request.method === 'POST') {
    const body = await readJson(request);
    if (typeof body.content !== 'string') throw new AppError(400, '缺少 content 字段');
    const content = body.content;
    const result = await writes.run(() => savePromptSource(promptInput(config), content));
    json(response, 200, result);
    return;
  }

  if (pathname === '/api/models' && request.method === 'GET') {
    const params = new URL(request.url ?? '/', `http://${config.host}:${hooks.port}`).searchParams;
    const refresh = params.get('refresh') === '1';
    const url =
      params.get('url') ??
      params.get('baseUrl') ??
      params.get('source') ??
      params.get('modelsUrl') ??
      params.get('endpoint') ??
      params.get('models_url') ??
      undefined;
    json(response, 200, await getModelsReport({ refresh, url }));
    return;
  }

  if (pathname === '/api/settings/catalog' && request.method === 'GET') {
    json(response, 200, SETTINGS_CATALOG);
    return;
  }

  if (pathname === '/api/settings' && request.method === 'GET') {
    json(response, 200, readSettings(config.settingsFiles));
    return;
  }

  if (pathname === '/api/settings/save' && request.method === 'POST') {
    const body = await readJson(request);
    const result = await writes.run(() =>
      saveSettings({
        files: config.settingsFiles,
        snapshotRoot: config.snapshotRoot,
        request: body as unknown as SettingsSaveRequest,
      }),
    );
    json(response, 200, result);
    return;
  }

  if (pathname === '/api/mcp' && request.method === 'GET') {
    json(response, 200, buildMcpReport(mcpInput(config)));
    return;
  }

  if (pathname === '/api/mcp' && request.method === 'POST') {
    const body = (await readJson(request)) as unknown as McpActionRequest;
    const result = await writes.run(() => runMcpAction(mcpInput(config), body));
    json(response, 200, result);
    return;
  }

  if (pathname === '/api/hooks' && (request.method === 'GET' || request.method === 'POST')) {
    const input = { sourcePath: config.hooksSource, codexHooks: config.codexHooks,
      snapshotRoot: config.snapshotRoot, settingsFiles: config.settingsFiles };
    const body = request.method === 'POST' ? (await readJson(request)) as unknown as HookActionRequest : undefined;
    const result = body === undefined ? buildHooksReport(input)
      : await writes.run(() => runHooksAction(input, body));
    json(response, 200, result);
    return;
  }

  if (pathname === '/api/config' && request.method === 'GET') {
    json(response, 200, scanConfig(config.configFiles));
    return;
  }

  if (pathname === '/api/snapshots' && request.method === 'GET') {
    json(response, 200, listSnapshots(config.snapshotRoot));
    return;
  }

  if (pathname === '/api/snapshots/restore' && request.method === 'POST') {
    const body = await readJson(request);
    const id = String(body.id ?? '');
    const payload = await writes.run(() => {
      const { snapshotId, ...report } = restoreSnapshot(config.snapshotRoot, id, restoreRoots(config));
      return { report, matrix: safeMatrix(config), snapshotId };
    });
    json(response, 200, payload);
    return;
  }

  if (pathname === '/api/open' && request.method === 'POST') {
    const body = await readJson(request);
    const target = String(body.path ?? '');
    if (!config.openable.has(target.toLowerCase())) throw new AppError(400, '该路径不在可打开的白名单里');
    openWithSystem(target);
    json(response, 200, { opened: target });
    return;
  }

  if (pathname.startsWith('/api/')) {
    json(response, 404, { error: 'not found' });
    return;
  }

  if (serveStatic(pathname, response, config)) return;
  json(response, 404, { error: 'not found — run `npm run dev` for the browser UI' });
}

export interface RunningApp {
  server: Server;
  close: () => Promise<void>;
}

/** Starts the HTTP API. The caller owns the process lifecycle and the browser window. */
export async function startAgentServer(config: AppConfig, hooks: AppHooks): Promise<RunningApp> {
  const writes = createWriteQueue();
  const server = createServer((request, response) => {
    handleRequest(request, response, config, hooks, writes).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      // Validation 400, missing 404, conflict 409; anything unexpected is a server-side 500.
      const status = error instanceof AppError ? error.status : 500;
      console.error('[agent-manager]', request.url, status, message);
      if (!response.headersSent) json(response, status, { error: message });
      else response.end();
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (error: Error) => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = () => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(hooks.port, config.host);
  });

  // A permanent handler: without it a socket error after listen would take the process down.
  server.on('error', (error) => {
    console.error('[agent-manager] server error', error instanceof Error ? error.message : error);
  });

  return {
    server,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections?.();
      }),
  };
}
