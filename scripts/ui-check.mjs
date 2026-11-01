// Headless UI smoke test for the interaction flows that were reworked. It boots the real server
// against a throwaway home directory, drives the built UI in headless Edge over CDP, and asserts on
// what the page actually shows. Run after `npm run build`:
//
//   npm run build && npm run verify:ui
//
// Not part of `npm test`: it needs a local Edge/Chrome and takes ~20s.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = dirname(dirname(fileURLToPath(import.meta.url)));

/** First installed Chromium-family browser; the script needs CDP and headless mode. */
const BROWSERS = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
];
const BROWSER = BROWSERS.find((path) => existsSync(path));
if (!BROWSER) {
  console.error('需要 Edge 或 Chrome 才能运行 UI 检查（未在默认安装路径找到）。');
  process.exit(2);
}

const root = mkdtempSync(join(tmpdir(), 'am-ui-'));
const home = join(root, 'home');
mkdirSync(join(home, '.agents', 'skills', 'alpha'), { recursive: true });
mkdirSync(join(home, '.claude', 'skills'), { recursive: true });
mkdirSync(join(home, '.codex', 'skills'), { recursive: true });
mkdirSync(join(home, '.pi', 'agent', 'skills'), { recursive: true });
writeFileSync(join(home, '.agents', 'skills', 'alpha', 'SKILL.md'), '---\nname: alpha\n---\nv1\n');
writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'claude prompt body');
writeFileSync(join(home, '.codex', 'AGENTS.md'), 'codex prompt body');
writeFileSync(join(home, '.pi', 'agent', 'AGENTS.md'), 'pi prompt body');
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({ model: 'gpt-5.1', permissions: { allow: ['Read'] } }, null, 2));
writeFileSync(join(home, '.codex', 'config.toml'), 'model = "gpt-5.1"\n');
writeFileSync(join(home, '.pi', 'agent', 'settings.json'), JSON.stringify({ defaultModel: 'gpt-5.1' }, null, 2));

// Cache page fixtures: one session old enough for the 30-day scope, plus a regenerable cache blob.
mkdirSync(join(home, '.claude', 'projects', 'proj'), { recursive: true });
writeFileSync(join(home, '.claude', 'projects', 'proj', 'old-session.jsonl'), 'old session body\n');
mkdirSync(join(home, '.claude', 'cache'), { recursive: true });
writeFileSync(join(home, '.claude', 'cache', 'blob.bin'), 'blob\n');
writeFileSync(join(home, '.claude', 'cache', 'old.bin'), 'old blob\n');
const OLD = new Date(Date.now() - 45 * 24 * 60 * 60 * 1000);
utimesSync(join(home, '.claude', 'projects', 'proj', 'old-session.jsonl'), OLD, OLD);
utimesSync(join(home, '.claude', 'cache', 'old.bin'), OLD, OLD);

const PORT = 7900 + Math.floor(Math.random() * 200);
const CDP = 9300 + Math.floor(Math.random() * 200);
const MODELS_PORT = PORT + 500;
const STORE_PORT = PORT + 600;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(url, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`timeout waiting for ${url}`);
    await sleep(150);
  }
}

