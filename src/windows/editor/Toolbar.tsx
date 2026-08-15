import clsx from "clsx";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { Popover } from "@/components/ui/Popover";
import { Tooltip } from "@/components/ui/Tooltip";
import type { Style } from "@/lib/types";
import { useEditor } from "@/state/editorStore";
import { FONT_PRESETS, STROKE_PRESETS, SWATCHES, TOOLS, styleControlsFor } from "./tools";

/**
 * The floating tool palette.
 *
 * Style controls are contextual — only the ones that affect the current tool
 * or selection appear, so the bar stays short instead of showing a font size
 * next to the blur tool.
 */
export function Toolbar() {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const style = useEditor((s) => s.style);
  const setStyle = useEditor((s) => s.setStyle);
  const annotations = useEditor((s) => s.annotations);
  const selectedIds = useEditor((s) => s.selectedIds);

  // With a selection, the controls follow the selected shape rather than the
  // active tool — that's what the user is actually about to change.
  const selectedKind =
    selectedIds.length > 0
      ? annotations.find((a) => a.id === selectedIds[0])?.kind
      : undefined;
  const controls = styleControlsFor(selectedKind ?? tool);
  const anyControls = Object.values(controls).some(Boolean);

  return (
    <div className="pointer-events-none absolute inset-x-0 bottom-5 z-40 flex justify-center">
      <div className="surface-float pointer-events-auto flex items-center gap-0.5 rounded-2xl p-1.5">
        {TOOLS.map((t) => (
          <IconButton
            key={t.id}
            icon={<t.icon />}
            label={t.label}
            shortcut={t.shortcut}
            active={tool === t.id}
            tooltipSide="top"
            onClick={() => setTool(t.id)}
          />
        ))}

        {anyControls && <Divider />}

        {controls.color && <ColorControl style={style} onChange={setStyle} />}

        {controls.stroke && (
          <SizeControl
            label="Stroke width"
            value={style.strokeWidth}
            presets={STROKE_PRESETS}
            min={1}
            max={40}
            onChange={(strokeWidth) => setStyle({ strokeWidth })}
            render={(v) => (
              <span
                className="rounded-full bg-current"
                style={{ width: Math.min(16, 4 + v), height: Math.min(16, 4 + v) }}
              />
            )}
          />
        )}

        {controls.font && (
          <SizeControl
            label="Font size"
            value={style.fontSize}
            presets={FONT_PRESETS}
            min={10}
            max={120}
            onChange={(fontSize) => setStyle({ fontSize })}
            render={() => <span className="text-[13px] font-semibold">Aa</span>}
          />
        )}

        {controls.blur && (
          <SizeControl
            label="Blur strength"
            value={style.blurRadius}
            presets={[6, 12, 20, 32]}
            min={2}
            max={60}
            onChange={(blurRadius) => setStyle({ blurRadius })}
            render={() => (
              <span className="size-3.5 rounded-full bg-current opacity-60 blur-[1.5px]" />
            )}
          />
        )}

        {controls.dim && (
          <SizeControl
            label="Dim"
            // Stored 0–1, shown as a percentage: "55" is a far more useful
            // thing to read off a slider than "0.55".
            value={Math.round(style.dim * 100)}
            presets={[35, 55, 75, 90]}
            min={10}
            max={95}
            onChange={(pct) => setStyle({ dim: pct / 100 })}
            render={() => (
              <span className="size-3.5 rounded-[4px] border border-current bg-current/45" />
            )}
          />
        )}

        {controls.fill && (
          <Tooltip label={style.fillOpacity > 0 ? "Remove fill" : "Fill shape"} side="top">
            <button
              type="button"
              aria-pressed={style.fillOpacity > 0}
              onClick={() => setStyle({ fillOpacity: style.fillOpacity > 0 ? 0 : 0.25 })}
              className={clsx(
                "grid h-[30px] w-[30px] place-items-center rounded-lg transition-colors duration-100",
                style.fillOpacity > 0
                  ? "bg-accent/18 text-accent"
                  : "text-ink-2 hover:bg-hover hover:text-ink",
              )}
            >
              <span
                className="size-3.5 rounded-[4px] border-2 border-current"
                style={{
                  background:
                    style.fillOpacity > 0 ? `color-mix(in srgb, currentColor 45%, transparent)` : "transparent",
                }}
              />
            </button>
          </Tooltip>
        )}
      </div>
    </div>
  );
}

