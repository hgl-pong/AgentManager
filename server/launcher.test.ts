import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { createServer as createNetServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, test } from 'node:test';
import type { RuntimeState } from './launcher.ts';
import { parseArgs, resolveDataDir } from './launcher.ts';
import { VERSION } from './version.ts';

const PROJECT_ROOT = resolve(import.meta.dirname, '..');

interface Sandbox {
  root: string;
  home: string;
  dataDir: string;
  port: number;
}

const sandboxes: Sandbox[] = [];
const children = new Set<ChildProcess>();

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const probe = createNetServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('could not allocate a port'));
        return;
      }
      const { port: allocated } = address;
      probe.close(() => resolvePort(allocated));
    });
  });
}

async function createSandbox(): Promise<Sandbox> {
  const root = mkdtempSync(join(tmpdir(), 'agent-manager-launch-'));
  const home = join(root, 'home');
  const dataDir = join(root, 'data');
  mkdirSync(home, { recursive: true });
  const sandbox: Sandbox = { root, home, dataDir, port: await freePort() };
  sandboxes.push(sandbox);
  return sandbox;
}

function spawnApp(
  sandbox: Sandbox,
  args: string[],
  options: { collect?: boolean; env?: NodeJS.ProcessEnv } = {},
): ChildProcess {
  const child = spawn(process.execPath, ['server/index.ts', ...args], {
    cwd: PROJECT_ROOT,
    env: {
      ...process.env,
      AGENT_MANAGER_HOME: sandbox.home,
      AGENT_MANAGER_DATA: sandbox.dataDir,
      AGENT_MANAGER_NO_GUI: '1',
      ...options.env,
    },
    stdio: options.collect ? ['ignore', 'pipe', 'pipe'] : 'ignore',
  });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

async function healthAt(port: number): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
    if (!response.ok) return null;
    return (await response.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function waitForHealth(port: number, timeoutMs = 25_000): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const payload = await healthAt(port);
    if (payload) return payload;
    if (Date.now() > deadline) throw new Error(`app did not start on port ${port}`);
    await delay(150);
  }
}

async function waitForState(path: string, timeoutMs = 25_000): Promise<RuntimeState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (existsSync(path)) {
      try {
        return JSON.parse(readFileSync(path, 'utf8')) as RuntimeState;
      } catch {
        // An atomic write should never expose a partial file; retry anyway.
      }
    }
    if (Date.now() > deadline) throw new Error(`state file ${path} never appeared`);
    await delay(100);
  }
}

function waitForExit(process: ChildProcess, timeoutMs = 30_000): Promise<number | null> {
  if (process.exitCode !== null) return Promise.resolve(process.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      process.kill();
      reject(new Error('process did not exit in time'));
    }, timeoutMs);
    process.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

function collect(process: ChildProcess, timeoutMs = 30_000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolveCollect, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      process.kill();
      reject(new Error('process did not exit in time'));
    }, timeoutMs);
    process.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    process.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    process.once('exit', (code) => {
      clearTimeout(timer);
      resolveCollect({ code, stdout, stderr });
    });
  });
}

async function stopChild(child: ChildProcess | null): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill();
  try {
    await waitForExit(child, 5_000);
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Already gone.
    }
  }
}

function listen(server: Server | ReturnType<typeof createNetServer>): Promise<void> {
  return new Promise((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolveListen());
  });
}

function closeServer(server: Server | ReturnType<typeof createNetServer>): Promise<void> {
  return new Promise((resolveClose) => {
    if ('closeAllConnections' in server) server.closeAllConnections();
    server.close(() => resolveClose());
  });
}

function fakeHealth(sandbox: Sandbox, pid: number, port: number): Record<string, unknown> {
  return {
    app: 'agent-manager',
    version: VERSION,
    pid,
    port,
    url: `http://127.0.0.1:${port}`,
    source: 'fake',
    dataDir: sandbox.dataDir,
    startedAt: new Date().toISOString(),
  };
}

