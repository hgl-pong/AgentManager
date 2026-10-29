import { spawn } from 'node:child_process';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { extname, join, normalize, sep } from 'node:path';
import { importSkill, linkSkill, removeSkill } from './actions.ts';
import { scanConfig } from './config.ts';
import { alignPrompt, initPrompts, scanPrompts } from './prompts.ts';
import { scanMatrix } from './scan.ts';
import { listSnapshots, restoreSnapshot } from './snapshot.ts';
import type {
  AgentSpec,
  ConfigFileSpec,
  PromptActionRequest,
  PromptTargetSpec,
  SkillActionRequest,
} from '../shared/types.ts';

const HOST = '127.0.0.1';
const PORT = Number(process.env.PORT ?? 7788);
const HOME = process.env.AGENT_MANAGER_HOME ?? homedir();
const PROJECT_ROOT = join(import.meta.dirname, '..');
const SNAPSHOT_ROOT = process.env.AGENT_MANAGER_SNAPSHOTS ?? join(PROJECT_ROOT, 'data', 'snapshots');
const DIST_DIR = join(PROJECT_ROOT, 'dist');

const SOURCE = join(HOME, '.agents', 'skills');
const AGENTS: AgentSpec[] = [
  { key: 'claude', label: 'Claude Code', root: join(HOME, '.claude', 'skills') },
  { key: 'codex', label: 'Codex', root: join(HOME, '.codex', 'skills') },
  { key: 'pi', label: 'pi', root: join(HOME, '.pi', 'agent', 'skills') },
];

const PROMPT_SOURCE = join(HOME, '.agents', 'prompts', 'global.md');
const PROMPT_TARGETS: PromptTargetSpec[] = [
  { key: 'claude', label: 'Claude Code', path: join(HOME, '.claude', 'CLAUDE.md') },
  { key: 'codex', label: 'Codex', path: join(HOME, '.codex', 'AGENTS.md') },
];

const CONFIG_FILES: ConfigFileSpec[] = [
  { agent: 'claude', label: 'Claude Code', path: join(HOME, '.claude', 'settings.json'), format: 'json', role: '设置与 MCP' },
  { agent: 'claude', label: 'Claude Code', path: join(HOME, '.claude.json'), format: 'json', role: '全局 MCP', listKeys: false },
  { agent: 'codex', label: 'Codex', path: join(HOME, '.codex', 'config.toml'), format: 'toml', role: '设置与 MCP' },
  { agent: 'pi', label: 'pi', path: join(HOME, '.pi', 'agent', 'settings.json'), format: 'json', role: '设置' },
];

const OPENABLE = new Set(
  [...CONFIG_FILES.map((file) => file.path), PROMPT_SOURCE, ...PROMPT_TARGETS.map((target) => target.path)].map(
    (path) => path.toLowerCase(),
  ),
);

function currentMatrix() {
  const started = performance.now();
  const matrix = scanMatrix({ source: SOURCE, agents: AGENTS });
  return {
    ...matrix,
    scannedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - started),
  };
}

function agentFor(key: string): AgentSpec {
  const agent = AGENTS.find((candidate) => candidate.key === key);
  if (!agent) throw new Error(`未知的 agent：${key}`);
  return agent;
}

function json(response: import('node:http').ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  response.end(JSON.stringify(body));
}

async function readJson(request: import('node:http').IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 1_000_000) throw new Error('请求体过大');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
};

function serveStatic(pathname: string, response: import('node:http').ServerResponse): boolean {
  if (!existsSync(DIST_DIR)) return false;
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const candidate = normalize(join(DIST_DIR, relativePath));
  if (!candidate.startsWith(DIST_DIR + sep) || !existsSync(candidate) || !statSync(candidate).isFile()) {
    // Client-side routing: unknown paths fall back to the single page.
    const fallback = join(DIST_DIR, 'index.html');
    if (!existsSync(fallback)) return false;
    response.writeHead(200, { 'content-type': MIME['.html'] as string });
    createReadStream(fallback).pipe(response);
    return true;
  }
  response.writeHead(200, { 'content-type': MIME[extname(candidate)] ?? 'application/octet-stream' });
  createReadStream(candidate).pipe(response);
  return true;
}

const server = createServer(async (request, response) => {
  const { pathname } = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);

  try {
    if (pathname === '/api/matrix' && request.method === 'GET') {
      json(response, 200, currentMatrix());
      return;
    }

    if (pathname === '/api/skills' && request.method === 'POST') {
      const body = (await readJson(request)) as unknown as SkillActionRequest;
      const agent = agentFor(String(body.agent));
      const input = {
        source: SOURCE,
        agentRoot: agent.root,
        agentLabel: agent.label,
        name: String(body.name),
        snapshotRoot: SNAPSHOT_ROOT,
      };
      const action = body.action === 'import' ? importSkill(input) : body.action === 'remove' ? removeSkill(input) : linkSkill(input);
      json(response, 200, { message: action.message, snapshotId: action.snapshotId, matrix: currentMatrix() });
      return;
    }

    if (pathname === '/api/prompts' && request.method === 'GET') {
      json(response, 200, scanPrompts(PROMPT_SOURCE, PROMPT_TARGETS));
      return;
    }

    if (pathname === '/api/prompts' && request.method === 'POST') {
      const body = (await readJson(request)) as unknown as PromptActionRequest;
      const input = { source: PROMPT_SOURCE, snapshotRoot: SNAPSHOT_ROOT, targets: PROMPT_TARGETS, primaryKey: 'claude' };
      const result = body.action === 'align' ? alignPrompt(input, String(body.agent)) : initPrompts(input);
      json(response, 200, result);
      return;
    }

    if (pathname === '/api/config' && request.method === 'GET') {
      json(response, 200, scanConfig(CONFIG_FILES));
      return;
    }

    if (pathname === '/api/snapshots' && request.method === 'GET') {
      json(response, 200, listSnapshots(SNAPSHOT_ROOT));
      return;
    }

    if (pathname === '/api/snapshots/restore' && request.method === 'POST') {
      const body = await readJson(request);
      const report = restoreSnapshot(SNAPSHOT_ROOT, String(body.id));
      json(response, 200, { report, matrix: currentMatrix() });
      return;
    }

    if (pathname === '/api/open' && request.method === 'POST') {
      const body = await readJson(request);
      const target = String(body.path ?? '');
      if (!OPENABLE.has(target.toLowerCase())) throw new Error('该路径不在可打开的白名单里');
      const [command, args] =
        process.platform === 'win32'
          ? (['cmd', ['/c', 'start', '', target]] as const)
          : (['open', [target]] as const);
      spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
      json(response, 200, { opened: target });
      return;
    }

    if (pathname.startsWith('/api/')) {
      json(response, 404, { error: 'not found' });
      return;
    }

    if (serveStatic(pathname, response)) return;
    json(response, 404, { error: 'not found — run `npm run dev` for the browser UI' });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[agent-manager]', pathname, message);
    json(response, 400, { error: message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-manager] api http://${HOST}:${PORT}/api/matrix`);
  console.log(`[agent-manager] source ${SOURCE}`);
  console.log(`[agent-manager] snapshots ${SNAPSHOT_ROOT}`);
});
