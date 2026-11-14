// Every string the store page shows, in both languages. `zh` is the default so the page reads
// like the rest of the app; the switch still offers English and bilingual, because a registry's
// names, summaries and licences stay in the language their publisher wrote them in.

export type StoreLang = 'zh' | 'en' | 'both';

export interface Bi {
  zh: string;
  en: string;
}

export const STORE_LANG_KEY = 'agent-manager.store-lang';
export const STORE_LANGS: StoreLang[] = ['zh', 'en', 'both'];

export function loadStoreLang(): StoreLang {
  try {
    const stored = window.localStorage.getItem(STORE_LANG_KEY);
    return STORE_LANGS.includes(stored as StoreLang) ? (stored as StoreLang) : 'zh';
  } catch {
    return 'zh';
  }
}

export function rememberStoreLang(lang: StoreLang): void {
  try {
    window.localStorage.setItem(STORE_LANG_KEY, lang);
  } catch {
    // A blocked localStorage only costs the preference, never the page.
  }
}

/** `zh + en` when showing both, so a button reads "安装 Install" instead of two rows. */
export function pick(lang: StoreLang, value: Bi): string {
  if (lang === 'en') return value.en;
  if (lang === 'zh') return value.zh;
  return `${value.zh} ${value.en}`;
}

/** Fills `%s` placeholders in order. */
export function fill(template: string, ...values: Array<string | number>): string {
  let index = 0;
  return template.replaceAll('%s', () => String(values[index++] ?? ''));
}

/**
 * Fills both languages before joining them: filling the joined string would consume every
 * placeholder in the Chinese half and leave the English half empty.
 */
export function pickFilled(lang: StoreLang, value: Bi, values: Array<string | number>): string {
  const zh = fill(value.zh, ...values);
  const en = fill(value.en, ...values);
  if (lang === 'zh') return zh;
  if (lang === 'en') return en;
  return `${zh} ${en}`;
}

