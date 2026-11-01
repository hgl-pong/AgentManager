// Ad-hoc visual review: boots the real server against a throwaway home, then writes one PNG per
// tab (light + dark) so the redesign can be eyeballed without a browser window.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const OUT = join(REPO, '.build', 'shots');
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const BROWSER = BROWSERS.find((path) => existsSync(path));
if (!BROWSER) throw new Error('no Chromium browser');

mkdirSync(OUT, { recursive: true });
const root = mkdtempSync(join(tmpdir(), 'am-shot-'));
const home = join(root, 'home');
mkdirSync(join(home, '.agents', 'skills', 'alpha'), { recursive: true });
mkdirSync(join(home, '.agents', 'skills', 'beta'), { recursive: true });
mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
mkdirSync(join(home, '.pi', 'agent', 'skills'), { recursive: true });
writeFileSync(join(home, '.agents', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nv1\n');
writeFileSync(join(home, '.agents', 'skills', 'beta', 'SKILL.md'), '---\nname: beta\n---\nv1\n');
writeFileSync(join(home, '.claude', 'CLAUDE.md'), '# Rules\n\n- keep replies short\n- prefer simple solutions\n');
writeFileSync(join(home, '.codex', 'AGENTS.md'), '# Rules\n\n- keep replies short\n');
writeFileSync(join(home, '.pi', 'agent', 'AGENTS.md'), '# Rules\n');
writeFileSync(
  join(home, '.claude', 'settings.json'),
  JSON.stringify(
    { model: 'gw/alpha-large', permissions: { allow: ['Read', 'Bash(npm run *)'] }, env: { ANTHROPIC_MODEL: 'gw/alpha-large' } },
    null,
    2,
  ),
);
writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gw/alpha-mini"\n');
writeFileSync(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ defaultModel: 'plain-beta' }, null, 2));
mkdirSync(join(home, '.agents', 'mcp'), { recursive: true });
writeFileSync(
  join(home, '.agents', 'mcp', 'servers.json'),
  JSON.stringify(
    {
      servers: {
        filesystem: { transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\work'] },
        'remote-docs': { transport: 'http', url: 'https://example.test/mcp' },
      },
    },
    null,
    2,
  ),
);
writeFileSync(
  join(home, '.claude.json'),
  JSON.stringify({ mcpServers: { filesystem: { command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem', 'C:\\work'] } } }, null, 2),
);
mkdirSync(join(home, '.claude', 'projects', 'proj'), { recursive: true });
writeFileSync(join(home, '.claude', 'projects', 'proj', 's.jsonl'), 'x'.repeat(400));
mkdirSync(join(home, '.claude', 'cache'), { recursive: true });
writeFileSync(join(home, '.claude', 'cache', 'blob.bin'), 'y'.repeat(24000));

const PORT = 8100 + Math.floor(Math.random() * 200);
const CDP = 9500 + Math.floor(Math.random() * 200);
const MODELS_PORT = PORT + 500;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn(
  process.execPath,
  ['server/index.ts', '--data', join(root, 'data'), '--port', String(PORT), '--no-window'],
  {
    cwd: REPO,
    env: { ...process.env, AGENT_MANAGER_HOME: home, AGENT_MANAGER_MODELS_URL: `http://127.0.0.1:${MODELS_PORT}/v1` },
    stdio: 'ignore',
  },
);
const modelStub = createServer((req, res) => {
  if (req.url?.startsWith('/v1/models')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        data: [
          { id: 'gw/alpha-large', name: 'Alpha Large', context_length: 400000, reasoning: { supportsReasoning: true } },
          { id: 'gw/alpha-mini', name: 'Alpha Mini', context_length: 128000, vision: true },
          { id: 'plain-beta', name: 'Beta', context_length: 64000 },
        ],
      }),
    );
    return;
  }
  res.writeHead(404).end();
}).listen(MODELS_PORT, '127.0.0.1');

const edge = spawn(
  BROWSER,
  [
    '--headless=new',
    `--remote-debugging-port=${CDP}`,
    `--user-data-dir=${join(root, 'edge')}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-gpu',
    '--hide-scrollbars',
    '--window-size=1440,940',
    'about:blank',
  ],
  { stdio: 'ignore' },
);

async function waitFor(url) {
  for (let i = 0; i < 200; i += 1) {
    try {
      const r = await fetch(url);
      if (r.ok) return;
    } catch {}
    await sleep(150);
  }
  throw new Error(`timeout ${url}`);
}

let socket;
try {
  await waitFor(`http://127.0.0.1:${PORT}/api/health`);
  await waitFor(`http://127.0.0.1:${CDP}/json/version`);
  const created = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent('about:blank')}`, { method: 'PUT' });
  const target = await created.json();
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    socket.addEventListener('open', res, { once: true });
    socket.addEventListener('error', rej, { once: true });
  });

  let id = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (msg.id === undefined) return;
    const entry = pending.get(msg.id);
    pending.delete(msg.id);
    if (!entry) return;
    msg.error ? entry.reject(new Error(msg.error.message)) : entry.resolve(msg.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const current = ++id;
      pending.set(current, { resolve, reject });
      socket.send(JSON.stringify({ id: current, method, params }));
    });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 940,
    deviceScaleFactor: 1,
    mobile: false,
  });

  const evaluate = async (expression) => {
    const r = await send('Runtime.evaluate', { expression: `(async () => { ${expression} })()`, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? 'eval failed');
    return r.result.value;
  };
  const waitFn = async (body, attempts = 120) => {
    for (let i = 0; i < attempts; i += 1) {
      if (await evaluate(`return Boolean(${body});`)) return;
      await sleep(100);
    }
    throw new Error(`timeout waiting for ${body}`);
  };
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    writeFileSync(join(OUT, `${name}.png`), Buffer.from(r.data, 'base64'));
    console.log('wrote', `${name}.png`);
  };

  const tabs = ['skills', 'store', 'mcp', 'hooks', 'prompts', 'settings', 'cache'];

  for (const theme of ['light', 'dark']) {
    await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/#skills` });
    await waitFn(`document.querySelector('.app-shell')`);
    // Switch through the app's own control: the seeded localStorage above is only read at mount,
    // and re-navigating to the same URL does not remount anything.
    const label = theme === 'light' ? '浅色' : '深色';
    await evaluate(`
      const button = [...document.querySelectorAll('.theme-switch button')]
        .find((b) => b.textContent.trim() === '${label}');
      if (!button) throw new Error('theme button not found: ${label}');
      button.click();
      return true;
    `);
    await evaluate(`if (document.documentElement.dataset.theme !== '${theme}') throw new Error('theme did not apply: ' + document.documentElement.dataset.theme); return true;`);
    await waitFn(`document.querySelector('table tbody tr')`);

    for (const tab of tabs) {
      await evaluate(`location.hash = '${tab}'; return true;`);
      await waitFn(`location.hash === '#${tab}'`);
      await sleep(tab === 'settings' ? 1400 : 900);
      if (tab === 'settings') {
        await waitFn(`document.querySelector('.settings-page')`);
        await sleep(600);
      }
      if (tab === 'store') {
        // The registry answers over the network, so wait for rows instead of a fixed sleep.
        await waitFn(`document.querySelector('.store-card, .mcpm-empty, .store-page .error, .store-page .warning')`, 300);
        await sleep(400);
        // The pager sits below the fold; bring it into view so the shot proves it is there.
        await evaluate(`document.querySelector('.store-pager')?.scrollIntoView({block: 'center'}); return true;`);
        await sleep(300);
      }
      await shot(`${theme}-${tab}`);

      if (tab === 'settings') {
        // The models panel and the raw editor are the two densest screens.
        await evaluate(`
          const items = [...document.querySelectorAll('.settings-nav .nav-item')];
          const models = items.find((b) => b.textContent.trim().startsWith('模型'));
          models?.click();
          return true;
        `);
        await sleep(900);
        await shot(`${theme}-settings-models`);
        await evaluate(`
          const items = [...document.querySelectorAll('.settings-nav .nav-item')];
          const raw = items.find((b) => b.textContent.trim().startsWith('原始文件'));
          raw?.click();
          return true;
        `);
        await sleep(700);
        await shot(`${theme}-settings-raw`);
        await evaluate(`
          const items = [...document.querySelectorAll('.settings-nav .nav-item')];
          const common = items.find((b) => b.textContent.trim().startsWith('常用'));
          common?.click();
          return true;
        `);
        await sleep(500);
      }
    }

    // The confirm dialog is a first-class surface; capture it on the cache page.
    await evaluate(`location.hash = 'cache'; return true;`);
    await waitFn(`document.querySelector('.toolbar select')`);
    await sleep(800);
    await evaluate(`
      const row = [...document.querySelectorAll('table tbody tr')].find((r) => r.innerText.includes('会话记录'));
      const button = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '清理');
      button?.click();
      return true;
    `);
    await waitFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
    await sleep(400);
    await shot(`${theme}-dialog`);
    await evaluate(`document.querySelector('dialog.confirm-dialog').dispatchEvent(new Event('cancel', {cancelable:true})); return true;`);
    await sleep(300);
  }
} catch (error) {
  console.error('FAILED:', error.message);
  process.exitCode = 1;
} finally {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/app/quit`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
    }).catch(() => {});
  } catch {}
  socket?.close();
  edge.kill();
  server.kill();
  modelStub.close();
  await sleep(400);
}
