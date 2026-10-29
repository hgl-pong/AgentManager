import { spawn } from 'node:child_process';
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createAppConfig, startAgentServer } from './app.ts';
import type { AppHooks, RunningApp, StaticAssets } from './app.ts';
import { VERSION } from './version.ts';

export interface LaunchInput {
  /** Repo root in dev, or the folder next to the executable in a standalone build. */
  projectRoot: string;
  argv?: string[];
  assets?: StaticAssets;
  home?: string;
  dataDir?: string;
  /** Injectable for tests. Defaults to opening an Edge/Chrome app window. */
  openWindow?: (url: string) => void;
  log?: (message: string) => void;
}

export interface RuntimeState {
  app: 'agent-manager';
  version: string;
  pid: number;
  port: number;
  url: string;
  source: string;
  dataDir: string;
  startedAt: string;
}

export interface LaunchResult {
  port: number;
  url: string;
  running: boolean;
}

interface Options {
  port?: number;
  noWindow: boolean;
  status: boolean;
  stop: boolean;
  help: boolean;
  version: boolean;
  home?: string;
  dataDir?: string;
}

interface HealthPayload {
  app: string;
  version: string;
  pid: number;
  port: number;
  url: string;
  source: string;
  dataDir: string;
  startedAt: string;
}

interface LockInfo {
  app: 'agent-manager';
  pid: number;
  port: number;
  url: string;
  dataDir: string;
  createdAt: string;
}

type ProbeResult =
  | { kind: 'healthy'; health: HealthPayload }
  | { kind: 'refused' }
  | { kind: 'timeout' }
  | { kind: 'error'; message: string };

const DEFAULT_PORT = 7788;
const PORT_SCAN_LIMIT = 50;
const HEALTH_TIMEOUT_MS = 1_500;
const HEALTH_ATTEMPTS = 3;
const HEALTH_RETRY_GAP_MS = 200;
const SCAN_TIMEOUT_MS = 400;
const PROBE_INTERVAL_MS = 100;
const STOP_WAIT_MS = 3_000;
const KILL_WAIT_MS = 2_000;
const PEER_WAIT_MS = 12_000;

export function parseArgs(argv: string[]): Options {
  const options: Options = {
    noWindow: false,
    status: false,
    stop: false,
    help: false,
    version: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    const [name, inline] = arg.includes('=') ? (arg.split('=') as [string, string]) : [arg, undefined];
    const next = () => {
      const value = inline ?? argv[index + 1];
      if (!value || value.startsWith('--')) throw new Error(`${name} 需要一个值`);
      if (inline === undefined) index += 1;
      return value;
    };

    switch (name) {
      case '--port':
        options.port = Number(next());
        if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
          throw new Error('--port 必须是 1-65535 的整数');
        }
        break;
      case '--home':
        options.home = resolve(next());
        break;
      case '--data':
        options.dataDir = resolve(next());
        break;
      case '--no-window':
        options.noWindow = true;
        break;
      case '--status':
        options.status = true;
        break;
      case '--stop':
        options.stop = true;
        break;
      case '--version':
        options.version = true;
        break;
      case '--help':
      case '-h':
        options.help = true;
        break;
      default:
        throw new Error(`未知参数：${arg}`);
    }
  }

  return options;
}

export function statusFile(dataDir: string): string {
  return join(dataDir, 'runtime.json');
}

export function lockFile(dataDir: string): string {
  return join(dataDir, 'runtime.lock');
}

function readState(path: string): RuntimeState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<RuntimeState>;
    if (parsed.app !== 'agent-manager' || typeof parsed.port !== 'number' || typeof parsed.pid !== 'number') {
      return null;
    }
    return parsed as RuntimeState;
  } catch {
    return null;
  }
}

function readLock(path: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8')) as Partial<LockInfo>;
    if (parsed.app !== 'agent-manager' || typeof parsed.pid !== 'number') return null;
    return {
      app: 'agent-manager',
      pid: parsed.pid,
      port: typeof parsed.port === 'number' ? parsed.port : 0,
      url: typeof parsed.url === 'string' ? parsed.url : '',
      dataDir: typeof parsed.dataDir === 'string' ? parsed.dataDir : '',
      createdAt: typeof parsed.createdAt === 'string' ? parsed.createdAt : '',
    };
  } catch {
    return null;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Windows rename can fail while an antivirus/indexer holds the target; retry briefly before giving up. */
function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(temp, content, 'utf8');
  let lastError: unknown;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      renameSync(temp, path);
      return;
    } catch (error) {
      lastError = error;
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EPERM' && code !== 'EBUSY' && code !== 'EACCES' && code !== 'EEXIST') break;
      sleepSync(50);
    }
  }
  try {
    rmSync(temp, { force: true });
  } catch {
    // Best effort: the original write error is the one worth reporting.
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`无法写入 ${path}：${message}`);
}

