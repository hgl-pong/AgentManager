// The API contract shared by the server and the browser. Keep it free of node: imports so the
// client bundle never pulls in filesystem code.

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
}

// ---- skills write actions ----

export type SkillActionKind = 'link' | 'import' | 'remove';

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
  action: 'init' | 'align';
  snapshotId: string;
  message: string;
  report: PromptsReport;
}

export interface PromptActionRequest {
  action: 'init' | 'align';
  agent?: string;
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
}

export interface RestoreReport {
  restored: string[];
  removed: string[];
  missing: string[];
}

export interface RestoreResponse {
  report: RestoreReport;
  matrix: MatrixResponse;
}
