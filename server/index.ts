import { createServer } from 'node:http';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { scanMatrix } from './scan.ts';
import type { AgentSpec } from '../shared/types.ts';

const HOST = '127.0.0.1';
const PORT = 7788;
const SOURCE = join(homedir(), '.agents', 'skills');
const AGENTS: AgentSpec[] = [
  { key: 'claude', label: 'Claude Code', root: join(homedir(), '.claude', 'skills') },
  { key: 'codex', label: 'Codex', root: join(homedir(), '.codex', 'skills') },
  { key: 'pi', label: 'pi', root: join(homedir(), '.pi', 'agent', 'skills') },
];

const server = createServer((request, response) => {
  const { pathname } = new URL(request.url ?? '/', `http://${HOST}:${PORT}`);

  if (pathname !== '/api/matrix') {
    response.writeHead(404, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: 'not found' }));
    return;
  }

  const started = performance.now();
  try {
    const matrix = scanMatrix({ source: SOURCE, agents: AGENTS });
    const body = JSON.stringify({
      scannedAt: new Date().toISOString(),
      durationMs: Math.round(performance.now() - started),
      ...matrix,
    });
    response.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    });
    response.end(body);
  } catch (error) {
    console.error('[agent-manager] scan failed:', error);
    response.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[agent-manager] api http://${HOST}:${PORT}/api/matrix`);
  console.log(`[agent-manager] source ${SOURCE}`);
});