function Divider() {
  return <span className="mx-1 h-5 w-px bg-white/10" />;
}

function ColorControl({
  style,
  onChange,
}: {
  style: Style;
  onChange: (patch: Partial<Style>) => void;
}) {
  return (
    <Popover
      trigger={({ open, toggle }) => (
        <Tooltip label="Colour" shortcut="1" side="top">
          <button
            type="button"
            onClick={toggle}
            aria-label="Colour"
            className={clsx(
              "grid h-[30px] w-[30px] place-items-center rounded-lg transition-colors duration-100",
              open ? "bg-pressed" : "hover:bg-hover",
            )}
          >
            <span
              className="size-[17px] rounded-full ring-1 ring-white/25 ring-inset"
              style={{ background: style.color }}
            />
          </button>
        </Tooltip>
      )}
    >
      <div className="w-[188px]">
        <div className="grid grid-cols-5 gap-1.5">
          {SWATCHES.map((s, i) => {
            const active = s.value.toLowerCase() === style.color.toLowerCase();
            return (
              <Tooltip key={s.value} label={s.name} shortcut={i < 9 ? String(i + 1) : undefined}>
                <button
                  type="button"
                  aria-label={s.name}
                  onClick={() => onChange({ color: s.value })}
                  className={clsx(
                    "grid h-8 place-items-center rounded-lg transition-transform duration-100",
                    "hover:scale-105 active:scale-95",
                    active && "ring-2 ring-accent",
                  )}
                >
                  <span
                    className="size-[19px] rounded-full ring-1 ring-white/20 ring-inset"
                    style={{ background: s.value }}
                  />
                </button>
              </Tooltip>
            );
          })}
        </div>

        <label className="mt-2.5 flex items-center gap-2 rounded-lg bg-black/25 px-2 py-1.5">
          <input
            type="color"
            value={style.color}
            onChange={(e) => onChange({ color: e.target.value })}
            className="size-5 cursor-pointer rounded border-none bg-transparent p-0"
          />
          <span className="font-mono text-[11px] text-ink-2 uppercase">{style.color}</span>
        </label>
      </div>
    </Popover>
  );
}

function SizeControl({
  label,
  value,
  presets,
  min,
  max,
  onChange,
  render,
}: {
  label: string;
  value: number;
  presets: number[];
  min: number;
  max: number;
  onChange: (v: number) => void;
  render: (v: number) => React.ReactNode;
}) {
  return (
    <Popover
      trigger={({ open, toggle }) => (
        <Tooltip label={label} side="top">
          <button
            type="button"
            onClick={toggle}
            aria-label={label}
            className={clsx(
              "grid h-[30px] min-w-[30px] place-items-center rounded-lg px-2 transition-colors duration-100",
              open ? "bg-pressed text-ink" : "text-ink-2 hover:bg-hover hover:text-ink",
            )}
          >
            {render(value)}
          </button>
        </Tooltip>
      )}
    >
      <div className="w-[200px]">
        <div className="flex items-center justify-between px-0.5 pb-2">
          <span className="text-[11px] font-medium tracking-wide text-ink-3 uppercase">{label}</span>
          <span className="font-mono text-[11px] tabular-nums text-ink-2">{Math.round(value)}</span>
        </div>

        <div className="mb-2.5 flex items-center gap-1">
          {presets.map((p) => (
            <button
              key={p}
              type="button"
              onClick={() => onChange(p)}
              className={clsx(
                "h-7 flex-1 rounded-md font-mono text-[11px] tabular-nums transition-colors duration-100",
                Math.round(value) === p
                  ? "bg-accent/18 text-accent"
                  : "bg-white/[0.05] text-ink-2 hover:bg-hover hover:text-ink",
              )}
            >
              {p}
            </button>
          ))}
        </div>

        <input
          type="range"
          min={min}
          max={max}
          value={value}
          onChange={(e) => onChange(Number(e.target.value))}
          className="w-full accent-[var(--color-accent)]"
        />

        <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-3">
          <Kbd shortcut="[" muted />
          <Kbd shortcut="]" muted />
          to adjust
        </p>
      </div>
    </Popover>
  );
}
