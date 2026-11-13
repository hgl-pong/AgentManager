import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';

import { AppError } from '../shared/types.ts';
import type {
  AgentSpec,
  BuiltinInstallRequest,
  BuiltinSkill,
  BuiltinSkillReport,
  StoreInstallReport,
  StoreSkillFile,
} from '../shared/types.ts';
import type { StaticAssets } from './app.ts';
import { installSkillEntries, listInstalledSkills } from './store.ts';

/** Directory in the repo, and the asset-key prefix in the standalone build. */
const BUNDLED_ROOT = 'builtin-skills';

/**
 * Metadata for every bundled skill; the files themselves live under BUNDLED_ROOT/<slug>.
 * The list endpoint carries the whole preview so a built-in install never touches the network.
 */
interface BuiltinSpec {
  slug: string;
  owner: string;
  summary: string;
  version: string;
  license: string;
  repository: string;
  capabilities: string[];
  limitations: string[];
  useCases: { title: string; description: string }[];
}

const BUILTINS: BuiltinSpec[] = [
  {
    slug: 'skillify',
    owner: 'kk-r',
    summary:
      '把一次完成的会话整理成可复用的 SKILL.md（agentskills.io 标准），之后的 agent 会话可以直接复用这套流程。',
    version: '1.0.0',
    license: 'MIT',
    repository: 'https://github.com/kk-r/skillify-skill',
    capabilities: [
      '从对话、git 变更和项目工具链还原一次会话的目标、步骤与纠正',
      '分轮确认技能名称、步骤、成功标准和触发短语',
      '按 agentskills.io 标准生成带 YAML frontmatter 的 SKILL.md',
    ],
    limitations: [
      '需要会话里已经完成过一次值得复用的流程',
      '生成的技能默认保存到 .claude/skills，不会自动链接其他 agent',
    ],
    useCases: [
      { title: '沉淀重复流程', description: '把每次都要重新解释的步骤固化成可调用的 skill。' },
      { title: '交接给其他 agent', description: '生成标准 SKILL.md，Claude Code、Cursor、Codex 等都能读取。' },
    ],
  },
  {
    slug: 'cpp-windows-debug',
    owner: 'heguoling',
    summary:
      '在 Windows 上用 CMake / MSVC / MSBuild / Incredibuild 构建 C++ 项目，再用 cdb 脚本或 Visual Studio 调试器定位崩溃、异常与状态问题。',
    version: '1.0.0',
    license: 'MIT',
    repository: '',
    capabilities: [
      '发现工具链（vswhere、CMake、cdb、Incredibuild）并按项目规模选择构建引擎',
      '生成或定位 .sln，按 Debug / Release 构建并核对 exe、PDB 与编译告警',
      '用 cdb 脚本设断点，查看调用栈、局部变量与 STL 值，处理异常、转储与附加进程',
      '按最小改动修复后重新构建，并用同一脚本回归验证',
    ],
    limitations: [
      '只覆盖 Windows 上的 MSVC / CMake 工具链，不处理 Linux 或 macOS 构建',
      'Incredibuild 槽位被占用时只报告等待，不会抢占其他任务的构建',
    ],
    useCases: [
      { title: '构建并调试 C++ 工程', description: '从配置 CMake 到命中断点，把构建与调试串成一条可复现的流程。' },
      { title: '分析崩溃与转储', description: '用 cdb 捕获异常记录和故障栈，或在 dump 上做上下文恢复与 `!analyze`。' },
    ],
  },
  {
    slug: 'ue-asset-deep-dump',
    owner: 'heguoling',
    summary:
      '用只读 Python commandlet 深度解析 Unreal Engine 内容包：蓝图图/节点/pin/连线、材质表达式、MaterialInstance 覆写、DataTable 行、依赖与 tags，产出 JSON 索引、校验报告、节点图 SVG 与 Markdown/HTML 文档。',
    version: '1.0.0',
    license: 'MIT',
    repository: '',
    capabilities: [
      '定位 .uproject、引擎与内容根，按 EngineAssociation 自动探测 UnrealEditor-Cmd',
      '运行只读 Python commandlet 导出全部资产的路径、类、tags、依赖',
      '蓝图图/节点/pin/连线、材质表达式、MI 覆写、DataTable 行的结构化 JSON',
      '结构校验（硬错误为 0），节点图 SVG、材质 SVG 与单文件 HTML 文档',
    ],
    limitations: [
      '需要本地安装 Unreal Engine 并能运行 UnrealEditor-Cmd（PythonScriptPlugin）',
      '只读资产，不修改内容；推断性结论必须标注',
    ],
    useCases: [
      { title: '逆向纯资产插件', description: '没有 C++ 源码的内容包，从资产结构还原模块设计与节点逻辑。' },
      { title: '生成可复核文档', description: '每条结论都能追到资产路径 + 图/节点/表达式/参数。' },
    ],
  },
];

