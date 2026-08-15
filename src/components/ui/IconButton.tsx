import clsx from "clsx";
import { type ButtonHTMLAttributes, type ReactNode, forwardRef } from "react";
import { Tooltip } from "./Tooltip";

interface Props extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children"> {
  icon: ReactNode;
  label: string;
  shortcut?: string;
  active?: boolean;
  tooltipSide?: "top" | "bottom";
  /** Suppress the tooltip when the button already sits next to visible text. */
  bare?: boolean;
}

/**
 * The workhorse control. Three visual states matter and each is distinct at a
 * glance: resting (transparent), hovered (raised surface), active (accent).
 */
export const IconButton = forwardRef<HTMLButtonElement, Props>(function IconButton(
  { icon, label, shortcut, active, tooltipSide = "bottom", bare, className, ...rest },
  ref,
) {
  const button = (
    <button
      ref={ref}
      type="button"
      aria-label={label}
      aria-pressed={active}
      className={clsx(
        "no-drag relative grid h-[30px] w-[30px] place-items-center rounded-lg",
        "transition-[background-color,color,box-shadow] duration-100 ease-[var(--ease-out)]",
        "disabled:pointer-events-none disabled:opacity-35",
        active
          ? "bg-accent/18 text-accent shadow-[inset_0_0_0_1px_var(--color-accent)]"
          : "text-ink-2 hover:bg-hover hover:text-ink active:bg-pressed",
        className,
      )}
      {...rest}
    >
      {icon}
    </button>
  );

  if (bare) return button;

  return (
    <Tooltip label={label} shortcut={shortcut} side={tooltipSide}>
      {button}
    </Tooltip>
  );
});