function writeFakeState(sandbox: Sandbox, pid: number, port: number): void {
  mkdirSync(sandbox.dataDir, { recursive: true });
  const state: RuntimeState = {
    app: 'agent-manager',
    version: VERSION,
    pid,
    port,
    url: `http://127.0.0.1:${port}`,
    source: 'fake',
    dataDir: sandbox.dataDir,
    startedAt: new Date().toISOString(),
  };
  writeFileSync(join(sandbox.dataDir, 'runtime.json'), `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

function spawnSleeper(): ChildProcess {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
  children.add(child);
  child.once('exit', () => children.delete(child));
  return child;
}

after(async () => {
  for (const child of [...children]) await stopChild(child);
  for (const sandbox of sandboxes) {
    try {
      rmSync(sandbox.root, { recursive: true, force: true });
    } catch {
      // Temp dirs are best effort; a leftover folder must not fail the suite.
    }
  }
});

test('parseArgs understands the standalone flags', () => {
  assert.deepEqual(parseArgs(['--no-window', '--port', '7801']), {
    noWindow: true,
    status: false,
    stop: false,
    help: false,
    version: false,
    port: 7801,
  });
  assert.equal(parseArgs(['--data=C:\\tmp\\am']).dataDir, resolve('C:\\tmp\\am'));
  assert.equal(parseArgs(['--version']).version, true);
  assert.throws(() => parseArgs(['--port', 'nope']), /--port/);
  assert.throws(() => parseArgs(['--wat']), /未知参数/);
});

test('默认 data 不可写时回退到用户状态目录，显式 --data 不回退', async () => {
  const sandbox = await createSandbox();
  const project = join(sandbox.root, 'readonly-project');
  mkdirSync(project, { recursive: true });
  // A plain file where the default data folder should go makes every write fail.
  writeFileSync(join(project, 'data'), 'not a directory', 'utf8');

  const stateRoot = join(sandbox.root, 'state-root');
  const env = { ...process.env, LOCALAPPDATA: stateRoot, XDG_STATE_HOME: stateRoot };
  const fallback = resolveDataDir({ projectRoot: project, env });
  const expected =
    process.platform === 'win32' ? join(stateRoot, 'AgentManager') : join(stateRoot, 'agent-manager');

  assert.equal(fallback.fallback, true);
  assert.equal(resolve(fallback.dataDir), resolve(expected));
  assert.equal(existsSync(expected), true);

  const explicit = resolveDataDir({ projectRoot: project, explicit: join(sandbox.root, 'explicit-data'), env });
  assert.equal(explicit.fallback, false);
  assert.equal(resolve(explicit.dataDir), resolve(join(sandbox.root, 'explicit-data')));
});

test('默认 data 不可写时服务实际回退到用户状态目录并正常运行', async () => {
  const sandbox = await createSandbox();
  const project = join(sandbox.root, 'readonly-project');
  mkdirSync(project, { recursive: true });
  writeFileSync(join(project, 'data'), 'not a directory', 'utf8');

  const stateRoot = join(sandbox.root, 'state-root');
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    AGENT_MANAGER_HOME: sandbox.home,
    AGENT_MANAGER_ROOT: project,
    AGENT_MANAGER_NO_GUI: '1',
    LOCALAPPDATA: stateRoot,
    XDG_STATE_HOME: stateRoot,
  };
  delete env.AGENT_MANAGER_DATA;

  const child = spawn(
    process.execPath,
    ['server/index.ts', '--no-window', '--port', String(sandbox.port)],
    { cwd: PROJECT_ROOT, env, stdio: 'ignore' },
  );
  children.add(child);
  child.once('exit', () => children.delete(child));

  try {
    const payload = await waitForHealth(sandbox.port);
    const expected = process.platform === 'win32' ? join(stateRoot, 'AgentManager') : join(stateRoot, 'agent-manager');
    assert.equal(resolve(String(payload.dataDir)), resolve(expected));
    assert.equal(existsSync(join(expected, 'runtime.json')), true);
  } finally {
    await stopChild(child);
  }
});

test('--version prints the version and exits without starting the server', async () => {
  const sandbox = await createSandbox();
  const report = await collect(spawnApp(sandbox, ['--version'], { collect: true }));
  assert.equal(report.code, 0);
  assert.match(report.stdout, new RegExp(`AgentManager ${VERSION.replace(/\./g, '\\.')}`));
  assert.equal(existsSync(join(sandbox.dataDir, 'runtime.json')), false);
});

test('starts a single instance, reuses it, reports status and quits cleanly', async () => {
  const sandbox = await createSandbox();
  const child = spawnApp(sandbox, ['--no-window', '--port', String(sandbox.port)]);
  const payload = await waitForHealth(sandbox.port);

  assert.equal(payload.app, 'agent-manager');
  assert.equal(payload.port, sandbox.port);
  assert.equal(payload.url, `http://127.0.0.1:${sandbox.port}`);

  const state = await waitForState(join(sandbox.dataDir, 'runtime.json'));
  assert.equal(state.app, 'agent-manager');
  assert.equal(state.port, sandbox.port);
  assert.equal(state.pid, child.pid);
  assert.equal(resolve(state.dataDir), resolve(sandbox.dataDir));

  // A second launch with a different --port must adopt the running instance, not start another.
  const second = await collect(spawnApp(sandbox, ['--no-window', '--port', String(sandbox.port + 1)]));
  assert.equal(second.code, 0);
  assert.equal((await healthAt(sandbox.port))?.pid, payload.pid);

  const status = await collect(spawnApp(sandbox, ['--status'], { collect: true }));
  assert.equal(status.code, 0);
  assert.match(status.stdout, /正在运行/);
  assert.match(status.stdout, new RegExp(String(sandbox.port)));

  const quit = await fetch(`http://127.0.0.1:${sandbox.port}/api/app/quit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(quit.status, 200);
  assert.equal(await waitForExit(child), 0);

  const deadline = Date.now() + 5_000;
  while (await healthAt(sandbox.port)) {
    if (Date.now() > deadline) throw new Error('server stayed up after quit');
    await delay(100);
  }
  assert.equal(existsSync(join(sandbox.dataDir, 'runtime.json')), false);
});

test('--stop stops a running instance', async () => {
  const sandbox = await createSandbox();
  const child = spawnApp(sandbox, ['--no-window', '--port', String(sandbox.port)]);
  await waitForHealth(sandbox.port);

  const report = await collect(spawnApp(sandbox, ['--stop'], { collect: true }));
  assert.equal(report.code, 0);
  assert.match(report.stdout, /已停止/);

  assert.equal(await waitForExit(child), 0);
  assert.equal(await healthAt(sandbox.port), null);
  assert.equal(existsSync(join(sandbox.dataDir, 'runtime.json')), false);
});

test('并发启动只产生一个服务，另一个复用后退出', async () => {
  const sandbox = await createSandbox();
  const first = spawnApp(sandbox, ['--no-window', '--port', String(sandbox.port)]);
  const second = spawnApp(sandbox, ['--no-window', '--port', String(sandbox.port)]);

  const payload = await waitForHealth(sandbox.port);
  assert.ok(payload.pid === first.pid || payload.pid === second.pid, 'server pid must be one of the two launches');

  const winner = payload.pid === first.pid ? first : second;
  const loser = winner === first ? second : first;

  assert.equal(await waitForExit(loser), 0);
  assert.equal((await healthAt(sandbox.port))?.pid, payload.pid);

  const state = await waitForState(join(sandbox.dataDir, 'runtime.json'));
  assert.equal(state.pid, winner.pid);

  assert.equal(
    await fetch(`http://127.0.0.1:${sandbox.port}/api/app/quit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    }).then((response) => response.status),
    200,
  );
  assert.equal(await waitForExit(winner), 0);
});

