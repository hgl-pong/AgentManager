import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const EXE = join(ROOT, 'release', 'AgentManager.exe');
const PKG = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const SOURCE_ROOTS = [
  join(ROOT, 'server'),
  join(ROOT, 'shared'),
  join(ROOT, 'web', 'src'),
  join(ROOT, 'web', 'vite.config.ts'),
  join(ROOT, 'package.json'),
  join(ROOT, 'tsconfig.json'),
];

function freePort() {
  return new Promise((resolvePort, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      if (!address || typeof address === 'string') {
        probe.close();
        reject(new Error('no port'));
        return;
      }
      probe.close(() => resolvePort(address.port));
    });
  });
}

function newestMtime(target) {
  if (!existsSync(target)) return 0;
  const stats = statSync(target);
  if (!stats.isDirectory()) return stats.mtimeMs;
  let newest = stats.mtimeMs;
  for (const entry of readdirSync(target, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    newest = Math.max(newest, newestMtime(join(target, entry.name)));
  }
  return newest;
}

function waitExit(child, timeoutMs = 20_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolveExit, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error('process did not exit in time'));
    }, timeoutMs);
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveExit(code);
    });
  });
}

function collect(child, timeoutMs = 20_000) {
  return new Promise((resolveCollect, reject) => {
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`process did not exit in time\n${stdout}${stderr}`));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      resolveCollect({ code, stdout, stderr });
    });
  });
}

async function runOnce(args, timeoutMs = 20_000) {
  return collect(spawn(EXE, args, { stdio: ['ignore', 'pipe', 'pipe'] }), timeoutMs);
}

async function fetchWithRetry(url, attempts = 100) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(500) });
      if (response.ok) return response;
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 150));
  }
  throw lastError ?? new Error(`could not reach ${url}`);
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  try {
    child.kill();
  } catch {
    // Already gone.
  }
  try {
    await waitExit(child, 5_000);
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Nothing else to try.
    }
  }
}