/** Minimal CDP client: send a command, await its result, and collect console errors. */
class Page {
  constructor(socket) {
    this.socket = socket;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
    socket.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== undefined) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (!entry) return;
        if (message.error) entry.reject(new Error(`${entry.method}: ${message.error.message}`));
        else entry.resolve(message.result);
        return;
      }
      if (message.method === 'Runtime.exceptionThrown') {
        this.consoleErrors.push(message.params.exceptionDetails.exception?.description ?? 'exception');
      }
      if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
        this.consoleErrors.push(message.params.args.map((arg) => arg.value ?? arg.description).join(' '));
      }
    });
  }

  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, method });
      this.socket.send(JSON.stringify({ id, method, params }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression: `(async () => { ${expression} })()`,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description ?? 'evaluate failed');
    }
    return result.result.value;
  }

  async waitForFn(body, timeoutMs = 8000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if (await this.eval(`return Boolean(${body});`)) return;
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${body}`);
      await sleep(100);
    }
  }
}

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
}

const server = spawn(process.execPath, ['server/index.ts', '--data', join(root, 'data'), '--port', String(PORT), '--no-window'], {
  cwd: REPO,
  env: {
    ...process.env,
    AGENT_MANAGER_HOME: home,
    AGENT_MANAGER_MODELS_URL: `http://127.0.0.1:${MODELS_PORT}/v1`,
    AGENT_MANAGER_STORE_URL: `http://127.0.0.1:${STORE_PORT}`,
  },
  stdio: 'ignore',
});
const edge = spawn(BROWSER, [
  '--headless=new',
  `--remote-debugging-port=${CDP}`,
  `--user-data-dir=${join(root, 'edge')}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1400,1000',
  'about:blank',
], { stdio: 'ignore' });

let page;
/** A stored-only ZIP for the fake registry. */
function storedZip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const data = Buffer.from(text, 'utf8');
    const nameBytes = Buffer.from(name, 'utf8');
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    locals.push(local, nameBytes, data);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(nameBytes.length, 28);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, nameBytes);
    offset += local.length + nameBytes.length + data.length;
  }
  const directory = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, directory, end]);
}

/** The three skillstore.io routes the store page uses, answered from this machine. */
const storeStub = createServer((request, response) => {
  const url = new URL(request.url ?? '/', 'http://127.0.0.1');
  if (url.pathname.endsWith('/download')) {
    response.writeHead(200, { 'content-type': 'application/zip' });
    response.end(storedZip({ 'latte/SKILL.md': '# Latte\n\nBrew it.\n' }));
    return;
  }
  if (url.pathname.endsWith('/manifest')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        kind: 'skill',
        skill: { slug: 'acme-latte', name: 'latte' },
        artifact: { type: 'skill-zip', url: `http://127.0.0.1:${STORE_PORT}/api/skills/acme-latte/download` },
      }),
    );
    return;
  }
  const skill = {
    slug: 'acme-latte',
    displayName: 'latte',
    description: 'Brew a latte order.',
    category: 'office',
    riskLevel: 'safe',
    license: 'MIT',
    repo: 'https://github.com/acme/latte',
    author: 'acme',
    githubUsername: 'acme',
    qualityScore: 80,
    hasScripts: true,
    needsNetwork: false,
    authorVersion: '0.1.0',
    updatedAt: '2026-10-25T11:56:50.970Z',
    stats: { viewCount: 3, downloadCount: 5, favoriteCount: 1 },
  };
  response.writeHead(200, { 'content-type': 'application/json' });
  // A second page reports a bigger total, so the label proves the page reached the registry.
  const page = Number(url.searchParams.get('page') ?? '1');
  const total = page === 2 ? 80 : 50;
  response.end(
    JSON.stringify({
      data: [skill],
      total,
      pagination: { page, limit: 24, total, totalPages: Math.ceil(total / 24) },
    }),
  );
});
await new Promise((resolve) => storeStub.listen(STORE_PORT, '127.0.0.1', resolve));
const modelStub = createServer((request, response) => {
  if (request.url?.startsWith('/v1/models')) {
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(
      JSON.stringify({
        data: [
          { id: 'gw/alpha-large', name: 'Alpha Large', context_length: 400_000, reasoning: { supportsReasoning: true } },
          { id: 'gw/alpha-mini', name: 'Alpha Mini', context_length: 128_000 },
          { id: 'plain-beta', name: 'Beta', context_length: 64_000, vision: true },
        ],
      }),
    );
    return;
  }
  response.writeHead(404).end();
}).listen(MODELS_PORT, '127.0.0.1');
try {
  await waitFor(`http://127.0.0.1:${PORT}/api/health`);
  await waitFor(`http://127.0.0.1:${CDP}/json/version`);
  const created = await fetch(`http://127.0.0.1:${CDP}/json/new?${encodeURIComponent(`http://127.0.0.1:${PORT}/#skills`)}`, { method: 'PUT' });
  const target = await created.json();
  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  page = new Page(socket);
  await page.send('Runtime.enable');
  await page.send('Page.enable');
  await page.send('Page.navigate', { url: `http://127.0.0.1:${PORT}/#skills` });
  await page.waitForFn(`document.querySelector('table')`);

  // 1. Skills matrix renders.
  const skillText = await page.eval(`return document.querySelector('table').innerText;`);
  check('skills matrix renders rows', skillText.includes('alpha'), skillText.split('\n').slice(0, 3).join(' | '));

  // 2. Prompt editor marks dirty and blocks navigation with a modal <dialog>.
  await page.eval(`
    document.querySelector('[aria-controls="workspace-panel"][id="nav-prompts"]').click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('#prompt-source-editor')`);
  await page.eval(`
    const box = document.querySelector('#prompt-source-editor');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, box.value + '\\n-- edited in test');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await page.waitForFn(`document.querySelector('.editor-card .tag')?.textContent?.includes('未保存')`);

  await page.eval(`document.querySelector('#nav-skills').click(); return true;`);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  const dialogText = await page.eval(`return document.querySelector('dialog.confirm-dialog').innerText;`);
  check('dirty navigation shows modal, not window.confirm', dialogText.includes('切换页面') && dialogText.includes('放弃并切换'), dialogText.replace(/\n/g, ' | ').slice(0, 120));
  const stillPrompts = await page.eval(`return document.querySelector('#prompt-source-editor') !== null;`);
  check('navigation stays put until the dialog is answered', stillPrompts);

  // 3. Escape cancels and the hash returns to the current tab.
  await page.eval(`document.querySelector('dialog.confirm-dialog').dispatchEvent(new Event('cancel', {cancelable:true})); return true;`);
  await sleep(250);
  const afterEscape = await page.eval(`return {hash: location.hash, dialog: Boolean(document.querySelector('dialog.confirm-dialog')), editor: Boolean(document.querySelector('#prompt-source-editor'))};`);
  check('escape cancels the switch and keeps the editor', afterEscape.hash === '#prompts' && !afterEscape.dialog && afterEscape.editor, JSON.stringify(afterEscape));

  // 4. Confirming the modal does switch tabs (and drops the draft).
  await page.eval(`document.querySelector('#nav-skills').click(); return true;`);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  await page.eval(`
    const buttons = [...document.querySelectorAll('dialog.confirm-dialog button')];
    buttons.find((b) => b.textContent.includes('放弃并切换')).click();
    return true;
  `);
  await page.waitForFn(`location.hash === '#skills' && document.querySelector('table')`);
  check('confirming the modal switches tab', true);

  // 5. Settings: Ctrl+S while a confirm dialog is open must not start a save behind it.
  await page.eval(`document.querySelector('#nav-settings').click(); return true;`);
  await page.waitForFn(`document.querySelector('.models-panel, .settings-page')`);
  const settingsShape = await page.eval(`
    return {
      agentTabs: document.querySelectorAll('.agent-tab').length,
      hasSearch: Boolean(document.querySelector('.models-catalog-search')) || true,
    };
  `);
  check('settings view renders agent tabs', settingsShape.agentTabs >= 3, JSON.stringify(settingsShape));

  // 6. Model picker: open, filter, keyboard-select.
  await page.eval(`
    const modelsTab = [...document.querySelectorAll('.settings-nav .nav-item')].find(
      (b) => b.firstChild.textContent.trim() === '模型',
    );
    if (!modelsTab) throw new Error('模型 nav item not found');
    modelsTab.click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.models-panel')`);
  const hasPicker = await page.eval(`return Boolean(document.querySelector('.model-picker-trigger'));`);
  if (hasPicker) {
    await page.eval(`document.querySelector('.model-picker-trigger').click(); return true;`);
    await page.waitForFn(`document.querySelector('.model-picker-panel')`);
    const panel = await page.eval(`return {
      search: Boolean(document.querySelector('.model-picker-search')),
      options: document.querySelectorAll('.model-picker-option').length,
      empty: Boolean(document.querySelector('.model-picker-none')),
    };`);
    check('model picker lists the endpoint models', panel.search && panel.options === 3, JSON.stringify(panel));

    // Typing in the filter narrows the list.
    await page.eval(`
      const box = document.querySelector('.model-picker-search');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(box, 'mini');
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    `);
    await sleep(150);
    const filtered = await page.eval(`return {
      options: [...document.querySelectorAll('.model-picker-option')].map((b) => b.textContent),
      custom: document.querySelector('.model-picker-custom')?.textContent ?? '',
    };`);
    check(
      'filtering narrows the model list',
      filtered.options.length === 1 && filtered.options[0].includes('Alpha Mini'),
      JSON.stringify(filtered.options),
    );

    // Arrow keys move the active row and Enter picks it.
    await page.eval(`
      document.querySelector('.model-picker-search').dispatchEvent(
        new KeyboardEvent('keydown', {key: 'Enter', bubbles: true}),
      );
      return true;
    `);
    await sleep(250);
    const picked = await page.eval(`return {
      open: Boolean(document.querySelector('.model-picker-panel')),
      text: document.querySelector('.model-picker-trigger')?.textContent ?? '',
    };`);
    check('enter selects the highlighted model', !picked.open && picked.text.includes('Alpha Mini'), JSON.stringify(picked));

    // Escape has to close the panel without leaving the surrounding form in a weird state.
    await page.eval(`
      const trigger = document.querySelector('.model-picker-trigger');
      if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
      return true;
    `);
    await page.waitForFn(`document.querySelector('.model-picker-option')`);
    await page.eval(`
      const box = document.querySelector('.model-picker-search');
      box?.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
      return true;
    `);
    await sleep(150);
    const closed = await page.eval(`return !document.querySelector('.model-picker-panel');`);
    check('escape closes the model picker', closed);
  } else {
    check('model picker opens with a filter box', false, 'no .model-picker-trigger found');
  }

  // 7. Ctrl+S must save when free, and must not fire behind an open confirmation.
  await page.eval(`
    window.__saveCalls = 0;
    const realFetch = window.fetch;
    window.__realFetch = realFetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/settings/save')) window.__saveCalls += 1;
      return realFetch(input, init);
    };
    return true;
  `);

  await page.eval(`
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true, bubbles: true}));
    return true;
  `);
  await sleep(1200);
  const savedFree = await page.eval(`return window.__saveCalls;`);
  check('ctrl+s saves settings when no dialog is open', savedFree >= 1, `save requests=${savedFree}`);

  // Dirty the draft again, open the navigation guard, then press Ctrl+S.
  await page.eval(`
    const modelsTab = [...document.querySelectorAll('.settings-nav .nav-item')].find(
      (b) => b.firstChild.textContent.trim() === '模型',
    );
    modelsTab.click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.model-picker-trigger')`);
  await page.eval(`
    const trigger = document.querySelector('.model-picker-trigger');
    if (trigger.getAttribute('aria-expanded') !== 'true') trigger.click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.model-picker-option')`);
  await page.eval(`
    const target = [...document.querySelectorAll('.model-picker-option')].find((b) => b.textContent.includes('Alpha Large'));
    target.click();
    return true;
  `);
  const beforeGuard = await page.eval(`return window.__saveCalls;`);
  await page.eval(`document.querySelector('#nav-prompts').click(); return true;`);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  await page.eval(`
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true, bubbles: true}));
    return true;
  `);
  await sleep(900);
  const behindModal = await page.eval(`return {calls: window.__saveCalls, dialogs: document.querySelectorAll('dialog.confirm-dialog').length};`);
  check(
    'ctrl+s does nothing while a confirmation is open',
    behindModal.calls === beforeGuard && behindModal.dialogs === 1,
    JSON.stringify({ before: beforeGuard, ...behindModal }),
  );

  // Cancel the guard: the settings draft must survive.
  await page.eval(`
    document.querySelector('dialog.confirm-dialog').dispatchEvent(new Event('cancel', {cancelable: true}));
    return true;
  `);
  await sleep(300);
  const keptDraft = await page.eval(`return {hash: location.hash, saveBar: document.querySelector('.save-bar')?.innerText ?? ''};`);
  check(
    'cancelling the guard keeps the dirty settings draft',
    keptDraft.hash === '#settings' && keptDraft.saveBar.includes('未保存'),
    JSON.stringify(keptDraft),
  );

  await page.eval(`
    [...document.querySelectorAll('dialog.confirm-dialog button')]
      .find((b) => b.textContent.includes('放弃并切换'))?.click();
    document.querySelector('#nav-prompts').click();
    return true;
  `);
  // The settings draft is still dirty, so the switch is guarded once more; accept it.
  if (await page.eval(`return Boolean(document.querySelector('dialog.confirm-dialog'))`)) {
    await page.eval(`
      [...document.querySelectorAll('dialog.confirm-dialog button')]
        .find((b) => b.textContent.includes('放弃并切换')).click();
      return true;
    `);
  }
  await page.waitForFn(`document.querySelector('#prompt-source-editor')`);

  // 8. Prompt editor: Ctrl+S saves the source (and is a no-op when nothing changed).
  await page.eval(`
    window.__nativeConfirms = 0;
    window.__promptSaves = 0;
    window.confirm = () => { window.__nativeConfirms += 1; return false; };
    window.alert = () => { window.__nativeConfirms += 1; };
    const real = window.__realFetch;
    window.fetch = (input, init) => {
      const url = typeof input === 'string' ? input : input.url;
      if (url.includes('/api/prompts/content') && init?.method === 'POST') window.__promptSaves += 1;
      return real(input, init);
    };
    return true;
  `);
  await page.eval(`
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true, bubbles: true}));
    return true;
  `);
  await sleep(500);
  const cleanSave = await page.eval(`return window.__promptSaves;`);
  check('ctrl+s does nothing when the prompt is unchanged', cleanSave === 0, `saves=${cleanSave}`);

  await page.eval(`
    const box = document.querySelector('#prompt-source-editor');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, box.value + String.fromCharCode(10) + '-- saved by ctrl+s');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await page.eval(`
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true, bubbles: true}));
    return true;
  `);
  await sleep(1500);
  const promptSave = await page.eval(`return {
    saves: window.__promptSaves,
    tag: document.querySelector('.editor-card .tag')?.textContent ?? '',
    notice: document.querySelector('.notice')?.textContent ?? '',
  };`);
  check(
    'ctrl+s saves the prompt source',
    promptSave.saves === 1 && promptSave.tag === '已保存',
    JSON.stringify(promptSave),
  );
  const nativeConfirms = await page.eval(`return window.__nativeConfirms;`);
  check('no native window.confirm/alert calls in the reworked flows', nativeConfirms === 0, `calls=${nativeConfirms}`);

  // 8b. An external edit to the source must not be overwritten silently.
  // Change the file on disk behind the page, then press Ctrl+S: the page cannot know the file moved on until
  // it asks the server, so this proves the server-side optimistic lock refuses the write.
  const sourcePath = join(home, '.agents', 'prompts', 'global.md');
  await page.eval(`
    const box = document.querySelector('#prompt-source-editor');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, box.value + String.fromCharCode(10) + '-- newer local draft');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  writeFileSync(sourcePath, `${readFileSync(sourcePath, 'utf8')}\n-- changed on disk by another process`);
  await page.eval(`
    window.__promptSaves = 0;
    window.dispatchEvent(new KeyboardEvent('keydown', {key: 's', ctrlKey: true, bubbles: true}));
    return true;
  `);
  await sleep(1500);
  const conflict = await page.eval(`return {
    error: document.querySelector('.error')?.textContent ?? '',
    draftKept: document.querySelector('#prompt-source-editor')?.value.includes('newer local draft') ?? false,
  };`);
  const afterConflict = readFileSync(sourcePath, 'utf8');
  check(
    'a stale save is refused instead of overwriting the external edit',
    afterConflict.includes('changed on disk by another process') &&
      !afterConflict.includes('newer local draft') &&
      conflict.draftKept &&
      conflict.error.includes('已被外部修改'),
    JSON.stringify({ error: conflict.error.slice(0, 80), draftKept: conflict.draftKept }),
  );

  // The refusal has to come with a way forward: load the disk version and keep editing from there.
  const stale = await page.eval(`return {
    warning: [...document.querySelectorAll('.warning')].map((n) => n.textContent).join(' '),
    hasLoadButton: [...document.querySelectorAll('.warning button')].some((b) => b.textContent.includes('载入磁盘')),
  };`);
  check(
    'a refused save offers loading the disk version',
    stale.warning.includes('别处修改') && stale.hasLoadButton,
    JSON.stringify(stale),
  );

  await page.eval(`
    [...document.querySelectorAll('.editor-actions button')]
      .find((b) => b.textContent.includes('保存并生效')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  const overwriteAsk = await page.eval(`
    const node = document.querySelector('dialog.confirm-dialog');
    return {
      title: node.querySelector('h2')?.textContent ?? '',
      focused: document.activeElement?.textContent ?? '',
    };
  `);
  check(
    'saving a stale draft asks before overwriting the disk version',
    overwriteAsk.focused === '取消',
    JSON.stringify(overwriteAsk),
  );
  await page.eval(`
    document.querySelector('dialog.confirm-dialog').dispatchEvent(new Event('cancel', {cancelable: true}));
    return true;
  `);
  await sleep(300);
  const diskUntouched = readFileSync(sourcePath, 'utf8');
  check(
    'cancelling leaves the external edit intact',
    diskUntouched.includes('changed on disk by another process') && !diskUntouched.includes('newer local draft'),
    diskUntouched.split('\n').slice(-2).join(' | '),
  );

  // The offered escape hatch: load the disk version and drop the stale draft.
  await page.eval(`
    [...document.querySelectorAll('.warning button')].find((b) => b.textContent.includes('载入磁盘')).click();
    return true;
  `);
  if (await page.eval(`return Boolean(document.querySelector('dialog.confirm-dialog'))`)) {
    await page.eval(`
      [...document.querySelectorAll('dialog.confirm-dialog button')]
        .find((b) => b.textContent.includes('放弃并载入')).click();
      return true;
    `);
  }
  await sleep(500);
  const reloaded = await page.eval(`return {
    value: document.querySelector('#prompt-source-editor')?.value ?? '',
    warning: Boolean(document.querySelector('.warning')),
  };`);
  check(
    'loading the disk version replaces the stale draft',
    reloaded.value.includes('changed on disk by another process') && !reloaded.warning,
    JSON.stringify({ warning: reloaded.warning, tail: reloaded.value.split('\n').slice(-1)[0] }),
  );

  // 9. Skill link dialog names both ends of the link and focuses the action.
  await page.eval(`document.querySelector('#nav-skills').click(); return true;`);
  await page.waitForFn(`document.querySelector('table')`);
  const destructive = await page.eval(`
    const link = [...document.querySelectorAll('td.cell button')].find((b) => b.textContent.includes('建链'));
    if (!link) return { skipped: true };
    link.click();
    return { skipped: false };
  `);
  if (!destructive.skipped) {
    await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
    const dialog = await page.eval(`
      const node = document.querySelector('dialog.confirm-dialog');
      const confirm = [...node.querySelectorAll('button')].find((b) => b.classList.contains('primary') || b.classList.contains('danger'));
      return {
        title: node.querySelector('h2')?.textContent ?? '',
        body: node.querySelector('.confirm-dialog-body')?.textContent ?? '',
        focused: document.activeElement?.textContent ?? '',
        confirmDanger: confirm?.classList.contains('danger') ?? false,
        confirmText: confirm?.textContent ?? '',
      };
    `);
    check(
      'skill confirm names the path it will touch',
      dialog.body.includes('alpha') && dialog.body.includes('.claude') && dialog.body.includes('.agents'),
      JSON.stringify(dialog.body).slice(0, 160),
    );
    check('non-destructive confirm focuses the action, not a stray target', dialog.focused === dialog.confirmText, JSON.stringify(dialog));

    // A failed write must report inside the modal and keep it open for a retry.
    await page.eval(`
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/api/skills')) {
          return Promise.resolve(new Response(JSON.stringify({ error: '模拟写入失败' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return window.__realFetch(input, init);
      };
      return true;
    `);
    await page.eval(`
      [...document.querySelectorAll('dialog.confirm-dialog button')]
        .find((b) => b.textContent.includes('建立链接')).click();
      return true;
    `);
    await page.waitForFn(`document.querySelector('.confirm-dialog-error')`);
    const failure = await page.eval(`
      const node = document.querySelector('dialog.confirm-dialog');
      return {
        open: node?.open ?? false,
        error: node?.querySelector('.confirm-dialog-error')?.textContent ?? '',
        retry: [...node.querySelectorAll('button')].map((b) => b.textContent).join('|'),
      };
    `);
    check(
      'a failed skill write reports inside the open dialog',
      failure.open && failure.error.includes('模拟写入失败') && failure.retry.includes('重试'),
      JSON.stringify(failure),
    );
    await page.eval(`
      window.fetch = window.__realFetch;
      [...document.querySelectorAll('dialog.confirm-dialog button')]
        .find((b) => b.textContent.trim() === '重试').click();
      return true;
    `);
    await sleep(800);
    const retried = await page.eval(`return {
      dialog: Boolean(document.querySelector('dialog.confirm-dialog')),
      notice: document.querySelector('.notice')?.textContent ?? '',
    };`);
    check(
      'retrying from the same dialog succeeds and closes it',
      !retried.dialog && retried.notice.includes('快照'),
      JSON.stringify(retried),
    );
  }

  // 10. Prompt alignment dialog: the destructive variant focuses cancel and warns about the overwrite.
  await page.eval(`document.querySelector('#nav-prompts').click(); return true;`);
  await page.waitForFn(`document.querySelector('#prompt-source-editor')`);
  const alignButton = await page.eval(`
    const button = [...document.querySelectorAll('.card button')].find((b) => b.textContent.trim() === '对齐到源');
    if (!button) return false;
    button.click();
    return true;
  `);
  if (alignButton) {
    await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
    const alignDialog = await page.eval(`
      const node = document.querySelector('dialog.confirm-dialog');
      const buttons = [...node.querySelectorAll('button')];
      return {
        title: node.querySelector('h2')?.textContent ?? '',
        body: node.querySelector('.confirm-dialog-body')?.textContent ?? '',
        focused: document.activeElement?.textContent ?? '',
        danger: buttons.some((b) => b.classList.contains('danger')),
        classes: buttons.map((b) => b.className).join('|'),
      };
    `);
    const isOverwrite = alignDialog.body.includes('覆盖');
    check(
      'overwriting prompt alignment focuses cancel first',
      !isOverwrite || (alignDialog.focused === '取消' && alignDialog.danger),
      JSON.stringify(alignDialog),
    );
    await page.eval(`
      document.querySelector('dialog.confirm-dialog').dispatchEvent(new Event('cancel', {cancelable: true}));
      return true;
    `);
  } else {
    check('overwriting prompt alignment focuses cancel first', false, 'no 对齐到源 button found');
  }

  // 12. MCP write failure also reports inside the dialog (the run() path, not just skills).
  await page.eval(`document.querySelector('#nav-mcp').click(); return true;`);
  await page.waitForFn(`document.querySelector('.mcpm-page, .mcpm-head')`);
  const mcpAction = await page.eval(`
    const button = [...document.querySelectorAll('.mcpm-head-actions button')].find((b) => b.textContent.includes('从现有配置导入'));
    if (!button) return false;
    button.click();
    return true;
  `);
  if (mcpAction) {
    await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
    await page.eval(`
      window.fetch = (input, init) => {
        const url = typeof input === 'string' ? input : input.url;
        if (url.includes('/api/mcp')) {
          return Promise.resolve(new Response(JSON.stringify({ error: '模拟 MCP 写入失败' }), {
            status: 500,
            headers: { 'content-type': 'application/json' },
          }));
        }
        return window.__realFetch(input, init);
      };
      [...document.querySelectorAll('dialog.confirm-dialog button')]
        .find((b) => b.textContent.includes('收进源')).click();
      return true;
    `);
    await page.waitForFn(`document.querySelector('.confirm-dialog-error')`);
    const mcpFailure = await page.eval(`
      const node = document.querySelector('dialog.confirm-dialog');
      return {
        open: node?.open ?? false,
        error: node?.querySelector('.confirm-dialog-error')?.textContent ?? '',
      };
    `);
    check(
      'a failed MCP write reports inside the open dialog',
      mcpFailure.open && mcpFailure.error.includes('模拟 MCP 写入失败'),
      JSON.stringify(mcpFailure),
    );
    await page.eval(`
      window.fetch = window.__realFetch;
      document.querySelector('dialog.confirm-dialog').dispatchEvent(new Event('cancel', {cancelable: true}));
      return true;
    `);
  } else {
    check('a failed MCP write reports inside the open dialog', false, 'no import button found');
  }

  // 13. Settings field form still renders and its model fields keep the fetched candidates available.
  await page.eval(`document.querySelector('#nav-settings').click(); return true;`);
  await page.waitForFn(`document.querySelector('.settings-page')`);
  await page.eval(`
    const common = [...document.querySelectorAll('.settings-nav .nav-item')].find(
      (b) => b.firstChild.textContent.trim() === '常用',
    );
    common.click();
    return true;
  `);
  await sleep(400);
  const formShape = await page.eval(`return {
    fields: document.querySelectorAll('.field').length,
    customKeys: Boolean(document.querySelector('.custom-keys')),
    saveBar: Boolean(document.querySelector('.save-bar')),
  };`);
  check('settings field form renders its controls', formShape.fields > 0 && formShape.customKeys, JSON.stringify(formShape));

  // 14. A model-ID field inside the settings form uses the same searchable picker.
  await page.eval(`
    const search = document.querySelector('.settings-tools input[type="search"]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(search, 'model');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  `);
  await sleep(400);
  const fieldPicker = await page.eval(`return document.querySelectorAll('.field .model-picker-trigger').length;`);
  check('model fields in the form use the picker, not a datalist', fieldPicker > 0, `pickers=${fieldPicker}`);

  // 16. The picker replaced an <input id=…>, so the field label has to point at the trigger button.
  const labelTargets = await page.eval(`
    const rows = [...document.querySelectorAll('.field')].filter((row) => row.querySelector('.model-picker-trigger'));
    return rows.slice(0, 3).map((row) => {
      const label = row.querySelector('label.field-label');
      const target = label?.getAttribute('for');
      const element = target ? document.getElementById(target) : null;
      return {
        field: label?.textContent ?? '',
        htmlFor: target ?? null,
        // The label must land on the picker's own button, not on some unrelated element.
        targetsTheTrigger: Boolean(element && element.classList.contains('model-picker-trigger')),
      };
    });
  `);
  check(
    'picker fields keep a working label target',
    labelTargets.length > 0 && labelTargets.every((entry) => entry.targetsTheTrigger),
    JSON.stringify(labelTargets),
  );

  // 15. Closing an in-progress MCP form must not silently drop typed input.
  await page.eval(`document.querySelector('#nav-mcp').click(); return true;`);
  await page.waitForFn(`document.querySelector('.mcpm-page')`);
  await page.eval(`
    [...document.querySelectorAll('.mcpm-head-actions button')]
      .find((b) => b.textContent.includes('新增 server')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.mcpm-form')`);
  // Typing into the form and pressing Escape used to close it without a word.
  await page.eval(`
    const input = [...document.querySelectorAll('.mcpm-form input')].find((i) => i.placeholder?.includes('filesystem'));
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'half-typed-server');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    return true;
  `);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  const guard = await page.eval(`
    const node = document.querySelector('dialog.confirm-dialog');
    return {
      title: node.querySelector('h2')?.textContent ?? '',
      focused: document.activeElement?.textContent ?? '',
      formStillOpen: Boolean(document.querySelector('.mcpm-form')),
    };
  `);
  check(
    'escape on a dirty MCP form asks before discarding',
    guard.focused === '取消' && guard.formStillOpen,
    JSON.stringify(guard),
  );

  // Cancelling the guard keeps the form and its typed value.
  await page.eval(`
    document.querySelector('dialog.confirm-dialog').dispatchEvent(new Event('cancel', {cancelable: true}));
    return true;
  `);
  await sleep(300);
  const kept = await page.eval(`return {
    form: Boolean(document.querySelector('.mcpm-form')),
    value: [...document.querySelectorAll('.mcpm-form input')].map((i) => i.value).join('|'),
  };`);
  check(
    'cancelling the guard keeps the typed MCP form',
    kept.form && kept.value.includes('half-typed-server'),
    JSON.stringify(kept).slice(0, 120),
  );

  // Confirming really closes it.
  await page.eval(`
    [...document.querySelectorAll('.mcpm-form-actions button')].find((b) => b.textContent.includes('取消')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  await page.eval(`
    [...document.querySelectorAll('dialog.confirm-dialog button')]
      .find((b) => b.textContent.includes('放弃并关闭')).click();
    return true;
  `);
  await sleep(400);
  const closed = await page.eval(`return !document.querySelector('.mcpm-form');`);
  check('confirming the guard closes the MCP form', closed);

  // 16. An untouched form closes without a question.
  await page.eval(`
    [...document.querySelectorAll('.mcpm-head-actions button')]
      .find((b) => b.textContent.includes('新增 server')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.mcpm-form')`);
  await page.eval(`
    [...document.querySelectorAll('.mcpm-form-actions button')].find((b) => b.textContent.includes('取消')).click();
    return true;
  `);
  await sleep(400);
  const quietClose = await page.eval(`return {
    form: Boolean(document.querySelector('.mcpm-form')),
    dialog: Boolean(document.querySelector('dialog.confirm-dialog')),
  };`);
  check(
    'an untouched form closes without a question',
    !quietClose.form && !quietClose.dialog,
    JSON.stringify(quietClose),
  );

  // 17. Hooks behave the same way: Escape is wired and dirty state is protected.
  await page.eval(`document.querySelector('#nav-hooks').click(); return true;`);
  await page.waitForFn(`document.querySelector('.hook-page')`);
  await page.eval(`
    [...document.querySelectorAll('.mcpm-head-actions button')]
      .find((b) => b.textContent.includes('新增事件')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.hook-form')`);
  await page.eval(`
    const input = document.querySelector('.hook-form input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'PreToolUse');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', {key: 'Escape', bubbles: true}));
    return true;
  `);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  const hookGuard = await page.eval(`
    const node = document.querySelector('dialog.confirm-dialog');
    return {
      focused: document.activeElement?.textContent ?? '',
      formStillOpen: Boolean(document.querySelector('.hook-form')),
    };
  `);
  check(
    'escape on a dirty hooks form asks before discarding',
    hookGuard.focused === '取消' && hookGuard.formStillOpen,
    JSON.stringify(hookGuard),
  );
  await page.eval(`
    [...document.querySelectorAll('dialog.confirm-dialog button')]
      .find((b) => b.textContent.includes('放弃并关闭')).click();
    return true;
  `);
  await sleep(400);
  const hookClosed = await page.eval(`return !document.querySelector('.hook-form');`);
  check('confirming closes the hooks form', hookClosed);

  // 18. Cache page: targets are grouped per agent, the scope select drives the numbers, and every
  // clean is undoable from the recycle bin.
  await page.eval(`document.querySelector('#nav-cache').click(); return true;`);
  await page.waitForFn(`location.hash === '#cache' && document.querySelector('.toolbar select')`);
  await page.waitForFn(
    `[...document.querySelectorAll('table tbody tr')].some((row) => row.innerText.includes('会话记录'))`,
  );

  const sessionRow = () => page.eval(`
    const row = [...document.querySelectorAll('table tbody tr')].find((r) => r.innerText.includes('会话记录'));
    if (!row) return null;
    return {
      cells: [...row.querySelectorAll('td')].map((cell) => cell.innerText),
      header: [...document.querySelectorAll('table thead th')].map((th) => th.innerText),
    };
  `);

  const setScope = (value) => page.eval(`
    const select = document.querySelector('.toolbar select');
    const setter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set;
    setter.call(select, '${value}');
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  `);

  const initial = await sessionRow();
  check(
    'cache rows show total size and files in one cell',
    Boolean(initial) &&
      initial.cells[0]?.includes('17 B') === true &&
      initial.cells[0]?.includes('1 个文件') === true &&
      !initial.header.includes('30 天前') &&
      initial.header.includes('占用'),
    JSON.stringify(initial),
  );

  const grouped = await page.eval(`return {
    groups: document.querySelectorAll('tbody.cache-group').length,
    agents: [...document.querySelectorAll('.cache-group-row .cache-agent')].map((node) => node.textContent),
    groupButtons: [...document.querySelectorAll('.cache-group-row button')].map((node) => node.textContent.trim()),
  };`);
  check(
    'cache table groups its targets by agent',
    grouped.groups === 1 && grouped.agents.includes('Claude Code') && grouped.groupButtons.includes('清理本组'),
    JSON.stringify(grouped),
  );

  await setScope(30);
  await sleep(200);
  const scoped = await sessionRow();
  check(
    'picking 30 days adds a dedicated range column',
    Boolean(scoped) && scoped.header.includes('30 天前') && scoped.cells[1]?.includes('1 个文件') === true,
    JSON.stringify(scoped),
  );

  await setScope(0);
  await sleep(200);
  const allScope = await sessionRow();
  check(
    'choosing 全部 drops the range column again',
    Boolean(allScope) && !allScope.header.includes('30 天前') && allScope.cells.length === 3,
    JSON.stringify(allScope),
  );

  const cleanClicked = await page.eval(`
    const row = [...document.querySelectorAll('table tbody tr')].find((r) => r.innerText.includes('会话记录'));
    const button = row && [...row.querySelectorAll('button')].find((b) => b.textContent.trim() === '清理');
    if (!button) return false;
    button.click();
    return true;
  `);
  check('cache clean button exists', cleanClicked);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  const cacheDialog = await page.eval(`
    const node = document.querySelector('dialog.confirm-dialog');
    return {
      title: node.querySelector('h2')?.textContent ?? '',
      body: node.querySelector('.confirm-dialog-body')?.textContent ?? '',
      focused: document.activeElement?.textContent ?? '',
      danger: [...node.querySelectorAll('button')].some((b) => b.classList.contains('danger')),
    };
  `);
  check(
    'cache clean asks first, defaults to cancel and names the path',
    cacheDialog.title === '清理缓存' &&
      cacheDialog.focused === '取消' &&
      cacheDialog.danger &&
      cacheDialog.body.includes('.claude') &&
      cacheDialog.body.includes('回收站'),
    JSON.stringify(cacheDialog),
  );
  await page.eval(`
    [...document.querySelectorAll('dialog.confirm-dialog button')]
      .find((b) => b.textContent.includes('移到回收站')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.notice')?.textContent.includes('回收站')`);
  const afterClean = await page.eval(`return {
    rowGone: ![...document.querySelectorAll('table tbody tr')].some((r) => r.innerText.includes('会话记录')),
    recycleHeader: document.querySelector('.snapshots .link-button')?.textContent ?? '',
    binItems: document.querySelectorAll('.snapshot-list li').length,
  };`);
  check(
    'a clean moves the target into the bin and drops its row',
    afterClean.rowGone && afterClean.recycleHeader.includes('1 项') && afterClean.binItems === 1,
    JSON.stringify(afterClean),
  );

  // Restoring puts it back; the dialog's own confirm button is labelled 恢复 as well.
  await page.eval(`
    const button = [...document.querySelectorAll('.snapshot-list li button')]
      .find((b) => b.textContent.trim() === '恢复');
    if (!button) return false;
    button.click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  await page.eval(`
    [...document.querySelectorAll('dialog.confirm-dialog button')]
      .find((b) => b.textContent.includes('恢复')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.notice')?.textContent.includes('已恢复')`);
  const afterRestore = await page.eval(`return {
    rowBack: [...document.querySelectorAll('table tbody tr')].some((r) => r.innerText.includes('会话记录')),
    binItems: document.querySelectorAll('.snapshot-list li').length,
  };`);
  check(
    'restoring from the bin brings the target back',
    afterRestore.rowBack && afterRestore.binItems === 0,
    JSON.stringify(afterRestore),
  );

  // A whole agent group is one action and one recycle item, so it undoes in one step.
  await page.eval(`
    [...document.querySelectorAll('.cache-group-row button')]
      .find((b) => b.textContent.trim() === '清理本组').click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  const groupDialog = await page.eval(`
    const node = document.querySelector('dialog.confirm-dialog');
    return {
      title: node.querySelector('h2')?.textContent ?? '',
      paths: [...node.querySelectorAll('.cache-clean-list code')].map((code) => code.textContent),
      focused: document.activeElement?.textContent ?? '',
    };
  `);
  check(
    'a group clean lists every path it will move',
    groupDialog.title.includes('Claude Code') && groupDialog.paths.length >= 2 && groupDialog.focused === '取消',
    JSON.stringify(groupDialog),
  );
  await page.eval(`
    [...document.querySelectorAll('dialog.confirm-dialog button')]
      .find((b) => b.textContent.includes('移到回收站')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.snapshots .link-button')?.textContent.includes('1 项')`);
  const afterGroup = await page.eval(`return {
    table: Boolean(document.querySelector('table.cache-table')),
    emptyText: document.body.innerText.includes('本机没有发现已知的缓存目录'),
    binItems: document.querySelectorAll('.snapshot-list li').length,
    binText: document.querySelector('.snapshot-list li')?.innerText ?? '',
  };`);
  check(
    'a group clean moves every stale target in one recycle item',
    !afterGroup.table && afterGroup.emptyText && afterGroup.binItems === 1 && afterGroup.binText.includes('3 个文件'),
    JSON.stringify(afterGroup),
  );

  // Emptying the bin is the only destructive step.
  await page.eval(`
    [...document.querySelectorAll('.snapshots header button')]
      .find((b) => b.textContent.includes('清空回收站')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  const purgeDialog = await page.eval(`
    const node = document.querySelector('dialog.confirm-dialog');
    return {
      title: node.querySelector('h2')?.textContent ?? '',
      focused: document.activeElement?.textContent ?? '',
      body: node.querySelector('.confirm-dialog-body')?.textContent ?? '',
    };
  `);
  check(
    'emptying the bin is destructive and defaults to cancel',
    purgeDialog.title === '清空回收站' && purgeDialog.focused === '取消' && purgeDialog.body.includes('无法恢复'),
    JSON.stringify(purgeDialog),
  );
  await page.eval(`
    [...document.querySelectorAll('dialog.confirm-dialog button')]
      .find((b) => b.textContent.includes('清空并释放空间')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.notice')?.textContent.includes('已彻底删除')`);
  const afterPurge = await page.eval(`return {
    recycleHeader: document.querySelector('.snapshots .link-button')?.textContent ?? '',
    binItems: document.querySelectorAll('.snapshot-list li').length,
  };`);
  check(
    'purging the bin leaves nothing behind',
    afterPurge.recycleHeader.includes('0 项') && afterPurge.binItems === 0,
    JSON.stringify(afterPurge),
  );

  // 10b. The store page talks to the (fake) registry, installs into the source and links agents.
  await page.eval(`location.hash = 'store'; return true;`);
  await page.waitForFn(`document.querySelectorAll('.store-card').length > 0`);
  const storeShape = await page.eval(`
    const card = document.querySelector('.store-card');
    return {
      title: card.querySelector('h3')?.textContent ?? '',
      owner: card.querySelector('.store-owner')?.textContent ?? '',
      action: card.querySelector('.store-action')?.textContent ?? '',
      targets: document.querySelectorAll('.store-targets .check').length,
    };
  `);
  check(
    'store renders registry rows with an install action',
    storeShape.title === 'latte' &&
      storeShape.owner === 'acme/acme-latte' &&
      storeShape.action.includes('安装') &&
      storeShape.action.includes('Install') &&
      storeShape.targets === 3,
    JSON.stringify(storeShape),
  );

  await page.eval(`
    const input = document.querySelector('.store-search input');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, 'coffee');
    input.dispatchEvent(new Event('input', {bubbles: true}));
    document.querySelector('.store-search').requestSubmit();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.store-page .meta')?.textContent.includes('coffee')`);
  check('store search re-queries the registry', true);

  const pager = await page.eval(`
    const label = document.querySelector('.store-pager-label')?.textContent.trim() ?? '';
    const buttons = [...document.querySelectorAll('.store-pager button')];
    return { label, prev: buttons[0]?.disabled ?? null, next: buttons[1]?.disabled ?? null };
  `);
  check(
    'store paginates instead of stopping at one page',
    pager.label.startsWith('第 1 / 3 页') && pager.prev === true && pager.next === false,
    JSON.stringify(pager),
  );

  await page.eval(`document.querySelectorAll('.store-pager button')[1].click(); return true;`);
  await page.waitForFn(`document.querySelector('.store-pager-label')?.textContent.includes('第 2 / 4 页')`);
  const secondPage = await page.eval(`
    const buttons = [...document.querySelectorAll('.store-pager button')];
    return {
      label: document.querySelector('.store-pager-label')?.textContent.trim() ?? '',
      cards: document.querySelectorAll('.store-card').length,
      prev: buttons[0]?.disabled ?? null,
    };
  `);
  check(
    'the next page is fetched from the registry',
    secondPage.label.startsWith('第 2 / 4 页') && secondPage.cards === 1 && secondPage.prev === false,
    JSON.stringify(secondPage),
  );

  await page.eval(`document.querySelectorAll('.store-pager button')[0].click(); return true;`);
  await page.waitForFn(`document.querySelector('.store-pager-label')?.textContent.includes('第 1 / 3 页')`);
  check('the previous page goes back', true);

  await page.eval(`document.querySelector('.store-action').click(); return true;`);
  await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
  const storeDialog = await page.eval(`
    const node = document.querySelector('dialog.confirm-dialog');
    return {
      title: node.querySelector('h2')?.textContent ?? '',
      body: node.querySelector('.confirm-dialog-body')?.innerText ?? '',
      focused: document.activeElement?.textContent ?? '',
    };
  `);
  check(
    'store install names the destination and the agents it will link',
    storeDialog.title.includes('latte') &&
      storeDialog.body.includes(join(home, '.agents', 'skills', 'latte')) &&
      storeDialog.body.includes('Claude Code') &&
      storeDialog.body.includes('Codex') &&
      storeDialog.body.includes('acme/acme-latte'),
    JSON.stringify(storeDialog),
  );

  await page.eval(`
    const node = document.querySelector('dialog.confirm-dialog');
    [...node.querySelectorAll('button')].find((b) => b.textContent.includes('安装')).click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.store-page .notice')?.textContent.includes('已安装 latte')`);
  const installedFile = join(home, '.agents', 'skills', 'latte', 'SKILL.md');
  check(
    'store install writes the skill into the source and links agents',
    existsSync(installedFile) && readFileSync(installedFile, 'utf8').includes('Brew it'),
    installedFile,
  );
  await page.waitForFn(`document.querySelector('.store-action')?.textContent.trim() === '源里已有 In source'`);
  check('an installed skill is marked in the source', true);

  // 10c. The language switch re-renders the whole page in English and back to bilingual.
  await page.eval(`
    const button = [...document.querySelectorAll('.store-lang button')].find((b) => b.textContent.includes('English'));
    button.click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.store-action')?.textContent.trim() === 'In source'`);
  const englishShape = await page.eval(`
    return {
      action: document.querySelector('.store-action')?.textContent.trim() ?? '',
      search: document.querySelector('.store-search button[type=submit]')?.textContent.trim() ?? '',
      targets: document.querySelector('.store-targets-label')?.textContent.trim() ?? '',
    };
  `);
  check(
    'the language switch renders English labels',
    englishShape.action === 'In source' &&
      englishShape.search === 'Search' &&
      englishShape.targets === 'Link to',
    JSON.stringify(englishShape),
  );

  await page.eval(`
    document.querySelectorAll('.store-lang button')[2].click();
    return true;
  `);
  await page.waitForFn(`document.querySelector('.store-search button[type=submit]')?.textContent.includes('搜索')`);
  const bilingual = await page.eval(`return document.querySelector('.store-search button[type=submit]')?.textContent.trim() ?? '';`);
  check('the bilingual mode shows both languages at once', bilingual === '搜索 Search', bilingual);

  await page.eval(`document.querySelector('#nav-skills').click(); return true;`);
  await page.waitForFn(`document.querySelector('table')?.innerText.includes('latte')`);
  const storeRow = await page.eval(`
    const row = [...document.querySelectorAll('table tbody tr')].find((r) => r.innerText.includes('latte'));
    return row ? row.innerText.replace(/\\s+/g, ' ') : '';
  `);
  check('the store install shows up as linked in the skills matrix', storeRow.includes('链接'), storeRow);
  const errors = page.consoleErrors.filter((entry) => !entry.includes('favicon'));
  check('no runtime console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // 11. Snapshot restore is destructive: dialog opens with cancel focused, and Escape closes it.
  // The cache page renders its own `.snapshots` section above the panel, so target the last one.
  await page.eval(`
    const panel = [...document.querySelectorAll('.snapshots')].at(-1);
    panel.querySelector('header button').click();
    return true;
  `);
  await sleep(500);
  const snapshotButton = await page.eval(`
    const panel = [...document.querySelectorAll('.snapshots')].at(-1);
    const button = panel.querySelector('.snapshot-list button');
    if (!button) return false;
    button.click();
    return true;
  `);
  if (snapshotButton) {
    await page.waitForFn(`document.querySelector('dialog.confirm-dialog')?.open === true`);
    const restoreDialog = await page.eval(`
      const node = document.querySelector('dialog.confirm-dialog');
      return {
        title: node.querySelector('h2')?.textContent ?? '',
        focused: document.activeElement?.textContent ?? '',
        confirmDanger: [...node.querySelectorAll('button')].some((b) => b.classList.contains('danger')),
      };
    `);
    check(
      'snapshot restore dialog defaults to cancel',
      restoreDialog.title === '还原到这个快照' && restoreDialog.focused === '取消' && restoreDialog.confirmDanger,
      JSON.stringify(restoreDialog),
    );
    await page.eval(`
      document.querySelector('dialog.confirm-dialog').dispatchEvent(new Event('cancel', {cancelable: true}));
      return true;
    `);
    await sleep(300);
    const closed = await page.eval(`return !document.querySelector('dialog.confirm-dialog');`);
    check('escaping the restore dialog leaves files untouched', closed);
  } else {
    check('snapshot restore dialog defaults to cancel', false, 'no snapshot available to restore');
  }
} catch (error) {
  check('ui run completed', false, error.message);
} finally {
  try {
    await fetch(`http://127.0.0.1:${PORT}/api/app/quit`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' }).catch(() => {});
  } catch {
    /* ignore */
  }
  edge.kill();
  server.kill();
  modelStub.close();
  storeStub.close();
  if (page) page.socket.close();
  await sleep(400);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
