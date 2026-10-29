import { dirname, resolve } from 'node:path';
import { launch, notifyUser } from './launcher.ts';
import { assets } from 'virtual:assets';

const projectRoot = resolve(
  process.env.AGENT_MANAGER_ROOT ? process.env.AGENT_MANAGER_ROOT : dirname(process.execPath),
);

launch({ projectRoot, argv: process.argv.slice(2), assets }).catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`[agent-manager] ${message}`);
  notifyUser(`AgentManager 启动失败：\n${message}\n\n请查看数据目录下的 app.log（默认是 exe 旁边的 data\\app.log，或 %LOCALAPPDATA%\\AgentManager\\app.log）。`);
  process.exitCode = 1;
});
