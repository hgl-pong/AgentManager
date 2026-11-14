// The two catalogs take no sort parameter, so ordering is done on the rows the page already
// holds. That is why every sort is offered as "this page" next to the filters, which the skill
// registry does apply to the whole catalog.

export type StoreSort = 'default' | 'quality' | 'updated' | 'name';

export const SKILL_SORTS: readonly StoreSort[] = ['default', 'quality', 'updated', 'name'];
export const MCP_SORTS: readonly StoreSort[] = ['default', 'updated', 'name'];

interface Sortable {
  name: string;
  updatedAt?: string;
  quality?: number;
}

/** Missing or unreadable dates sort last instead of first. */
function timeOf(value?: string): number {
  if (value === undefined) return Number.NEGATIVE_INFINITY;
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.NEGATIVE_INFINITY : time;
}

/**
 * A sorted copy; `default` keeps the registry's own order (relevance for a search, recency for
 * the featured list). Sorting is stable, so ties keep that order too.
 */
export function sortStoreItems<T extends Sortable>(items: T[], sort: StoreSort): T[] {
  if (sort === 'default') return items;
  const sorted = [...items];
  if (sort === 'name') return sorted.sort((a, b) => a.name.localeCompare(b.name));
  if (sort === 'quality') return sorted.sort((a, b) => (b.quality ?? -1) - (a.quality ?? -1));
  return sorted.sort((a, b) => timeOf(b.updatedAt) - timeOf(a.updatedAt));
}
