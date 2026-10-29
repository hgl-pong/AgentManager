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
