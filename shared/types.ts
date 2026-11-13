// The API contract shared by the server and the browser. Keep it free of node: imports so the
// client bundle never pulls in filesystem code.

/** A request failure that carries the HTTP status the server must answer with. */
export class AppError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'AppError';
    this.status = status;
  }
}

export type CellState = 'linked' | 'broken' | 'external' | 'copy' | 'orphan' | 'missing';

export interface Cell {
  state: CellState;
  /** Absolute path of the entry inside the agent directory; absent when the entry does not exist. */
  path?: string;
  /** Resolved link target; only set for links whose target exists. */
  target?: string;
  /** Only set for copies: whether the copy's content hash equals the source skill's. */
  hashMatch?: boolean;
}

export interface AgentSpec {
  key: string;
  label: string;
  root: string;
}

export interface AgentReport extends AgentSpec {
  detected: boolean;
}

export interface Row {
  name: string;
  inSource: boolean;
  cells: Record<string, Cell>;
}

export interface Matrix {
  source: { path: string; skills: string[] };
  agents: AgentReport[];
  rows: Row[];
}

export interface ScanInput {
  source: string;
  agents: AgentSpec[];
}

export interface MatrixResponse extends Matrix {
  scannedAt: string;
  durationMs: number;
  /** Set when a write succeeded but the follow-up scan failed; the matrix is then a usable stub. */
  warning?: string;
}

// ---- skills write actions ----

export type SkillActionKind = 'link' | 'import' | 'remove' | 'unlink' | 'delete';

export interface SkillActionRequest {
  agent: string;
  action: SkillActionKind;
  name: string;
}

export interface SkillActionResponse {
  message: string;
  snapshotId: string;
  matrix: MatrixResponse;
}

// ---- prompts ----

export interface PromptTargetSpec {
  key: string;
  label: string;
  path: string;
}

export type PromptState = 'no-source' | 'missing' | 'synced' | 'drift' | 'broken' | 'external-link';
export type PromptLink = 'symlink' | 'hardlink' | 'copy' | 'none';

export interface PromptTargetReport extends PromptTargetSpec {
  state: PromptState;
  link: PromptLink;
  bytes?: number;
  target?: string;
}

export interface PromptsReport {
  source: { path: string; exists: boolean; bytes?: number };
  targets: PromptTargetReport[];
}

export interface PromptActionReport {
  action: 'init' | 'align' | 'save';
  snapshotId: string;
  message: string;
  report: PromptsReport;
}

export interface PromptActionRequest {
  action: 'init' | 'align';
  agent?: string;
}

export interface PromptSourceContent {
  path: string;
  exists: boolean;
  content: string;
  bytes: number;
  /** Optimistic-lock token of the text above; a save must echo it so external edits are caught. */
  etag: string;
}

export interface PromptSaveRequest {
  content: string;
  /** The etag of the content this draft was based on. */
  etag: string;
}

export interface PromptSaveReport extends PromptActionReport {
  content: PromptSourceContent;
}

// ---- settings / MCP ----

export type ConfigFormat = 'json' | 'toml';

export interface ConfigFileSpec {
  agent: string;
  label: string;
  path: string;
  format: ConfigFormat;
  role: string;
  /** False for files whose top-level keys are noise (e.g. ~/.claude.json state). */
  listKeys?: boolean;
}

export interface ConfigKey {
  key: string;
  preview: string;
}

export interface ConfigFileReport extends ConfigFileSpec {
  exists: boolean;
  bytes?: number;
  error?: string;
  keys: ConfigKey[];
  mcpKeys: string[];
}

export interface McpCell {
  file: string;
  summary: string;
}

export interface McpRow {
  name: string;
  /** One entry per definition; an agent can define the same server in two files. */
  byAgent: Record<string, McpCell[]>;
}

export interface ConfigReport {
  files: ConfigFileReport[];
  servers: McpRow[];
}

// ---- snapshots ----

export type SnapshotEntryKind = 'file' | 'dir' | 'link';

export interface SnapshotEntry {
  originalPath: string;
  storedPath: string | null;
  kind: SnapshotEntryKind;
  linkTarget?: string;
  linkType?: 'junction' | 'file';
}

export interface SnapshotManifest {
  id: string;
  createdAt: string;
  operation: string;
  entries: SnapshotEntry[];
  created: string[];
  /** Restore regular files by overwriting their content instead of replacing the inode. */
  writeInPlace?: boolean;
}