test('状态文件丢失且端口顺延后仍能发现并停止实例', async () => {
  const sandbox = await createSandbox();
  // Occupy the preferred port so the app has to shift by one. This server never answers,
  // so the health scan only matches the AgentManager instance on the next port.
  const blocker = createServer(() => {
    // Intentionally never respond.
  });
  await new Promise<void>((resolveListen, reject) => {
    blocker.once('error', reject);
    blocker.listen(sandbox.port, '127.0.0.1', () => resolveListen());
  });

  try {
    const child = spawnApp(sandbox, ['--no-window', '--port', String(sandbox.port)]);
    const payload = await waitForHealth(sandbox.port + 1);
    assert.equal(payload.port, sandbox.port + 1);

    const statePath = join(sandbox.dataDir, 'runtime.json');
    assert.equal(existsSync(statePath), true);
    rmSync(statePath);

    const status = await collect(spawnApp(sandbox, ['--status', '--port', String(sandbox.port)], { collect: true }));
    assert.equal(status.code, 0);
    assert.match(status.stdout, new RegExp(String(sandbox.port + 1)));

    const stop = await collect(spawnApp(sandbox, ['--stop', '--port', String(sandbox.port)], { collect: true }));
    assert.equal(stop.code, 0);
    assert.match(stop.stdout, /已停止/);
    assert.equal(await waitForExit(child), 0);
    assert.equal(await healthAt(sandbox.port + 1), null);
  } finally {
    await closeServer(blocker);
  }
});

