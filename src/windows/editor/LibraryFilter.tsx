import { useEffect, useState } from "react";
import clsx from "clsx";
import { IconChevronDown } from "@/components/icons";
import type { Scope, YearGroup } from "./dates";

interface Props {
  groups: YearGroup[];
  total: number;
  scope: Scope;
  onScope: (scope: Scope) => void;
}

/**
 * The library's date tree: everything, then a year, then a month.
 *
 * Two levels and no more. A day level would put a row on screen for most of the
 * captures it was meant to organise, which is the grid's job — the tree exists
 * to get you to roughly the right week, and the search field handles the rest.
 */
export function LibraryFilter({ groups, total, scope, onScope }: Props) {
  const [expanded, setExpanded] = useState<number[]>([]);

  // The newest year opens on its own. It is where nearly every capture is, and
  // an all-collapsed tree makes you click twice to reach the obvious place.
  useEffect(() => {
    const newest = groups[0]?.year;
    if (newest !== undefined) setExpanded((open) => (open.length ? open : [newest]));
  }, [groups]);

  const toggle = (year: number) =>
    setExpanded((open) =>
      open.includes(year) ? open.filter((y) => y !== year) : [...open, year],
    );

  return (
    <nav aria-label="Filter captures by date" className="flex flex-col gap-0.5 text-[12px]">
      <Row
        label="All captures"
        count={total}
        active={scope === null}
        onClick={() => onScope(null)}
      />

      {groups.map((group) => {
        const open = expanded.includes(group.year);
        return (
          <div key={group.year}>
            <Row
              label={String(group.year)}
              count={group.count}
              active={scope?.year === group.year && scope.month === undefined}
              onClick={() => onScope({ year: group.year })}
              // The twisty is its own control: clicking the year should filter
              // to it, not merely unfold it. Conflating the two means you can't
              // ask for a whole year without also being shown its months.
              twisty={{ open, onToggle: () => toggle(group.year) }}
            />

            {open &&
              group.months.map((month) => (
                <Row
                  key={month.month}
                  label={month.label}
                  count={month.count}
                  indent
                  active={scope?.year === group.year && scope.month === month.month}
                  onClick={() => onScope({ year: group.year, month: month.month })}
                />
              ))}
          </div>
        );
      })}
    </nav>
  );
}

function Row({
  label,
  count,
  active,
  indent,
  twisty,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  indent?: boolean;
  twisty?: { open: boolean; onToggle: () => void };
  onClick: () => void;
}) {
  return (
    <div className="flex items-center">
      {twisty ? (
        <button
          type="button"
          onClick={twisty.onToggle}
          aria-label={twisty.open ? `Collapse ${label}` : `Expand ${label}`}
          aria-expanded={twisty.open}
          className="grid size-5 shrink-0 place-items-center rounded text-ink-4 hover:bg-hover hover:text-ink"
        >
          <IconChevronDown className={clsx("size-3", !twisty.open && "-rotate-90")} />
        </button>
      ) : (
        <span className={clsx("shrink-0", indent ? "w-8" : "w-5")} />
      )}

      <button
        type="button"
        onClick={onClick}
        aria-current={active}
        className={clsx(
          "flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-2 py-1 text-left",
          active ? "bg-accent/15 text-accent" : "text-ink-2 hover:bg-hover hover:text-ink",
        )}
      >
        <span className="truncate">{label}</span>
        <span
          className={clsx(
            "shrink-0 font-mono text-[10.5px] tabular-nums",
            active ? "text-accent/80" : "text-ink-4",
          )}
        >
          {count}
        </span>
      </button>
    </div>
  );
}