export interface RestoreReport {
  restored: string[];
  removed: string[];
  missing: string[];
  /** Created by the snapshot but re-created on disk since; kept as-is and backed up in the undo snapshot. */
  kept: string[];
}

export interface RestoreResponse {
  report: RestoreReport;
  matrix: MatrixResponse;
  /** Snapshot taken right before the restore; restoring it undoes this restore. */
  snapshotId?: string;
}

// ---- app lifecycle ----

export interface HealthResponse {
  app: string;
  version: string;
  pid: number;
  port: number;
  url: string;
  source: string;
  dataDir: string;
  startedAt: string;
  uptimeSeconds: number;
}

export interface OpenResponse {
  opened: string;
}

// ---- editable settings ----

export type SettingsFieldType = 'string' | 'number' | 'integer' | 'boolean' | 'array' | 'object' | 'json';

/** A simplified, renderable field derived from an agent's official schema. */
export interface SettingsField {
  key: string;
  /** Dot path inside the settings object (used by the translation catalog). */
  path?: string;
  type: SettingsFieldType;
  description?: string;
  default?: unknown;
  enum?: Array<string | number | boolean>;
  /** Enum values that are suggestions only; any string is allowed. */
  suggestions?: Array<string | number | boolean>;
  minimum?: number;
  maximum?: number;
  pattern?: string;
  sensitive?: boolean;
  deprecated?: boolean;
  /** Managed-settings-only key: writing it to a user file has no effect. */
  managedOnly?: boolean;
  /** The value is executed as a command when the agent runs; confirm before writing. */
  executable?: boolean;
  /** True when the object is a free-form key/value map. */
  map?: boolean;
  mapValue?: SettingsField;
  /** Known keys for a free-form map (used as autocomplete suggestions). */
  knownKeys?: Array<{ key: string; description?: string }>;
  additionalLabel?: string;
  long?: boolean;
  fields?: SettingsField[];
  items?: SettingsField;
  group?: string;
  hidden?: boolean;
}

export interface SettingsSection {
  key: string;
  label: string;
  fields: SettingsField[];
}

export interface SettingsAgentCatalog {
  key: string;
  label: string;
  schemaUrl: string;
  common: string[];
  sections: SettingsSection[];
  mcp: { fileId: string; key: string };
}

export interface SettingsCatalog {
  agents: SettingsAgentCatalog[];
}

export type SettingsFormat = 'json' | 'toml';
export type SettingsScope = 'full' | 'mcp';

export interface SettingsFileDescriptor {
  id: string;
  agent: string;
  label: string;
  path: string;
  format: SettingsFormat;
  role: string;
  /** full: `data` is the whole file object. mcp: `data` is only the server map. */
  scope: SettingsScope;
  /** For scope mcp, the key that holds the map inside the host file. */
  mcpKey?: string;
  /** For scope mcp, the file that actually stores the map when it differs from `path`. */
  hostPath?: string;
}

export interface SettingsFileState extends SettingsFileDescriptor {
  exists: boolean;
  /** Hash of the on-disk text (or "missing"); saves must send it back. */
  etag: string;
  bytes?: number;
  data?: unknown;
  /** Canonical text (full file, or the mcp map) for the raw editor. */
  text?: string;
  parseError?: string;
}

export interface SettingsAgentFiles {
  key: string;
  label: string;
  files: SettingsFileState[];
}

export interface SettingsReport {
  agents: SettingsAgentFiles[];
}

export interface SettingsSaveRequest {
  fileId: string;
  etag: string;
  /** Structured object; ignored when `text` is present. */
  data?: unknown;
  /** Raw JSON/TOML text; the server validates it before writing. */
  text?: string;
}

export interface SettingsSaveResult {
  snapshotId: string;
  file: SettingsFileState;
}

export interface SettingsFieldError {
  path: string;
  message: string;
}

// ---- model catalog ----

export interface ModelInfo {
  id: string;
  name: string;
  /** `default` for bare IDs, otherwise the prefix before the first slash. */
  group: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  thinking?: boolean;
  effort?: boolean;
  /** Supported reasoning-effort levels, e.g. ["low","medium","high","xhigh"]. */
  effortLevels?: string[];
  imageInput?: boolean;
  pdfInput?: boolean;
}

export interface ModelsReport {
  /** The URL that was queried. */
  source: string;
  fetchedAt: string;
  cached: boolean;
  /** True when the endpoint failed but an older cached list is being used. */
  stale?: boolean;
  error?: string;
  models: ModelInfo[];
}