interface BuiltinFile {
  path: string;
  data: Buffer;
}

/**
 * Reads one bundled skill. A standalone build carries the files in its asset map; a dev checkout
 * reads them from the repo. The asset map wins when both exist, so an upgraded exe never mixes
 * its shipped content with a stale folder next to it.
 */
export function readBuiltinFiles(input: {
  slug: string;
  projectRoot: string;
  assets?: StaticAssets;
}): BuiltinFile[] {
  const prefix = `${BUNDLED_ROOT}/${input.slug}/`;
  if (input.assets) {
    const keys = Object.keys(input.assets)
      .filter((key) => key.startsWith(prefix))
      .sort();
    if (keys.length > 0) {
      return keys.map((key) => ({
        path: key.slice(prefix.length),
        data: Buffer.from(input.assets?.[key] ?? '', 'base64'),
      }));
    }
  }

  const root = join(input.projectRoot, BUNDLED_ROOT, input.slug);
  const files: BuiltinFile[] = [];
  const walk = (directory: string): void => {
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) walk(absolute);
      else if (entry.isFile()) {
        files.push({
          path: relative(root, absolute).split(sep).join('/'),
          data: readFileSync(absolute),
        });
      }
    }
  };
  walk(root);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function lineCount(data: Buffer): number {
  const text = data.toString('utf8');
  return text === '' ? 0 : text.split(/\r?\n/).length;
}

function builtinSkill(spec: BuiltinSpec, files: BuiltinFile[], installed: boolean): BuiltinSkill {
  const fileList: StoreSkillFile[] = files.map((file) => ({
    path: file.path,
    type: 'file',
    lines: lineCount(file.data),
  }));
  return {
    id: `builtin:${spec.slug}`,
    slug: spec.slug,
    owner: spec.owner,
    name: spec.slug,
    summary: spec.summary,
    category: 'productivity',
    license: spec.license,
    repository: spec.repository,
    version: spec.version,
    downloads: 0,
    favorites: 0,
    inSource: installed,
    builtin: true,
    capabilities: spec.capabilities,
    limitations: spec.limitations,
    useCases: spec.useCases,
    files: fileList,
    riskFactors: [],
    viewCount: 0,
  };
}

export interface BuiltinListInput {
  source: string;
  projectRoot: string;
  assets?: StaticAssets;
}

/** Every bundled skill, with whether the single source already holds a directory of that name. */
export function listBuiltinSkills(input: BuiltinListInput): BuiltinSkillReport {
  const installed = new Set(listInstalledSkills(input.source));
  return {
    sourcePath: input.source,
    items: BUILTINS.map((spec) =>
      builtinSkill(spec, readBuiltinFiles({ ...input, slug: spec.slug }), installed.has(spec.slug)),
    ),
  };
}

export interface BuiltinInstallInput {
  source: string;
  snapshotRoot: string;
  tempRoot: string;
  agents: AgentSpec[];
  request: BuiltinInstallRequest;
  projectRoot: string;
  assets?: StaticAssets;
}

/**
 * Copies a bundled skill into the source and links the requested agents. It reuses the store's
 * staging/snapshot/link path, so a failed link rolls back exactly like a registry install.
 */
export function installBuiltinSkill(input: BuiltinInstallInput): StoreInstallReport {
  const requested = String(input.request.name ?? '').trim();
  const spec = BUILTINS.find((entry) => entry.slug === requested);
  if (!spec) throw new AppError(404, `没有名为 ${requested} 的内置技能`);

  const files = readBuiltinFiles({ slug: spec.slug, projectRoot: input.projectRoot, ...(input.assets ? { assets: input.assets } : {}) });
  if (!files.some((file) => file.path === 'SKILL.md')) {
    throw new AppError(500, `内置技能 ${spec.slug} 缺少 SKILL.md`);
  }

  const resolved: AgentSpec[] = [];
  for (const key of [...new Set((input.request.agents ?? []).map(String))]) {
    const agent = input.agents.find((candidate) => candidate.key === key);
    if (!agent) throw new AppError(400, `未知的 agent：${key}`);
    resolved.push(agent);
  }

  return installSkillEntries({
    source: input.source,
    snapshotRoot: input.snapshotRoot,
    tempRoot: input.tempRoot,
    agents: resolved,
    name: spec.slug,
    label: `install builtin ${spec.slug}`,
    entries: files.map((file) => ({ name: file.path, data: file.data })),
  });
}