async function run(root, home, data, children) {
  const exeStats = statSync(EXE);
  const newest = Math.max(...SOURCE_ROOTS.map(newestMtime));
  if (newest > exeStats.mtimeMs) {
    console.warn(
      `[verify-exe] 警告：${EXE} 早于最新源码（exe ${new Date(exeStats.mtimeMs).toISOString()}，源码 ${new Date(newest).toISOString()}）。请重新运行 npm run build:exe；以下检查可能针对旧版本。`,
    );
  }

  const versionRun = await runOnce(['--version']);
  if (versionRun.code !== 0) {
    throw new Error(`--version failed (${versionRun.code}): ${versionRun.stdout}${versionRun.stderr}`);
  }
  if (!versionRun.stdout.includes(PKG.version)) {
    throw new Error(`--version printed ${JSON.stringify(versionRun.stdout)}, expected ${PKG.version}`);
  }
  console.log(`[verify-exe] --version 正常 (${PKG.version})`);

  const statePath = join(data, 'runtime.json');
  const env = { ...process.env, AGENT_MANAGER_HOME: home, AGENT_MANAGER_NO_GUI: '1' };

  const port = await freePort();
  console.log(`[verify-exe] 启动 ${EXE} (port ${port})`);
  const child = spawn(EXE, ['--no-window', '--port', String(port), '--data', data], {
    env,
    stdio: 'ignore',
  });
  children.add(child);

  const healthResponse = await fetchWithRetry(`http://127.0.0.1:${port}/api/health`);
  const health = await healthResponse.json();
  if (health.app !== 'agent-manager') throw new Error(`unexpected health payload: ${JSON.stringify(health)}`);
  if (!health.version) throw new Error('health payload has no version');
  if (health.version !== PKG.version) {
    throw new Error(`版本不匹配：exe 报告 ${health.version}，package.json 为 ${PKG.version}`);
  }

  const page = await fetchWithRetry(`http://127.0.0.1:${port}/`);
  const html = await page.text();
  if (!html.includes('<div id="root">')) throw new Error('embedded index.html is missing #root');
  const script = /<script[^>]+src="([^"]+)"/.exec(html);
  if (!script?.[1]) throw new Error('embedded index.html has no script asset');
  const asset = await fetchWithRetry(`http://127.0.0.1:${port}${script[1]}`);
  const assetBody = await asset.text();
  if (assetBody.length < 10_000) throw new Error('embedded JavaScript asset looks truncated');
  console.log(`[verify-exe] 内嵌 UI 正常：${script[1]} (${Math.round(assetBody.length / 1024)} KB)`);

  const state = JSON.parse(readFileSync(statePath, 'utf8'));
  if (state.port !== port || state.pid !== child.pid) throw new Error('runtime.json does not match the process');

  const status = await runOnce(['--status', '--data', data]);
  if (status.code !== 0 || !status.stdout.includes('正在运行')) {
    throw new Error(`--status failed (${status.code}): ${status.stdout}${status.stderr}`);
  }
  console.log('[verify-exe] --status 正常');

  // A second launch against the same data directory must reuse the running server and exit 0,
  // even when it asks for a different port.
  const secondPort = await freePort();
  const second = spawn(EXE, ['--no-window', '--port', String(secondPort), '--data', data], {
    env,
    stdio: 'ignore',
  });
  children.add(second);
  const secondCode = await waitExit(second, 20_000);
  children.delete(second);
  if (secondCode !== 0) throw new Error(`second instance exited with ${secondCode}`);
  const reused = await (await fetchWithRetry(`http://127.0.0.1:${port}/api/health`)).json();
  if (reused.pid !== child.pid) throw new Error('second instance replaced the running server');
  console.log('[verify-exe] 双实例：第二个进程复用已有实例并退出 0');

  const quit = await fetch(`http://127.0.0.1:${port}/api/app/quit`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
  });
  if (quit.status !== 200) throw new Error(`quit returned ${quit.status}`);
  const code = await waitExit(child);
  children.delete(child);
  if (code !== 0) throw new Error(`standalone process exited with ${code}`);
  if (existsSync(statePath)) throw new Error('runtime.json was not removed on shutdown');
  console.log('[verify-exe] 退出时清理 runtime.json');

  const stopped = await runOnce(['--status', '--data', data]);
  if (stopped.code === 0 || !stopped.stdout.includes('未运行')) {
    throw new Error('--status should report a stopped app');
  }
  console.log('[verify-exe] 停止后 --status 正常');

  // --stop path: start again, then stop through the CLI and make sure the process is gone.
  const stopPort = await freePort();
  const stopTarget = spawn(EXE, ['--no-window', '--port', String(stopPort), '--data', data], {
    env,
    stdio: 'ignore',
  });
  children.add(stopTarget);
  await fetchWithRetry(`http://127.0.0.1:${stopPort}/api/health`);

  const stopRun = await runOnce(['--stop', '--data', data, '--port', String(stopPort)]);
  if (stopRun.code !== 0 || !stopRun.stdout.includes('已停止')) {
    throw new Error(`--stop failed (${stopRun.code}): ${stopRun.stdout}${stopRun.stderr}`);
  }
  const stopCode = await waitExit(stopTarget);
  children.delete(stopTarget);
  if (stopCode !== 0) throw new Error(`--stop left the process exiting with ${stopCode}`);
  if (existsSync(statePath)) throw new Error('--stop did not remove runtime.json');
  console.log('[verify-exe] --stop 正常');

  console.log('[verify-exe] 通过：独立 exe 可启动、内嵌 UI 可访问、可健康检查、可复用、可停止');
}

async function main() {
  if (!existsSync(EXE)) throw new Error(`缺少 ${EXE}，先运行 npm run build:exe`);

  const root = mkdtempSync(join(tmpdir(), 'agent-manager-exe-'));
  const home = join(root, 'home');
  const data = join(root, 'data');
  mkdirSync(home, { recursive: true });
  const children = new Set();
  let failure = null;

  try {
    await run(root, home, data, children);
  } catch (error) {
    failure = error;
  } finally {
    for (const child of children) {
      try {
        await stopChild(child);
      } catch (error) {
        if (failure === null) failure = error;
        else console.error('[verify-exe] 清理子进程失败：', error instanceof Error ? error.message : error);
      }
    }
    try {
      rmSync(root, { recursive: true, force: true });
    } catch (error) {
      if (failure === null) failure = error;
      else console.error('[verify-exe] 清理临时目录失败：', error instanceof Error ? error.message : error);
    }
  }

  if (failure) throw failure;
}

main().catch((error) => {
  console.error('[verify-exe] 失败：', error instanceof Error ? error.stack : error);
  process.exitCode = 1;
});