// ---- model providers ----

/** A saved provider as the browser sees it: the API key never leaves the server. */
export interface ProviderSummary {
  id: string;
  baseUrl: string;
  /** Display identity derived from the base URL; no extra name field is required. */
  host: string;
  hasApiKey: boolean;
  active: boolean;
  updatedAt: string;
}

export interface ProvidersReport {
  /** File that stores the providers; useful for diagnostics, not for display of secrets. */
  source: string;
  activeId: string | null;
  providers: ProviderSummary[];
}

export interface ProviderSaveRequest {
  /** Absent for a new provider. */
  id?: string;
  baseUrl: string;
  /** Empty on update keeps the saved key; required when creating. */
  apiKey?: string;
}

export interface ProviderActionRequest {
  id: string;
}

export interface ProviderMutationResponse {
  message: string;
  snapshotId: string;
  report: ProvidersReport;
}

export interface ProviderModelsReport extends ModelsReport {
  /** The provider that supplied the list; null when no provider is configured. */
  provider: ProviderSummary | null;
}

// ---- apply a provider model to agent configs ----

export interface ModelTargetFile {
  label: string;
  path: string;
}

export interface ModelTargetAgent {
  key: string;
  label: string;
  detected: boolean;
  files: ModelTargetFile[];
}

export interface ModelTargetsReport {
  agents: ModelTargetAgent[];
}

export interface ModelApplyRequest {
  modelId: string;
  agents: string[];
}

export interface ModelApplyAgentSummary {
  key: string;
  label: string;
  files: string[];
  snapshotIds: string[];
  /** Keys or sections written, for the confirmation/result copy; never values. */
  writes: string[];
}

export interface ModelApplyResponse {
  message: string;
  model: { id: string; name: string; providerHost: string };
  agents: ModelApplyAgentSummary[];
  snapshotIds: string[];
}

// ---- MCP management ----

export type McpTransport = 'stdio' | 'http' | 'sse';

/** The agent-neutral shape stored in ~/.agents/mcp/servers.json. */
export interface McpServerDefinition {
  transport: McpTransport;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
}

export type McpState = 'synced' | 'drift' | 'missing' | 'orphan' | 'invalid' | 'unsupported';

export interface McpAgentInfo {
  key: string;
  label: string;
  file: string;
  format: SettingsFormat;
}

export interface McpMatrixCell {
  state: McpState;
  summary?: string;
  error?: string;
}

export interface McpMatrixRow {
  name: string;
  inSource: boolean;
  source?: McpServerDefinition;
  cells: Record<string, McpMatrixCell>;
}

export interface McpMatrixReport {
  source: {
    path: string;
    exists: boolean;
    bytes?: number;
    error?: string;
    serverCount: number;
  };
  agents: McpAgentInfo[];
  rows: McpMatrixRow[];
  scannedAt: string;
}

export type McpActionKind = 'import' | 'importAll' | 'saveSource' | 'deleteSource' | 'sync' | 'remove';

export interface McpActionRequest {
  action: McpActionKind;
  name?: string;
  /** Single-agent actions: import / sync / remove. */
  agent?: string;
  /** sync: targets; saveSource: agents to sync after saving. */
  agents?: string[];
  /** saveSource payload. */
  server?: McpServerDefinition;
  /** importAll conflict preference (defaults to claude). */
  prefer?: string;
}

export interface McpActionResponse {
  message: string;
  snapshotIds: string[];
  warnings: string[];
  report: McpMatrixReport;
}

// ---- Hooks management ----

export type HookState = 'synced' | 'drift' | 'missing' | 'orphan' | 'unsupported' | 'none';

export interface HookAgentInfo {
  key: string;
  label: string;
  file: string;
  format: SettingsFormat;
  /** False for agents without native lifecycle hooks (pi). */
  supported: boolean;
}

export interface HookMatrixCell {
  state: HookState;
  summary?: string;
  error?: string;
}

export interface HookMatrixRow {
  event: string;
  inSource: boolean;
  /** Agents that have a source definition for this event. */
  sourceAgents: string[];
  /** The source arrays, used to prefill the editor. */
  source?: Record<string, unknown[]>;
  cells: Record<string, HookMatrixCell>;
}

export interface HookMatrixReport {
  source: {
    path: string;
    exists: boolean;
    bytes?: number;
    error?: string;
    eventCount: number;
  };
  agents: HookAgentInfo[];
  rows: HookMatrixRow[];
  warnings?: string[];
  /** Known event names for the editor's suggestions. */
  events: string[];
  scannedAt: string;
}

