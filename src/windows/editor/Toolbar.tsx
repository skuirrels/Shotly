import clsx from "clsx";
import { IconCollapse, IconExpand } from "@/components/icons";
import { IconButton } from "@/components/ui/IconButton";
import { Kbd } from "@/components/ui/Kbd";
import { Popover } from "@/components/ui/Popover";
import { Tooltip } from "@/components/ui/Tooltip";
import type { Style } from "@/lib/types";
import { withAlpha } from "@/lib/shapes";
import {
  MAX_FONT,
  MAX_RADIUS,
  MAX_STROKE,
  MIN_FONT,
  MIN_RADIUS,
  MIN_STROKE,
  shownStyle,
  useEditor,
} from "@/state/editorStore";
import { OverlayPicker } from "./OverlayPicker";
import {
  FONT_PRESETS,
  NEON_SWATCHES,
  RADIUS_PRESETS,
  STROKE_PRESETS,
  SWATCHES,
  TOOLS,
  styleControlsFor,
} from "./tools";

/**
 * The floating tool palette.
 *
 * Style controls are contextual — only the ones that affect the current tool
 * or selection appear, so the bar stays short instead of showing a font size
 * next to the blur tool.
 */
interface Props {
  /** Passed through to the overlay picker; see `OverlayPicker`. */
  currentPath?: string;
  onNotify: (text: string) => void;
  /** Whether the rest of the chrome is currently hidden. */
  focus: boolean;
  onToggleFocus: () => void;
}