test('不同数据目录的实例互不发现也互不停止', async () => {
  const first = await createSandbox();
  const second = await createSandbox();

  const firstChild = spawnApp(first, ['--no-window', '--port', String(first.port)]);
  const firstHealth = await waitForHealth(first.port);

  // Same preferred port, different data directory: the second instance must not adopt the first one.
  const secondChild = spawnApp(second, ['--no-window', '--port', String(first.port)]);
  const secondState = await waitForState(join(second.dataDir, 'runtime.json'));
  assert.equal(secondState.port, first.port + 1);
  assert.notEqual(secondState.pid, firstHealth.pid);

  const stop = await collect(spawnApp(second, ['--stop', '--port', String(first.port)], { collect: true }));
  assert.equal(stop.code, 0);
  assert.match(stop.stdout, /已停止/);
  assert.equal(await waitForExit(secondChild), 0);

  const stillRunning = await healthAt(first.port);
  assert.ok(stillRunning, 'the first instance must keep running');
  assert.equal(stillRunning?.pid, firstHealth.pid);

  await fetch(`http://127.0.0.1:${first.port}/api/app/quit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  assert.equal(await waitForExit(firstChild), 0);
});

test('quit 接口无效时 --stop 校验 pid 后强杀兜底', async () => {
  const sandbox = await createSandbox();
  const sleeper = spawnSleeper();
  await new Promise((resolveSpawn) => sleeper.once('spawn', resolveSpawn));

  let fakePort = 0;
  const fake = createServer((request, response) => {
    if (request.url === '/api/health') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fakeHealth(sandbox, sleeper.pid as number, fakePort)));
      return;
    }
    if (request.url === '/api/app/quit') {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"stopping":true}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await listen(fake);
  fakePort = (fake.address() as { port: number }).port;
  writeFakeState(sandbox, sleeper.pid as number, fakePort);

  try {
    const report = await collect(spawnApp(sandbox, ['--stop'], { collect: true }), 40_000);
    assert.equal(report.code, 0);
    assert.match(report.stdout, /已停止/);
    await waitForExit(sleeper, 5_000);
    assert.ok(sleeper.signalCode !== null || sleeper.exitCode !== null, 'the sleeper should have been terminated');
  } finally {
    await closeServer(fake);
  }
});

test('--stop 不会把健康探测超时当作已停止', async () => {
  const sandbox = await createSandbox();
  const sleeper = spawnSleeper();
  await new Promise((resolveSpawn) => sleeper.once('spawn', resolveSpawn));

  let quitting = false;
  let fakePort = 0;
  const fake = createServer((request, response) => {
    if (request.url === '/api/health') {
      if (quitting) return; // Keep the socket hanging: a timeout is not proof of a stop.
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fakeHealth(sandbox, sleeper.pid as number, fakePort)));
      return;
    }
    if (request.url === '/api/app/quit') {
      quitting = true;
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"stopping":true}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await listen(fake);
  fakePort = (fake.address() as { port: number }).port;
  writeFakeState(sandbox, sleeper.pid as number, fakePort);

  try {
    const report = await collect(spawnApp(sandbox, ['--stop'], { collect: true }), 40_000);
    assert.equal(report.code, 1);
    assert.match(report.stdout, /未能停止/);
    assert.equal(sleeper.exitCode, null, 'a health timeout must not kill the process');
    assert.equal(sleeper.signalCode, null, 'a health timeout must not kill the process');
  } finally {
    await closeServer(fake);
    await stopChild(sleeper);
  }
});

test('--stop 在健康 pid 与探测时不一致时不杀进程', async () => {
  const sandbox = await createSandbox();
  const target = spawnSleeper();
  const other = spawnSleeper();
  await Promise.all([
    new Promise((resolveSpawn) => target.once('spawn', resolveSpawn)),
    new Promise((resolveSpawn) => other.once('spawn', resolveSpawn)),
  ]);

  let phase: 'target' | 'other' = 'target';
  let fakePort = 0;
  const fake = createServer((request, response) => {
    if (request.url === '/api/health') {
      const pid = phase === 'target' ? (target.pid as number) : (other.pid as number);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify(fakeHealth(sandbox, pid, fakePort)));
      return;
    }
    if (request.url === '/api/app/quit') {
      phase = 'other';
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end('{"stopping":true}');
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await listen(fake);
  fakePort = (fake.address() as { port: number }).port;
  writeFakeState(sandbox, target.pid as number, fakePort);

  try {
    const report = await collect(spawnApp(sandbox, ['--stop'], { collect: true }), 40_000);
    assert.equal(report.code, 1);
    assert.match(report.stdout, /未能停止/);
    assert.equal(target.exitCode, null, 'the pid from the state file must not be killed');
    assert.equal(target.signalCode, null, 'the pid from the state file must not be killed');
    assert.equal(other.exitCode, null, 'the mismatched pid must not be killed either');
    assert.equal(other.signalCode, null, 'the mismatched pid must not be killed either');
  } finally {
    await closeServer(fake);
    await stopChild(target);
    await stopChild(other);
  }
});

test('data 目录不可写时启动失败并退出，不遗留服务进程', async () => {
  const sandbox = await createSandbox();
  // The global AGENT_MANAGER_DATA would otherwise be writable; use --data explicitly pointed at a file.
  const blocked = join(sandbox.root, 'blocked-data');
  writeFileSync(blocked, 'not a directory', 'utf8');

  const report = await collect(
    spawnApp(sandbox, ['--no-window', '--data', blocked, '--port', String(sandbox.port)], { collect: true }),
    20_000,
  );
  assert.equal(report.code, 1);
  assert.equal(await healthAt(sandbox.port), null);
});