export type HookActionKind = 'import' | 'importAll' | 'saveSource' | 'deleteSource' | 'sync' | 'remove';

export interface HookActionRequest {
  action: HookActionKind;
  event?: string;
  agent?: string;
  agents?: string[];
  /** saveSource: event arrays keyed by agent (claude / codex). */
  definitions?: Record<string, unknown[]>;
  /** importAll conflict preference (defaults to claude). */
  prefer?: string;
}

export interface HookActionResponse {
  message: string;
  snapshotIds: string[];
  warnings: string[];
  report: HookMatrixReport;
}

// ---- cache management ----

/** `cache` is regenerable machine data; `history` holds conversations the user may want to keep. */
export type CacheRisk = 'cache' | 'history';

export type CacheTargetKind = 'dir' | 'file' | 'glob';

/** A known place an agent grows over time. The list is built from paths, never from user input. */
export interface CacheTargetSpec {
  id: string;
  agent: string;
  agentLabel: string;
  label: string;
  /** Absolute path; for `glob` the last segment may contain `*`. */
  path: string;
  kind: CacheTargetKind;
  risk: CacheRisk;
  note?: string;
  /** What the "open" button opens: the path itself, or the parent of a glob. */
  openPath: string;
}

/** Files older than `days`; every target reports one entry per known threshold. */
export interface CacheBucket {
  days: number;
  bytes: number;
  files: number;
}

export interface CacheTargetReport extends CacheTargetSpec {
  exists: boolean;
  bytes: number;
  files: number;
  oldest?: string;
  newest?: string;
  buckets: CacheBucket[];
  error?: string;
}

export interface CacheRecycleEntry {
  originalPath: string;
  storedPath: string;
  kind: 'file' | 'dir';
  bytes: number;
  files: number;
}

/** One clean operation: what moved out of the agent directory, and where it now waits. */
export interface CacheRecycleItem {
  id: string;
  createdAt: string;
  operation: string;
  targetIds: string[];
  entries: CacheRecycleEntry[];
  bytes: number;
  files: number;
}

export interface CacheRecycleReport {
  path: string;
  items: CacheRecycleItem[];
  bytes: number;
  files: number;
}

export interface CacheReport {
  targets: CacheTargetReport[];
  recycle: CacheRecycleReport;
  scannedAt: string;
  durationMs: number;
}

// ---- skill store ----

/** Which catalog a store response describes. */
export type StoreKind = 'skill' | 'mcp';

/** A skill the registry offers. `id` is the registry slug and stays stable across pages. */
export interface StoreSkill {
  id: string;
  slug: string;
  /** Publisher handle (GitHub user or organization). */
  owner: string;
  /** Skill name, which becomes the directory name inside the source. */
  name: string;
  summary: string;
  category?: string;
  /** Stated risk of running the skill; the registry audits its scripts. */
  risk?: 'safe' | 'medium' | 'high' | 'critical';
  license?: string;
  repository?: string;
  quality?: number;
  hasScripts?: boolean;
  needsNetwork?: boolean;
  downloads: number;
  favorites: number;
  version?: string;
  updatedAt?: string;
  /** True when the source already holds a skill directory with this name (or the slug). */
  inSource: boolean;
  /** True for a skill that ships inside the app instead of coming from the registry. */
  builtin?: boolean;
}

/** `featured` is the registry's own ordering; `search` is an answer to a query. */
export type StoreListing = 'featured' | 'search';

/** One way the registry's AI review says a skill can be used. */
export interface StoreSkillUseCase {
  title: string;
  description: string;
}

/** One entry of the skill's file tree, as the registry reports it. */
export interface StoreSkillFile {
  path: string;
  type: string;
  lines?: number;
}

/**
 * The extra detail `/api/skills/<slug>` carries. The catalog row is enough for a card, but a
 * preview needs the full description, the AI review and the file list.
 */
export interface StoreSkillDetail extends StoreSkill {
  aiTitle?: string;
  aiSummary?: string;
  valueStatement?: string;
  capabilities: string[];
  limitations: string[];
  useCases: StoreSkillUseCase[];
  files: StoreSkillFile[];
  /** Plain-language result of the registry's static analysis. */
  securitySummary?: string;
  /** Raw risk-factor keys such as `external_commands`. */
  riskFactors: string[];
  viewCount: number;
}