function writeState(path: string, state: RuntimeState): void {
  writeFileAtomic(path, `${JSON.stringify(state, null, 2)}\n`);
}

function writeLock(path: string, lock: LockInfo): void {
  writeFileAtomic(path, `${JSON.stringify(lock, null, 2)}\n`);
}

function removeState(path: string): void {
  rmSync(path, { force: true });
}

function samePath(a: string | undefined, b: string): boolean {
  if (!a || !b) return false;
  const normalize = (value: string) => {
    const absolute = resolve(value);
    return process.platform === 'win32' ? absolute.toLowerCase() : absolute;
  };
  return normalize(a) === normalize(b);
}

function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function probePort(port: number, timeoutMs = HEALTH_TIMEOUT_MS): Promise<ProbeResult> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return { kind: 'error', message: `HTTP ${response.status}` };
    const payload = (await response.json()) as Partial<HealthPayload>;
    if (
      payload.app !== 'agent-manager' ||
      typeof payload.port !== 'number' ||
      typeof payload.pid !== 'number'
    ) {
      return { kind: 'error', message: '不是 AgentManager 的健康响应' };
    }
    return { kind: 'healthy', health: payload as HealthPayload };
  } catch (error) {
    const failure = error as {
      name?: string;
      code?: string;
      cause?: { code?: string; name?: string };
    };
    const code = failure.cause?.code ?? failure.code;
    if (code === 'ECONNREFUSED') return { kind: 'refused' };
    if (
      failure.name === 'TimeoutError' ||
      failure.cause?.name === 'TimeoutError' ||
      code === 'ABORT_ERR'
    ) {
      return { kind: 'timeout' };
    }
    return { kind: 'error', message: errorMessage(error) };
  }
}

/** A missing answer is retried a few times: a busy instance may be slower than one request timeout. */
async function probeHealth(
  port: number,
  attempts = HEALTH_ATTEMPTS,
  timeoutMs = HEALTH_TIMEOUT_MS,
): Promise<HealthPayload | null> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const result = await probePort(port, timeoutMs);
    if (result.kind === 'healthy') return result.health;
    if (result.kind === 'refused') return null;
    if (attempt < attempts - 1) await delay(HEALTH_RETRY_GAP_MS);
  }
  return null;
}

function stateFromHealth(health: HealthPayload): RuntimeState {
  return {
    app: 'agent-manager',
    version: health.version,
    pid: health.pid,
    port: health.port,
    url: health.url,
    source: health.source,
    dataDir: health.dataDir,
    startedAt: health.startedAt,
  };
}

