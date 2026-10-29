import { resolve } from 'node:path';
import { launch } from './launcher.ts';

const projectRoot = process.env.AGENT_MANAGER_ROOT
  ? resolve(process.env.AGENT_MANAGER_ROOT)
  : resolve(import.meta.dirname, '..');

launch({ projectRoot, argv: process.argv.slice(2) }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[agent-manager] ${message}`);
  if (message) console.error('运行 `node server/index.ts --help` 查看用法。');
  process.exitCode = 1;
});
