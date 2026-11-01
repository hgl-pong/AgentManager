// One definition of "needs attention" for the sidebar badges, the per-page filters and the
// legends, so a count shown in the sidebar always matches the rows the page then hides.
// States whose rows are informational only (unsupported agent, not applicable) never count.
import type { CellState, HookMatrixReport, HookMatrixRow, HookState, McpMatrixRow, McpState, Row } from '../../../shared/types.ts';

/** True when this state needs a decision or an action from the user. */
export function needsAttention(state: CellState | McpState | HookState): boolean {
  return state !== 'synced' && state !== 'linked' && state !== 'unsupported' && state !== 'none';
}

/** A skill row matters when any agent cell needs attention. */
export function countSkillRows(rows: readonly Row[] | undefined): number {
  return (rows ?? []).filter((row) => Object.values(row.cells).some((cell) => needsAttention(cell.state))).length;
}

export function countMcpRows(rows: readonly McpMatrixRow[] | undefined): number {
  return (rows ?? []).filter((row) => Object.values(row.cells).some((cell) => needsAttention(cell.state))).length;
}

/** An agent without native hooks support cannot be fixed from here, so its cells never count. */
export function hookStatesOf(row: HookMatrixRow, report: HookMatrixReport): Set<HookState> {
  const states = new Set<HookState>();
  for (const agent of report.agents) {
    if (agent.supported) states.add((row.cells[agent.key] ?? { state: 'none' }).state);
  }
  return states;
}

export function countHookRows(report: HookMatrixReport | null | undefined): number {
  if (!report) return 0;
  return report.rows.filter((row) => [...hookStatesOf(row, report)].some(needsAttention)).length;
}
