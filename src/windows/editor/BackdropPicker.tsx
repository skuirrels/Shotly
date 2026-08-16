import clsx from "clsx";
import { BACKDROP_FILLS, fillToCss } from "@/lib/backdrop";
import { IconBackdrop } from "@/components/icons";
import { Popover } from "@/components/ui/Popover";
import { useEditor } from "@/state/editorStore";

/**
 * The frame around the capture: a colour, some space, rounded corners.
 *
 * Swatches rather than a colour well. There is one good answer here — "make
 * this look deliberate" — and a full picker invites people to spend time on a
 * decision that does not repay it.
 */

/** Padding and rounding, as fractions of the capture's shorter side. */
const PADDING = [
  { label: "S", value: 0.03 },
  { label: "M", value: 0.05 },
  { label: "L", value: 0.09 },
  { label: "XL", value: 0.14 },
];

const ROUNDING = [
  { label: "None", value: 0 },
  { label: "S", value: 0.008 },
  { label: "M", value: 0.015 },
  { label: "L", value: 0.03 },
];

export function BackdropPicker({ disabled }: { disabled?: boolean }) {
  const backdrop = useEditor((s) => s.backdrop);
  const setBackdrop = useEditor((s) => s.setBackdrop);
  const on = backdrop.fill !== "none";

  return (
    <Popover
      align="center"
      trigger={({ open, toggle }) => (
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          title="Frame the capture for sharing"
          aria-label="Backdrop"
          className={clsx(
            "flex h-8 items-center gap-1.5 rounded-lg px-2 text-[12.5px] font-medium transition-colors disabled:opacity-40",
            on
              ? "bg-accent/18 text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]"
              : "text-ink-2 hover:bg-hover hover:text-ink",
            open && !on && "bg-hover",
          )}
        >
          <IconBackdrop />
          Backdrop
        </button>
      )}
    >
      {() => (
        <div className="w-[236px] p-2.5">
          <Row label="Colour">
            <div className="flex flex-wrap gap-1.5">
              <button
                type="button"
                onClick={() => setBackdrop({ fill: "none" })}
                title="No frame"
                aria-label="No frame"
                className={clsx(
                  "size-[22px] rounded-md ring-1 ring-white/15 ring-inset",
                  // A diagonal through an empty square: the usual "nothing
                  // here" swatch, and unmistakable beside six colours.
                  "bg-[linear-gradient(135deg,transparent_45%,rgba(255,255,255,0.5)_45%,rgba(255,255,255,0.5)_55%,transparent_55%)]",
                  !on && "ring-2 ring-white",
                )}
              />
              {BACKDROP_FILLS.map((fill) => (
                <button
                  key={fill.id}
                  type="button"
                  onClick={() => setBackdrop({ fill: fill.id })}
                  title={fill.name}
                  aria-label={fill.name}
                  className={clsx(
                    "size-[22px] rounded-md ring-1 ring-white/15 ring-inset",
                    backdrop.fill === fill.id && "ring-2 ring-white",
                  )}
                  style={{ background: fillToCss(fill) }}
                />
              ))}
            </div>
          </Row>

          {/* The rest only means anything once there is a frame to adjust. */}
          <div className={clsx("transition-opacity", !on && "pointer-events-none opacity-35")}>
            <Row label="Margin">
              <Segments
                options={PADDING}
                value={backdrop.padding}
                onChange={(padding) => setBackdrop({ padding })}
              />
            </Row>
            <Row label="Corners">
              <Segments
                options={ROUNDING}
                value={backdrop.radius}
                onChange={(radius) => setBackdrop({ radius })}
              />
            </Row>
            <label className="mt-2 flex cursor-pointer items-center gap-2 text-[12px] text-ink-2">
              <input
                type="checkbox"
                checked={backdrop.shadow}
                onChange={(e) => setBackdrop({ shadow: e.target.checked })}
                className="accent-[var(--color-accent)]"
              />
              Drop shadow
            </label>
          </div>
        </div>
      )}
    </Popover>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="mb-2.5">
      <div className="mb-1 text-[10.5px] font-semibold tracking-wider text-ink-4 uppercase">
        {label}
      </div>
      {children}
    </div>
  );
}

function Segments({
  options,
  value,
  onChange,
}: {
  options: { label: string; value: number }[];
  value: number;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex gap-1">
      {options.map((option) => (
        <button
          key={option.label}
          type="button"
          onClick={() => onChange(option.value)}
          className={clsx(
            "h-[26px] flex-1 rounded-md text-[11.5px] font-medium transition-colors",
            Math.abs(option.value - value) < 0.0001
              ? "bg-accent/20 text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]"
              : "bg-white/[0.05] text-ink-3 hover:bg-white/[0.09] hover:text-ink-2",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}
