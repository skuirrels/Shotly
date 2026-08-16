import type { LibraryItem } from "@/lib/types";

/**
 * The library as a year/month tree, the way a shelf of captures is actually
 * remembered — "sometime in March" rather than by filename.
 *
 * Grouped on the file's modified time rather than anything parsed out of its
 * name: a capture renamed by hand still belongs to the month it was taken, and
 * a file dropped into the library from elsewhere gets a sensible home instead
 * of none. Local time throughout, since a capture belongs to the day the
 * person taking it was living in.
 */
export interface MonthGroup {
  /** 0–11, as `Date` counts them. */
  month: number;
  label: string;
  count: number;
}

export interface YearGroup {
  year: number;
  count: number;
  months: MonthGroup[];
}

/** What the sidebar has narrowed to. `null` is the whole library. */
export type Scope = { year: number; month?: number } | null;

export function groupByDate(items: LibraryItem[]): YearGroup[] {
  const years = new Map<number, Map<number, number>>();

  for (const item of items) {
    const date = new Date(item.modified);
    const year = date.getFullYear();
    const month = date.getMonth();

    const months = years.get(year) ?? new Map<number, number>();
    months.set(month, (months.get(month) ?? 0) + 1);
    years.set(year, months);
  }

  return [...years.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([year, months]) => ({
      year,
      count: [...months.values()].reduce((sum, n) => sum + n, 0),
      months: [...months.entries()]
        .sort((a, b) => b[0] - a[0])
        .map(([month, count]) => ({ month, label: monthLabel(month), count })),
    }));
}

export function inScope(item: LibraryItem, scope: Scope): boolean {
  if (!scope) return true;
  const date = new Date(item.modified);
  if (date.getFullYear() !== scope.year) return false;
  return scope.month === undefined || date.getMonth() === scope.month;
}

/**
 * Whether a scope still names something that exists.
 *
 * Deleting the last capture of a month would otherwise leave the grid empty
 * with no row selected to explain why.
 */
export function scopeExists(scope: Scope, groups: YearGroup[]): boolean {
  if (!scope) return true;
  const year = groups.find((g) => g.year === scope.year);
  if (!year) return false;
  return scope.month === undefined || year.months.some((m) => m.month === scope.month);
}

/** Full month name in the user's locale: "March". */
function monthLabel(month: number): string {
  // The year is arbitrary — only the month name is read off it.
  return new Date(2000, month, 1).toLocaleDateString(undefined, { month: "long" });
}