export interface StoreReportBase {
  provider: string;
  /** The registry base URL that answered. */
  endpoint: string;
  query: string;
  listing: StoreListing;
  /** 1-based page of the registry result set that `items` holds. */
  page: number;
  limit: number;
  totalPages: number;
  /** How many entries the registry says match, which can be more than `items`. */
  total: number;
  fetchedAt: string;
  cached: boolean;
  /** True when the registry failed and an older answer is being shown. */
  stale?: boolean;
  error?: string;
  sourcePath: string;
}

export interface StoreSkillReport extends StoreReportBase {
  kind: 'skill';
  items: StoreSkill[];
}

/** A value the registry needs before a server can be saved; the install dialog collects it. */
export interface StoreMcpVariable {
  /** Where the entered value goes when the dialog completes the definition. */
  target: 'env' | 'header' | 'url' | 'template';
  /** Env/header key, the `{name}` token inside a remote URL, or a `{name}` token inside any value. */
  name: string;
  description?: string;
  isSecret?: boolean;
}

/** One way the registry says a server can be run. */
export interface StoreMcpOption {
  id: string;
  /** Short technical description, e.g. `npm @scope/server@1.2.0` or `http api.example.com`. */
  label: string;
  transport: McpTransport;
  /** The definition to save; required values are left out and listed in `variables`. */
  server: McpServerDefinition;
  variables: StoreMcpVariable[];
}

/** An MCP server the official registry offers. `id` is its reverse-DNS name. */
export interface StoreMcpServer {
  id: string;
  /** Display name: the registry title, or the tail of the reverse-DNS name. */
  name: string;
  /** The namespace part of the reverse-DNS name. */
  owner: string;
  /** Suggested key inside servers.json, derived from the name. */
  installName: string;
  summary: string;
  version?: string;
  repository?: string;
  websiteUrl?: string;
  updatedAt?: string;
  options: StoreMcpOption[];
  /** True when the MCP source already holds a server with `installName`. */
  inSource: boolean;
}

export interface StoreMcpReport extends StoreReportBase {
  kind: 'mcp';
  /** The registry pages by cursor and reports no total; `total` stays 0. */
  nextCursor?: string;
  items: StoreMcpServer[];
}

export type StoreReport = StoreSkillReport | StoreMcpReport;

export interface StoreInstallRequest {
  owner: string;
  slug: string;
  /** Directory name inside the source; defaults to the slug. */
  name?: string;
  /** Agents to link after installing; omitted means "install only". */
  agents?: string[];
}

export interface StoreInstallLink {
  agent: string;
  label: string;
  state: 'linked' | 'skipped' | 'failed';
  message: string;
}

export interface StoreInstallReport {
  message: string;
  name: string;
  path: string;
  files: number;
  bytes: number;
  snapshotId: string;
  links: StoreInstallLink[];
  warnings: string[];
}

export interface StoreInstallResponse extends StoreInstallReport {
  matrix: MatrixResponse;
}

// ---- built-in skills ----

/** A skill bundled with the app: the list carries the whole preview, so it works offline. */
export interface BuiltinSkill extends StoreSkillDetail {
  builtin: true;
}

export interface BuiltinSkillReport {
  sourcePath: string;
  items: BuiltinSkill[];
}

export interface BuiltinInstallRequest {
  name: string;
  /** Agents to link after copying; omitted means "copy only". */
  agents?: string[];
}

export interface BuiltinInstallResponse extends StoreInstallReport {
  matrix: MatrixResponse;
}

/** The dialog builds the complete definition from one registry option plus the values it asked for. */
export interface StoreMcpInstallRequest {
  name: string;
  server: McpServerDefinition;
  /** Agents to sync after saving; omitted means "write the source only". */
  agents?: string[];
}

export interface StoreMcpInstallResponse {
  message: string;
  name: string;
  snapshotIds: string[];
  warnings: string[];
  report: McpMatrixReport;
}

export type CacheActionKind = 'clean' | 'restore' | 'purge';

export interface CacheActionRequest {
  action: CacheActionKind;
  /** clean: the target ids to clean. */
  ids?: string[];
  /** clean: only files older than this many days move; 0 moves the whole target. */
  olderThanDays?: number;
  /** restore / purge: recycle ids; a purge without ids empties the whole bin. */
  recycleIds?: string[];
}

export interface CacheActionResponse {
  message: string;
  movedBytes?: number;
  movedFiles?: number;
  recycleId?: string;
  /** Paths a restore left in the bin because something else now occupies the original spot. */
  skipped?: string[];
  report: CacheReport;
}