function tryCreateLock(path: string, lock: LockInfo): boolean {
  mkdirSync(dirname(path), { recursive: true });
  try {
    writeFileSync(path, `${JSON.stringify(lock, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/** Removes the lock only when this process owns it, so a reclaimed lock cannot be deleted twice. */
function releaseLock(path: string, pid: number): void {
  const lock = readLock(path);
  if (lock && lock.pid !== pid) return;
  rmSync(path, { force: true });
}

function removeLockQuietly(path: string, log: (message: string) => void): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    log(`删除锁文件失败：${errorMessage(error)}`);
  }
}

async function isStaleLock(lock: LockInfo, dataDir: string): Promise<boolean> {
  if (!samePath(lock.dataDir, dataDir)) return true;
  if (lock.port > 0) {
    const health = await probeHealth(lock.port);
    if (health) return !samePath(health.dataDir, dataDir);
  }
  return !pidAlive(lock.pid);
}

interface DetectInput {
  statePath: string;
  lockPath: string;
  preferredPort: number;
  dataDir: string;
}

/**
 * Finds a live instance that serves *this* data directory. The data directory is compared on
 * every hit so two installations side by side never adopt or stop each other's server.
 */
async function detectRunning(input: DetectInput): Promise<RuntimeState | null> {
  const state = readState(input.statePath);
  const stateMatches = state ? samePath(state.dataDir, input.dataDir) : false;

  if (state && stateMatches) {
    const health = await probeHealth(state.port);
    if (health) {
      if (samePath(health.dataDir, input.dataDir)) return stateFromHealth(health);
      // The port now belongs to another data directory: this state file is stale.
      try {
        removeState(input.statePath);
      } catch {
        // A stale state file only matters until the next launch.
      }
    } else if (!pidAlive(state.pid)) {
      try {
        removeState(input.statePath);
      } catch {
        // Ignore: detection falls back to the port scan anyway.
      }
    }
  }

  const ports: number[] = [];
  for (let offset = 0; offset < PORT_SCAN_LIMIT; offset += 1) {
    const port = input.preferredPort + offset;
    if (port < 1 || port > 65535) break;
    if (stateMatches && state?.port === port) continue;
    ports.push(port);
  }

  const lock = readLock(input.lockPath);
  if (lock && lock.port > 0 && samePath(lock.dataDir, input.dataDir) && !ports.includes(lock.port)) {
    ports.unshift(lock.port);
  }

  for (let index = 0; index < ports.length; index += 10) {
    const batch = ports.slice(index, index + 10);
    const results = await Promise.all(
      batch.map(async (port) => ({ port, probe: await probePort(port, SCAN_TIMEOUT_MS) })),
    );
    for (const { probe } of results) {
      if (probe.kind === 'healthy' && samePath(probe.health.dataDir, input.dataDir)) {
        return stateFromHealth(probe.health);
      }
    }
  }

  return null;
}

interface WaitForPeerInput extends DetectInput {
  timeoutMs: number;
}

/** Waits for the launch that already holds the lock to finish booting and answer the health check. */
async function waitForPeer(input: WaitForPeerInput): Promise<RuntimeState | null> {
  const deadline = Date.now() + input.timeoutMs;
  let pass = 0;

  while (Date.now() < deadline) {
    const state = readState(input.statePath);
    if (state && samePath(state.dataDir, input.dataDir)) {
      const health = await probeHealth(state.port, 2, 1_000);
      if (health && samePath(health.dataDir, input.dataDir)) return stateFromHealth(health);
    }

    const lock = readLock(input.lockPath);
    if (lock && lock.port > 0 && samePath(lock.dataDir, input.dataDir)) {
      const health = await probeHealth(lock.port, 1, 600);
      if (health && samePath(health.dataDir, input.dataDir)) return stateFromHealth(health);
    }
    if (lock && !pidAlive(lock.pid)) return null;

    if (pass % 4 === 0) {
      const found = await detectRunning(input);
      if (found) return found;
    }

    pass += 1;
    await delay(200);
  }

  return null;
}

type LockOutcome = { kind: 'acquired' } | { kind: 'running'; state: RuntimeState };

async function acquireLock(input: DetectInput & { log: (message: string) => void }): Promise<LockOutcome> {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const lock: LockInfo = {
      app: 'agent-manager',
      pid: process.pid,
      port: 0,
      url: '',
      dataDir: input.dataDir,
      createdAt: new Date().toISOString(),
    };
    if (tryCreateLock(input.lockPath, lock)) return { kind: 'acquired' };

    input.log(`另一个启动过程持有 ${input.lockPath}，等待其就绪`);
    const peer = await waitForPeer({ ...input, timeoutMs: PEER_WAIT_MS });
    if (peer) return { kind: 'running', state: peer };

    const existing = readLock(input.lockPath);
    if (!existing) continue;

    if (await isStaleLock(existing, input.dataDir)) {
      input.log(`回收过期锁（pid ${existing.pid}）`);
      removeLockQuietly(input.lockPath, input.log);
      continue;
    }
    if (!pidAlive(existing.pid)) {
      removeLockQuietly(input.lockPath, input.log);
      continue;
    }

    throw new Error(`另一个 AgentManager 实例正在启动（pid ${existing.pid}），请稍后重试`);
  }

  throw new Error('无法获取运行时锁，请检查数据目录权限');
}

function appBrowserCandidates(): string[] {
  if (process.platform !== 'win32') return [];
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA ?? '';
  return [
    process.env.AGENT_MANAGER_BROWSER ?? '',
    join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(localAppData, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
    join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
  ].filter(Boolean);
}

/** Opens a tab-less browser window so the app looks like a desktop program, not a website. */
export function openAppWindow(url: string): void {
  if (process.platform === 'win32') {
    const browser = appBrowserCandidates().find((candidate) => existsSync(candidate));
    if (browser) {
      spawn(
        browser,
        [
          `--app=${url}`,
          '--window-size=1280,900',
          '--no-first-run',
          '--no-default-browser-check',
          '--disable-features=msEdgeSidebarV2',
        ],
        { detached: true, stdio: 'ignore', windowsHide: true },
      ).unref();
      return;
    }
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return;
  }

  if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref();
    return;
  }

  spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref();
}

/**
 * Standalone builds run through the hidden VBS launcher, where even a console app's output is
 * invisible, so fatal startup errors also surface as a dialog. `mshta` ships with Windows and
 * needs no extra dependency. Set AGENT_MANAGER_NO_GUI=1 to silence it (tests and verify-exe do).
 */
export function notifyUser(message: string): void {
  if (process.platform !== 'win32') return;
  if (process.env.AGENT_MANAGER_NO_GUI === '1') return;
  try {
    spawn('mshta', [`javascript:alert(${JSON.stringify(message)});close()`], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch {
    // Without a console or a dialog there is nowhere left to report to.
  }
}

function createLogger(dataDir: string, injected?: (message: string) => void): (message: string) => void {
  const logPath = join(dataDir, 'app.log');
  return (message) => {
    const line = `[${new Date().toISOString()}] ${message}`;
    injected?.(line);
    try {
      mkdirSync(dirname(logPath), { recursive: true });
      appendFileSync(logPath, `${line}\n`, 'utf8');
    } catch {
      // Logging must never take the app down.
    }
  };
}

export interface DataDirResolution {
  dataDir: string;
  fallback: boolean;
  reason?: string;
}

/** Returns null when the directory accepts a probe file, otherwise the reason it does not. */
function ensureWritableDir(dir: string): string | null {
  try {
    mkdirSync(dir, { recursive: true });
    const probe = join(dir, `.write-probe-${process.pid}-${Date.now()}`);
    writeFileSync(probe, 'ok', 'utf8');
    rmSync(probe, { force: true });
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

function fallbackDataDir(env: NodeJS.ProcessEnv): string {
  if (process.platform === 'win32') {
    const base = env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local');
    return join(base, 'AgentManager');
  }
  const base = env.XDG_STATE_HOME || join(homedir(), '.local', 'state');
  return join(base, 'agent-manager');
}

/**
 * Resolves the runtime data directory. A packaged exe may sit in a read-only folder (Program Files),
 * so the default `data/` next to it falls back to the user state folder when it cannot be written.
 * An explicit `--data`/AGENT_MANAGER_DATA is honored or fails loudly; it is never silently moved.
 */
export function resolveDataDir(input: {
  projectRoot: string;
  explicit?: string;
  env?: NodeJS.ProcessEnv;
}): DataDirResolution {
  const env = input.env ?? process.env;
  const explicit = input.explicit?.trim();
  if (explicit) {
    const dataDir = resolve(explicit);
    const problem = ensureWritableDir(dataDir);
    if (problem) throw new Error(`数据目录不可写：${dataDir}（${problem}）`);
    return { dataDir, fallback: false };
  }

  const preferred = resolve(join(input.projectRoot, 'data'));
  const preferredProblem = ensureWritableDir(preferred);
  if (!preferredProblem) return { dataDir: preferred, fallback: false };

  const fallback = fallbackDataDir(env);
  const fallbackProblem = ensureWritableDir(fallback);
  if (fallbackProblem) {
    throw new Error(
      `数据目录不可写：${preferred}（${preferredProblem}）；回退目录 ${fallback} 也不可写（${fallbackProblem}）`,
    );
  }
  return { dataDir: fallback, fallback: true, reason: `${preferred} 不可写：${preferredProblem}` };
}

function healthLine(health: HealthPayload | RuntimeState): string {
  return [
    `AgentManager ${health.version} 正在运行`,
    `  URL:   ${health.url}`,
    `  PID:   ${health.pid}`,
    `  source: ${health.source}`,
    `  data:  ${health.dataDir}`,
  ].join('\n');
}

export const HELP = `AgentManager — 多 code agent 配置管理器

用法:
  AgentManager                 启动服务并打开应用窗口（已运行则直接再开一个窗口）
  AgentManager --no-window     只启动服务，不开窗口
  AgentManager --status        查看是否正在运行
  AgentManager --stop          停止正在运行的实例
  AgentManager --port 7788     指定端口（被占用时自动顺延）
  AgentManager --home <dir>    使用另一个用户主目录（调试用）
  AgentManager --data <dir>    指定运行时数据/快照目录
  AgentManager --version       显示版本
  AgentManager --help          显示这段帮助
`;

async function closeQuietly(application: RunningApp | null, log: (message: string) => void): Promise<void> {
  try {
    await application?.close();
  } catch (error) {
    log(`关闭服务失败：${errorMessage(error)}`);
  }
}

/** Only a refused connection or a confirmed dead pid counts as stopped; a timeout is not proof. */
async function stopRunning(state: RuntimeState, log: (message: string) => void): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/app/quit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(2_500),
    });
    if (!response.ok) log(`quit 请求返回 HTTP ${response.status}`);
  } catch (error) {
    log(`quit 请求失败：${errorMessage(error)}`);
  }

  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    const probe = await probePort(state.port, 800);
    if (probe.kind === 'refused') return true;
    if (probe.kind === 'healthy' && probe.health.pid !== state.pid) {
      return !pidAlive(state.pid);
    }
    if (probe.kind !== 'healthy' && !pidAlive(state.pid)) return true;
    await delay(PROBE_INTERVAL_MS);
  }

  if (!pidAlive(state.pid)) return true;

  const finalProbe = await probePort(state.port, 1_000);
  if (finalProbe.kind === 'refused') return true;
  if (!pidAlive(state.pid)) return true;
  if (
    finalProbe.kind !== 'healthy' ||
    state.pid <= 0 ||
    finalProbe.health.pid !== state.pid
  ) {
    log(`无法确认 pid ${state.pid} 的身份，不发送终止信号`);
    return false;
  }

  log(`进程 ${state.pid} 未通过 API 停止，发送终止信号`);
  try {
    process.kill(state.pid);
  } catch (error) {
    if (!pidAlive(state.pid)) return true;
    log(`终止 pid ${state.pid} 失败：${errorMessage(error)}`);
    return false;
  }

  const killDeadline = Date.now() + KILL_WAIT_MS;
  while (Date.now() < killDeadline) {
    if (!pidAlive(state.pid)) return true;
    const probe = await probePort(state.port, 500);
    if (probe.kind === 'refused') return true;
    await delay(PROBE_INTERVAL_MS);
  }
  return false;
}

function reuseInstance(
  state: RuntimeState,
  options: Options,
  input: LaunchInput,
  log: (message: string) => void,
): LaunchResult {
  log(`already running at ${state.url}`);
  if (!options.noWindow) (input.openWindow ?? openAppWindow)(state.url);
  return { port: state.port, url: state.url, running: true };
}

/**
 * Starts (or reuses) the local app. The process stays alive as the server; callers that
 * spawn this function get a long-running process until /api/app/quit or --stop.
 */
export async function launch(input: LaunchInput): Promise<LaunchResult> {
  const argv = input.argv ?? [];
  const options = parseArgs(argv);

  if (options.help) {
    process.stdout.write(HELP);
    return { port: 0, url: '', running: false };
  }
  if (options.version) {
    process.stdout.write(`AgentManager ${VERSION}\n`);
    return { port: 0, url: '', running: false };
  }

  const explicitDataDir = input.dataDir ?? options.dataDir ?? process.env.AGENT_MANAGER_DATA;
  const resolvedData = resolveDataDir({
    projectRoot: input.projectRoot,
    ...(explicitDataDir ? { explicit: explicitDataDir } : {}),
  });
  const dataDir = resolvedData.dataDir;
  const log = createLogger(dataDir, input.log);
  if (resolvedData.fallback) log(`数据目录回退到 ${dataDir}（${resolvedData.reason}）`);

  const statePath = statusFile(dataDir);
  const lockPath = lockFile(dataDir);

  const preferredPort = options.port ?? Number(process.env.PORT ?? DEFAULT_PORT);
  if (!Number.isInteger(preferredPort) || preferredPort < 1 || preferredPort > 65535) {
    throw new Error(`端口无效：${process.env.PORT ?? options.port}`);
  }

  const detectInput: DetectInput = { statePath, lockPath, preferredPort, dataDir };
  const running = await detectRunning(detectInput);

  if (options.status) {
    if (!running) {
      process.stdout.write('AgentManager 未运行\n');
      process.exitCode = 1;
      return { port: 0, url: '', running: false };
    }
    process.stdout.write(`${healthLine(running)}\n`);
    return { port: running.port, url: running.url, running: true };
  }

  if (options.stop) {
    if (!running) {
      process.stdout.write('AgentManager 未运行\n');
      try {
        removeState(statePath);
      } catch {
        // Nothing left to clean up.
      }
      const staleLock = readLock(lockPath);
      if (staleLock && !pidAlive(staleLock.pid)) removeLockQuietly(lockPath, log);
      return { port: 0, url: '', running: false };
    }
    const stopped = await stopRunning(running, log);
    if (stopped) {
      try {
        removeState(statePath);
      } catch (error) {
        log(`删除状态文件失败：${errorMessage(error)}`);
      }
      try {
        releaseLock(lockPath, running.pid);
      } catch (error) {
        log(`删除锁文件失败：${errorMessage(error)}`);
      }
    }
    process.stdout.write(
      stopped ? 'AgentManager 已停止\n' : 'AgentManager 未能停止，进程可能仍在运行，请查看 app.log\n',
    );
    process.exitCode = stopped ? 0 : 1;
    return { port: running.port, url: running.url, running: false };
  }

  if (running) return reuseInstance(running, options, input, log);

  const outcome = await acquireLock({ ...detectInput, log });
  if (outcome.kind === 'running') {
    return reuseInstance(outcome.state, options, input, log);
  }

  const config = createAppConfig({
    projectRoot: input.projectRoot,
    ...(input.home ?? options.home ? { home: input.home ?? options.home } : {}),
    dataDir,
    ...(input.assets ? { assets: input.assets } : {}),
    version: VERSION,
  });

  const startedAt = new Date().toISOString();
  let application: RunningApp | null = null;
  let activePort = preferredPort;

  try {
    for (let attempt = 0; attempt < PORT_SCAN_LIMIT; attempt += 1) {
      const port = preferredPort + attempt;
      if (port > 65535) break;
      try {
        const hooks: AppHooks = {
          port,
          startedAt,
          onQuit: () => {
            void shutdown(0);
          },
        };
        application = await startAgentServer(config, hooks);
        activePort = port;
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
        log(`port ${port} is busy, trying ${port + 1}`);
      }
    }

    if (!application) throw new Error(`没有可用端口（已从起始端口尝试 ${PORT_SCAN_LIMIT} 个）`);

    const url = `http://${config.host}:${activePort}`;
    const state: RuntimeState = {
      app: 'agent-manager',
      version: VERSION,
      pid: process.pid,
      port: activePort,
      url,
      source: config.source,
      dataDir,
      startedAt,
    };

    try {
      writeLock(lockPath, {
        app: 'agent-manager',
        pid: process.pid,
        port: activePort,
        url,
        dataDir,
        createdAt: startedAt,
      });
    } catch (error) {
      // The peer only loses the fast path; discovery still scans the port range.
      log(`更新锁文件失败：${errorMessage(error)}`);
    }

    writeState(statePath, state);
    log(`listening on ${url} (source ${config.source}, data ${dataDir})`);
  } catch (error) {
    log(`启动失败：${errorMessage(error)}`);
    await closeQuietly(application, log);
    try {
      removeState(statePath);
    } catch {
      // Best effort before the process exits.
    }
    try {
      releaseLock(lockPath, process.pid);
    } catch {
      // Best effort before the process exits.
    }
    throw error;
  }

  const listener = application as RunningApp;
  let stopping: Promise<void> | null = null;
  function shutdown(exitCode: number): Promise<void> {
    if (stopping) return stopping;
    stopping = (async () => {
      log(`shutting down (pid ${process.pid})`);
      try {
        try {
          await listener.close();
        } catch (error) {
          log(`关闭服务失败：${errorMessage(error)}`);
        }
        try {
          removeState(statePath);
        } catch (error) {
          log(`删除状态文件失败：${errorMessage(error)}`);
        }
        try {
          releaseLock(lockPath, process.pid);
        } catch (error) {
          log(`删除锁文件失败：${errorMessage(error)}`);
        }
      } finally {
        process.exit(exitCode);
      }
    })();
    return stopping;
  }

  process.once('SIGINT', () => {
    void shutdown(0);
  });
  process.once('SIGTERM', () => {
    void shutdown(0);
  });
  process.once('SIGHUP', () => {
    void shutdown(0);
  });

  const url = `http://${config.host}:${activePort}`;
  if (!options.noWindow) (input.openWindow ?? openAppWindow)(url);

  return { port: activePort, url, running: true };
}