export const STORE_TEXT = {
  searchPlaceholder: { zh: '搜索技能：pdf、review、slides…', en: 'Search skills: pdf, review, slides…' },
  search: { zh: '搜索', en: 'Search' },
  searching: { zh: '搜索中…', en: 'Searching…' },
  featured: { zh: '热门', en: 'Featured' },
  filterLabel: { zh: '筛选与排序', en: 'Filters and sorting' },
  filterCategory: { zh: '分类', en: 'Category' },
  filterRisk: { zh: '风险', en: 'Risk' },
  filterTransport: { zh: '传输', en: 'Transport' },
  filterScripts: { zh: '含脚本', en: 'Has scripts' },
  filterAll: { zh: '全部', en: 'All' },
  sortLabel: { zh: '排序', en: 'Sort' },
  sortDefault: { zh: '默认', en: 'Default' },
  sortQuality: { zh: '质量最高', en: 'Best quality' },
  sortUpdated: { zh: '最近更新', en: 'Recently updated' },
  sortName: { zh: '名称 A→Z', en: 'Name A→Z' },
  clearFilters: { zh: '清除筛选', en: 'Clear filters' },
  filterHint: {
    zh: '分类与风险在整店范围内筛选；排序只作用于当前这页。',
    en: 'Category and risk narrow the whole store; sorting applies to this page only.',
  },
  mcpFilterHint: {
    zh: 'MCP Registry 没有筛选参数；传输与排序只作用于当前这页。',
    en: 'The MCP Registry takes no filter parameters; transport and sorting apply to this page only.',
  },
  noMatch: { zh: '当前这页没有符合筛选的条目。', en: 'Nothing on this page matches the filters.' },
  noMatchSkill: { zh: '没有符合筛选的技能。', en: 'No skill matches these filters.' },
  pageFiltered: { zh: '本页筛出 %s/%s 项', en: '%s of %s on this page' },
  language: { zh: '语言', en: 'Language' },
  catalog: { zh: '目录', en: 'Catalog' },
  sourceLabel: { zh: '来源', en: 'Source' },
  langZh: { zh: '中文', en: '中文' },
  langEn: { zh: 'English', en: 'English' },
  langBoth: { zh: '双语', en: 'Bilingual' },
  linkTargets: { zh: '安装后链接到', en: 'Link to' },
  noAgentDetected: { zh: '未检测到', en: 'not detected' },
  noAgents: {
    zh: '没有检测到 agent，安装只会写进源目录。',
    en: 'No agent detected, so the install only writes into the source.',
  },
  loading: { zh: '读取中…', en: 'Loading…' },
  listingFeatured: { zh: '热门', en: 'Featured' },
  listingSearch: { zh: '搜索', en: 'Search' },
  results: { zh: '个结果', en: 'results' },
  cached: { zh: '缓存', en: 'cached' },
  installNote: { zh: '安装位置是源目录：', en: 'Installs into the source: ' },
  installNoteTail: { zh: '装好后可在 Skills 页建链。', en: 'link agents from the Skills page.' },
  staleError: { zh: '商店暂时不可用，下面是上次的结果：', en: 'Registry unavailable, showing the last result: ' },
  registryError: { zh: '商店返回错误：', en: 'Registry error: ' },
  loadError: { zh: '读取商店失败：', en: 'Could not read the store: ' },
  retry: { zh: '重试', en: 'Retry' },
  pageOf: { zh: '第 %s / %s 页', en: 'page %s of %s' },
  prevPage: { zh: '上一页', en: 'Previous' },
  nextPage: { zh: '下一页', en: 'Next' },
  emptySearch: { zh: '没有找到「%s」相关的技能。', en: 'No skill matches “%s”.' },
  emptyRegistry: { zh: '商店没有返回任何技能。', en: 'The registry returned no skill.' },
  emptyHint: { zh: '换几个关键词试试，或者回到热门列表。', en: 'Try other keywords, or go back to the featured list.' },
  install: { zh: '安装', en: 'Install' },
  installing: { zh: '安装中…', en: 'Installing…' },
  inSource: { zh: '源里已有', en: 'In source' },
  inSourceTitle: {
    zh: '源目录里已经有同名 skill，先到 Skills 页移除或改名',
    en: 'The source already has this skill; remove or rename it on the Skills page first',
  },
  downloads: { zh: '下载', en: 'downloads' },
  favorites: { zh: '收藏', en: 'favorites' },
  updated: { zh: '更新', en: 'updated' },
  quality: { zh: '质量', en: 'quality' },
  scripts: { zh: '含脚本', en: 'has scripts' },
  network: { zh: '需联网', en: 'needs network' },
  dialogDownload: { zh: '会把 %s 下载到源目录：', en: 'Downloads %s into the source:' },
  dialogLinks: { zh: '装入后创建指向它的链接：%s。', en: 'Links created afterwards: %s.' },
  dialogNoLinks: { zh: '只写进源目录，不创建任何链接。', en: 'Writes into the source only, no links.' },
  dialogScripts: {
    zh: '这个 skill 带脚本：agent 运行时可能执行它，安装前请确认来源。',
    en: 'This skill ships scripts the agent may run; check the publisher before installing.',
  },
  dialogHint: {
    zh: 'skill 内容由第三方发布，写入前会自动建快照，可在快照面板里整体撤销。',
    en: 'Content comes from a third party. A snapshot is taken first and can be restored later.',
  },
  noticeInstalled: { zh: '已安装 %s 到源', en: 'Installed %s into the source' },
  noticeLinked: { zh: '并链接到 %s', en: 'linked %s' },
  noticeSnapshot: { zh: '快照 %s', en: 'snapshot %s' },
  noticeCheckLinks: { zh: '去 Skills 查看', en: 'Check in Skills' },
  warningPrefix: { zh: '注意：', en: 'Note: ' },

  // MCP catalog (official MCP Registry)
  kindSkill: { zh: 'Skills', en: 'Skills' },
  kindMcp: { zh: 'MCP', en: 'MCP' },
  mcpSearchPlaceholder: {
    zh: '搜索 MCP server（至少 3 个字符）…',
    en: 'Search MCP servers (3+ characters)…',
  },
  mcpMinChars: {
    zh: 'MCP Registry 的搜索至少需要 3 个字符。',
    en: 'The MCP Registry needs at least 3 characters to search.',
  },
  mcpInstallNote: { zh: '安装位置是 MCP 源：', en: 'Installs into the MCP source: ' },
  mcpInstallNoteTail: {
    zh: '保存后同步给上面勾选的 agent。',
    en: 'saved, then synced to the agents checked above.',
  },
  mcpEmptySearch: { zh: '没有找到「%s」相关的 MCP server。', en: 'No MCP server matches “%s”.' },
  mcpEmptyRegistry: { zh: 'MCP Registry 没有返回任何 server。', en: 'The MCP Registry returned no server.' },
  mcpEmptyHint: {
    zh: 'MCP Registry 只按名称搜索，换几个关键词试试。',
    en: 'The MCP Registry searches names only; try other keywords.',
  },
  mcpPage: { zh: '第 %s 页', en: 'page %s' },
  mcpInSourceTitle: {
    zh: 'MCP 源里已经有同名 server，先到 MCP 页移除或改名',
    en: 'The MCP source already has this server; remove or rename it on the MCP page first',
  },
  mcpNoOptions: { zh: '没有安装方式', en: 'No option' },
  mcpNoOptionsTitle: {
    zh: '这个 server 没有目前支持的包或远端地址',
    en: 'This server has no package or remote endpoint the app can install',
  },
  mcpOption: { zh: '安装方式', en: 'Run as' },
  mcpName: { zh: '名称（写入 MCP 源）', en: 'Name (in the MCP source)' },
  mcpVariables: { zh: '需要填写', en: 'Required values' },
  mcpVariableRequired: { zh: '必填', en: 'required' },
  mcpNoVariables: { zh: '不需要额外配置。', en: 'No extra configuration needed.' },
  mcpUrlVariable: { zh: '会替换 URL 里的 {%s}', en: 'replaces {%s} in the URL' },
  mcpTemplateVariable: { zh: '会替换定义里的 {%s}', en: 'replaces {%s} in the definition' },
  mcpPreview: { zh: '写入内容', en: 'Will write' },
  mcpTargets: { zh: '保存后同步到：%s', en: 'Synced to: %s' },
  mcpOnlySource: { zh: '只写入 MCP 源，不同步任何 agent。', en: 'Writes the MCP source only; no agent is synced.' },
  mcpSseWarning: {
    zh: 'Codex 与 pi 不支持 sse，同步时会被跳过。',
    en: 'Codex and pi do not support sse; they are skipped when syncing.',
  },
  mcpDialogHint: {
    zh: 'server 定义来自官方 MCP Registry。写入前会自动建快照，可在快照面板里整体撤销。',
    en: 'The definition comes from the official MCP Registry. A snapshot is taken first and can be restored later.',
  },
  mcpNotice: { zh: '已安装 %s 到 MCP 源', en: 'Installed %s into the MCP source' },
  detailOpen: { zh: '查看详情', en: 'Details' },
  detailOpenLabel: { zh: '查看 %s 的完整介绍', en: 'View full details for %s' },
  detailClose: { zh: '关闭', en: 'Close' },
  detailLoading: { zh: '正在读取完整介绍…', en: 'Loading the full description…' },
  detailError: { zh: '读取技能详情失败：', en: 'Could not load skill details: ' },
  detailCapabilities: { zh: '能做什么', en: 'What it does' },
  detailLimitations: { zh: '限制', en: 'Limitations' },
  detailUseCases: { zh: '使用场景', en: 'Use cases' },
  detailFiles: { zh: '文件结构', en: 'Files' },
  detailSecurity: { zh: '安全审查', en: 'Security review' },
  detailRiskFactors: { zh: '风险因素', en: 'Risk factors' },
  detailOptions: { zh: '可选安装方式', en: 'Install options' },
  detailNoOptions: {
    zh: '没有可安装的包或远端地址。',
    en: 'No installable package or remote endpoint.',
  },
  detailRepository: { zh: '代码仓库', en: 'Repository' },
  detailWebsite: { zh: '官网', en: 'Website' },
  detailViews: { zh: '浏览', en: 'views' },
  cancel: { zh: '取消', en: 'Cancel' },

  // Built-in skills: bundled with the app, so they install without the registry
  builtinGroup: { zh: '内置技能', en: 'Built-in skills' },
  builtinGroupHint: { zh: '随应用提供，无需联网', en: 'Ships with the app · no network' },
  builtinBadge: { zh: '内置', en: 'Built-in' },
  dialogBuiltin: { zh: '会把内置技能复制到源目录：', en: 'Copies the built-in skill into the source:' },
  dialogBuiltinHint: {
    zh: '内容随应用提供，写入前会自动建快照，可在快照面板里整体撤销。',
    en: 'Ships with the app. A snapshot is taken first and can be restored later.',
  },
} satisfies Record<string, Bi>;

