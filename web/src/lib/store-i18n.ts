// Every string the store page shows, in both languages. `both` is the default: the app's other
// pages are Chinese, while a skill registry's names, summaries and licences stay in the language
// their publisher wrote them in, so showing the two side by side keeps the page readable either way.

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
    return STORE_LANGS.includes(stored as StoreLang) ? (stored as StoreLang) : 'both';
  } catch {
    return 'both';
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
  language: { zh: '语言', en: 'Language' },
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
  warningPrefix: { zh: '注意：', en: 'Note: ' },
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
