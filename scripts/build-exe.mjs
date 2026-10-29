import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST = join(ROOT, 'dist');
const BUILD = join(ROOT, '.build');
// Everything is produced here first. `release/` is only touched after a fully successful build,
// so a broken build (or a running exe) never destroys the current release or its data/ folder.
const STAGE = join(BUILD, 'release-next');
const RELEASE = join(ROOT, 'release');
const EXE = join(STAGE, 'AgentManager.exe');
const VBS = join(STAGE, 'AgentManager.vbs');
const SENTINEL_FUSE = 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2';

/**
 * Switches the PE subsystem from console (3) to GUI (2) so double-clicking the exe does not
 * allocate a console window. CLI output still works when stdout is redirected or piped.
 */
function setGuiSubsystem(exePath) {
  const buffer = readFileSync(exePath);
  const peOffset = buffer.readUInt32LE(0x3c);
  if (buffer.readUInt32LE(peOffset) !== 0x00004550) throw new Error('不是有效的 PE 文件');
  const optional = peOffset + 24;
  const magic = buffer.readUInt16LE(optional);
  if (magic !== 0x10b && magic !== 0x20b) throw new Error('未知的 PE optional header');
  const subsystemOffset = optional + 68;
  if (buffer.readUInt16LE(subsystemOffset) === 2) return false;
  buffer.writeUInt16LE(2, subsystemOffset);
  writeFileSync(exePath, buffer);
  return true;
}

function walk(dir, base = dir) {
  const files = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const absolute = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...walk(absolute, base));
    else if (entry.isFile()) files.push(relative(base, absolute).split(sep).join('/'));
  }
  return files;
}

function collectAssets() {
  if (!existsSync(DIST)) throw new Error('dist/ 不存在，先运行 Vite 构建');
  const assets = {};
  for (const relativePath of walk(DIST).sort()) {
    const absolute = join(DIST, relativePath);
    if (statSync(absolute).size > 8_000_000) throw new Error(`静态资源过大：${relativePath}`);
    assets[relativePath] = readFileSync(absolute).toString('base64');
  }
  return assets;
}

function virtualAssets(assets) {
  return {
    name: 'virtual-assets',
    setup(pluginBuild) {
      pluginBuild.onResolve({ filter: /^virtual:assets$/ }, () => ({ path: 'assets', namespace: 'virtual' }));
      pluginBuild.onLoad({ filter: /.*/, namespace: 'virtual' }, () => ({
        contents: `export const assets = ${JSON.stringify(assets)};`,
        loader: 'js',
      }));
    },
  };
}

/** Copies next to the target and renames, so a failed copy leaves the previous file untouched. */
function replaceFile(source, target) {
  mkdirSync(dirname(target), { recursive: true });
  const temp = `${target}.new-${process.pid}`;
  copyFileSync(source, temp);
  try {
    renameSync(temp, target);
  } catch (error) {
    try {
      rmSync(temp, { force: true });
    } catch {
      // Keep the original error.
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`无法替换 ${target}（如果 AgentManager 正在运行，请先执行 AgentManager.exe --stop）：${message}`);
  }
}

async function main() {
  const major = Number.parseInt(process.versions.node.split('.')[0] ?? '', 10);
  if (!Number.isInteger(major) || major < 22) {
    throw new Error(`需要 Node.js >= 22 才能构建（当前 ${process.versions.node}）`);
  }
  const target = `node${major}`;

  console.log('[build-exe] 1/6 构建前端');
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', join(ROOT, 'web', 'vite.config.ts')],
    { cwd: ROOT, stdio: 'inherit' },
  );

  console.log('[build-exe] 2/6 收集静态资源');
  const assets = collectAssets();
  // Only the staging folder is cleared up front; release/ keeps its data/ and logs.
  rmSync(STAGE, { recursive: true, force: true });
  mkdirSync(STAGE, { recursive: true });
  mkdirSync(BUILD, { recursive: true });

  console.log(
    `[build-exe] 3/6 打包 ${Object.keys(assets).length} 个 UI 文件和服务端（esbuild target=${target}，构建用 Node ${process.versions.node}）`,
  );
  const bundle = join(BUILD, 'sea-main.cjs');
  await build({
    entryPoints: [join(ROOT, 'server', 'sea-entry.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target,
    outfile: bundle,
    plugins: [virtualAssets(assets)],
    banner: { js: '// AgentManager standalone bundle' },
    logLevel: 'info',
    legalComments: 'none',
  });

  const seaConfig = join(BUILD, 'sea-config.json');
  const blob = join(BUILD, 'sea-prep.blob');
  writeFileSync(
    seaConfig,
    `${JSON.stringify({ main: bundle, output: blob, disableExperimentalSEAWarning: true, useSnapshot: false }, null, 2)}\n`,
  );

  console.log('[build-exe] 4/6 生成 Node SEA blob');
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { cwd: BUILD, stdio: 'inherit' });

  console.log('[build-exe] 5/6 注入 blob 并生成暂存的 AgentManager.exe');
  copyFileSync(process.execPath, EXE);
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules', 'postject', 'dist', 'cli.js'), EXE, 'NODE_SEA_BLOB', blob, '--sentinel-fuse', SENTINEL_FUSE],
    { stdio: 'inherit' },
  );
  console.log(
    setGuiSubsystem(EXE)
      ? '[build-exe] 已切换为 GUI 子系统：双击 exe 不再弹出控制台窗口'
      : '[build-exe] 已是 GUI 子系统',
  );
  copyFileSync(join(ROOT, 'scripts', 'launch-hidden.vbs'), VBS);

  console.log('[build-exe] 6/6 替换 release 中的 AgentManager.exe 与 AgentManager.vbs');
  replaceFile(EXE, join(RELEASE, 'AgentManager.exe'));
  replaceFile(VBS, join(RELEASE, 'AgentManager.vbs'));

  const sizeMb = (statSync(join(RELEASE, 'AgentManager.exe')).size / 1024 / 1024).toFixed(1);
  console.log(`[build-exe] 完成：${join(RELEASE, 'AgentManager.exe')} (${sizeMb} MB)`);
  console.log('[build-exe] release/data 与其它文件保持不变');
  console.log(
    `[build-exe] 双击 ${join(RELEASE, 'AgentManager.exe')} 即可启动（无控制台窗口）；快捷方式可运行 npm run install:shortcut 创建`,
  );
}

main().catch((error) => {
  console.error('[build-exe] 失败：', error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
