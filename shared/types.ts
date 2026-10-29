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

export type SkillActionKind = 'link' | 'import' | 'remove' | 'unlink';

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
}

export interface PromptSaveRequest {
  content: string;
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