export type StoreTextKey = keyof typeof STORE_TEXT;

export const STORE_RISK: Record<string, Bi> = {
  safe: { zh: '安全', en: 'safe' },
  medium: { zh: '中等风险', en: 'medium' },
  high: { zh: '高风险', en: 'high' },
  critical: { zh: '严重风险', en: 'critical' },
};

export const STORE_CATEGORY: Record<string, Bi> = {
  coding: { zh: '编程开发', en: 'Coding' },
  devops: { zh: '运维与基础设施', en: 'DevOps' },
  writing: { zh: '写作与内容', en: 'Writing' },
  documentation: { zh: '文档', en: 'Documentation' },
  productivity: { zh: '效率', en: 'Productivity' },
  office: { zh: '办公与报表', en: 'Office' },
  data: { zh: '数据与分析', en: 'Data' },
  research: { zh: '研究与学习', en: 'Research' },
  communication: { zh: '沟通', en: 'Communication' },
  design: { zh: '设计与创意', en: 'Design' },
  security: { zh: '安全与合规', en: 'Security' },
  legal: { zh: '法务与合同', en: 'Legal' },
};

export function categoryLabel(lang: StoreLang, slug: string): string {
  const entry = STORE_CATEGORY[slug];
  return entry ? pick(lang, entry) : slug;
}

export function riskLabel(lang: StoreLang, risk: string): string {
  const entry = STORE_RISK[risk];
  return entry ? pick(lang, entry) : risk;
}
