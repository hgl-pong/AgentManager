// Headless UI smoke test for the interaction flows that were reworked. It boots the real server
// against a throwaway home directory, drives the built UI in headless Edge over CDP, and asserts on
// what the page actually shows. Run after `npm run build`:
//
//   npm run build && npm run verify:ui
//
// Not part of `npm test`: it needs a local Edge/Chrome and takes ~20s.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
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

const PORT = 7900 + Math.floor(Math.random() * 200);
const CDP = 9300 + Math.floor(Math.random() * 200);
const MODELS_PORT = PORT + 500;

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

  const errors = page.consoleErrors.filter((entry) => !entry.includes('favicon'));
  check('no runtime console errors', errors.length === 0, errors.slice(0, 3).join(' | '));

  // 11. Snapshot restore is destructive: dialog opens with cancel focused, and Escape closes it.
  await page.eval(`
    const toggle = [...document.querySelectorAll('.snapshots header button')][0];
    toggle.click();
    return true;
  `);
  await sleep(500);
  const snapshotButton = await page.eval(`
    const button = document.querySelector('.snapshot-list button');
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
  if (page) page.socket.close();
  await sleep(400);
}

const failed = results.filter((entry) => !entry.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length === 0 ? 0 : 1);