export function Toolbar({ currentPath, onNotify, focus, onToggleFocus }: Props) {
  const tool = useEditor((s) => s.tool);
  const setTool = useEditor((s) => s.setTool);
  const setStyle = useEditor((s) => s.setStyle);
  const annotations = useEditor((s) => s.annotations);
  const selectedIds = useEditor((s) => s.selectedIds);
  const retina = useEditor((s) => (s.doc?.scale ?? 1) > 1);

  // With a selection, the controls follow the selected shape rather than the
  // active tool — that's what the user is actually about to change.
  const selectedKind =
    selectedIds.length > 0
      ? annotations.find((a) => a.id === selectedIds[0])?.kind
      : undefined;
  const kind = selectedKind ?? tool;
  const controls = styleControlsFor(kind);
  const anyControls = Object.values(controls).some(Boolean);

  // Every control reads whichever style it is about to write: the selected
  // shape's own, or — with nothing selected — the ink this tool was last used
  // with. See `shownStyle`.
  const style = useEditor(shownStyle);

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

        {/* Not one of the TOOLS: nothing is drawn with it, so it opens a menu
            of sources instead of becoming the tool in hand. */}
        <OverlayPicker currentPath={currentPath} onNotify={onNotify} />

        {/* The way out, and the reason it lives on the tool palette rather
            than the top bar: in focus mode this is the only bar left, so the
            button that leaves has to be one of the ones still on screen. */}
        <Divider />
        <IconButton
          icon={focus ? <IconCollapse /> : <IconExpand />}
          label={focus ? "Leave focus mode" : "Focus mode"}
          shortcut="Mod+Shift+F"
          active={focus}
          tooltipSide="top"
          onClick={onToggleFocus}
        />

        {anyControls && <Divider />}

        {controls.color && <ColorControl style={style} onChange={setStyle} />}

        {controls.stroke && (
          <SizeControl
            label="Stroke width"
            value={style.strokeWidth}
            presets={STROKE_PRESETS}
            min={MIN_STROKE}
            max={MAX_STROKE}
            onChange={(strokeWidth) => setStyle({ strokeWidth })}
            render={(v) => (
              <span
                className="rounded-full bg-current"
                style={{ width: Math.min(16, 4 + v), height: Math.min(16, 4 + v) }}
              />
            )}
          />
        )}

        {/* Next to the stroke width, because the two of them are the whole
            description of a rectangle's outline. */}
        {controls.radius && (
          <SizeControl
            label="Corner radius"
            value={style.cornerRadius}
            presets={RADIUS_PRESETS}
            min={MIN_RADIUS}
            max={MAX_RADIUS}
            hint="0 is a square corner."
            onChange={(cornerRadius) => setStyle({ cornerRadius })}
            // The chip is the setting: a small square rounded off in step with
            // the number, so the button shows the corner rather than naming
            // it. Capped short of half its own side, or every radius past the
            // fourth preset would draw the same circle.
            render={(v) => (
              <span
                className="size-[15px] border-2 border-current"
                style={{ borderRadius: Math.min(7, v / 8) }}
              />
            )}
          />
        )}

        {controls.font && (
          <SizeControl
            label="Font size"
            value={style.fontSize}
            presets={FONT_PRESETS}
            min={MIN_FONT}
            max={MAX_FONT}
            onChange={(fontSize) => setStyle({ fontSize })}
            render={() => <span className="text-[13px] font-semibold">Aa</span>}
          />
        )}

        {/* Beside the colour and the size, because that is what it is: a way
            of drawing the colour you already picked. The swatch inside the
            button glows when it is on, so the button shows the effect rather
            than only naming it. */}
        {controls.neon && (
          <Tooltip label="Neon" shortcut="Shift+N" side="top">
            <button
              type="button"
              aria-label="Neon"
              aria-pressed={style.neon}
              onClick={() => setStyle({ neon: !style.neon })}
              className={clsx(
                "no-drag grid h-[30px] w-[30px] place-items-center rounded-lg transition-colors duration-100",
                style.neon ? "bg-white/[0.06]" : "text-ink-2 hover:bg-hover hover:text-ink",
              )}
            >
              <span
                className="size-[15px] rounded-[5px] border-2 transition-shadow"
                style={{
                  borderColor: style.color,
                  background: style.neon ? withAlpha(style.color, 0.3) : "transparent",
                  boxShadow: style.neon
                    ? `0 0 6px ${style.color}, 0 0 12px ${style.color}`
                    : undefined,
                  opacity: style.neon ? 1 : 0.55,
                }}
              />
            </button>
          </Tooltip>
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

        {/* Only ever offered on a Retina capture: at 1x the two units are the
            same number, and a switch between two identical readings is a
            control that does nothing. */}
        {controls.units && retina && (
          <Tooltip label="What the measurement counts in" side="top">
            <div className="flex items-center gap-0.5 rounded-lg bg-black/25 p-0.5">
              {(["pt", "px"] as const).map((unit) => (
                <button
                  key={unit}
                  type="button"
                  aria-pressed={style.measureUnits === unit}
                  onClick={() => setStyle({ measureUnits: unit })}
                  className={clsx(
                    "h-[26px] rounded-md px-2 font-mono text-[11px] transition-colors",
                    style.measureUnits === unit
                      ? "bg-white/[0.12] text-ink"
                      : "text-ink-3 hover:text-ink",
                  )}
                >
                  {unit}
                </button>
              ))}
            </div>
          </Tooltip>
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

        {/* The neon row. Drawn as lit chips rather than flat dots: these are
            the colours that look wrong flat and right glowing, and picking one
            out of a row of plain circles tells you nothing about that. */}
        <p className="mt-3 mb-1.5 text-[10px] font-semibold tracking-wider text-ink-4 uppercase">
          Neon
        </p>
        <div className="grid grid-cols-5 gap-1.5">
          {NEON_SWATCHES.map((s) => {
            const active = s.value.toLowerCase() === style.color.toLowerCase();
            return (
              <Tooltip key={s.value} label={s.name}>
                <button
                  type="button"
                  aria-label={s.name}
                  // Picking a neon ink turns neon on, on the tools that have
                  // it. Choosing "Hot pink" and getting a flat pink box would
                  // be the picker showing you one thing and drawing another.
                  onClick={() => onChange({ color: s.value, neon: true })}
                  className={clsx(
                    "grid h-8 place-items-center rounded-lg transition-transform duration-100",
                    "hover:scale-105 active:scale-95",
                    active && "ring-2 ring-accent",
                  )}
                >
                  <span
                    className="size-[19px] rounded-full"
                    style={{
                      background: withAlpha(s.value, 0.35),
                      border: `2px solid ${s.value}`,
                      boxShadow: `0 0 6px ${s.value}, 0 0 12px ${s.value}`,
                    }}
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
  hint,
  onChange,
  render,
}: {
  label: string;
  value: number;
  presets: number[];
  min: number;
  max: number;
  /**
   * What to say along the bottom instead of the `[` / `]` keys.
   *
   * Those keys drive one control per tool — see `stepSize` — so a second
   * numeric control on the same tool has to say something else or it is
   * advertising a shortcut that adjusts the other one.
   */
  hint?: string;
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

        {hint ? (
          <p className="mt-2 text-[11px] text-ink-3">{hint}</p>
        ) : (
          <p className="mt-2 flex items-center gap-1.5 text-[11px] text-ink-3">
            <Kbd shortcut="[" muted />
            <Kbd shortcut="]" muted />
            to adjust
          </p>
        )}
      </div>
    </Popover>
  );
}
