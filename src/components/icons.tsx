import type { SVGProps } from "react";

/**
 * A 16px stroke icon set drawn on a shared grid.
 *
 * Everything is `currentColor` at 1.5px so icons inherit state colour from the
 * button around them and stay optically consistent at toolbar size.
 */
function Icon({ children, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.5"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    >
      {children}
    </svg>
  );
}

export const IconSelect = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 2.2v9.4l2.5-2.4h3.4z" fill="currentColor" stroke="none" />
    <path d="m8 9.2 2.6 4.6" />
  </Icon>
);

export const IconArrow = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 13 13 3" />
    <path d="M13 8.4V3H7.6" />
  </Icon>
);

export const IconRect = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2.5" y="3.5" width="11" height="9" rx="1.5" />
  </Icon>
);

export const IconEllipse = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <ellipse cx="8" cy="8" rx="5.5" ry="4.5" />
  </Icon>
);

export const IconLine = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 13 13 3" />
  </Icon>
);

export const IconText = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 4.2V3h10v1.2M8 3v10M6 13h4" />
  </Icon>
);

export const IconStep = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.5" />
    <path d="M7 6.2 8.4 5.4V11" />
  </Icon>
);

export const IconBlur = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="5.5" strokeDasharray="1 2.2" />
    <circle cx="8" cy="8" r="2.4" />
  </Icon>
);

export const IconHighlight = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m4 10.5 5.2-5.2a1.7 1.7 0 0 1 2.4 0l.6.6a1.7 1.7 0 0 1 0 2.4L7 13.5H4z" />
    <path d="M2.5 13.5h3" />
  </Icon>
);

/** A filled box with words in it — a label you drag out, not a caret. */
export const IconCallout = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="1.5" y="3" width="13" height="10" rx="2.2" />
    <path d="M4.5 7h7M4.5 9.8h4.5" />
  </Icon>
);

/** A darkened field with a clear rectangle punched out of the middle. */
export const IconSpotlight = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path
      d="M1.5 1.5h13v13h-13z M5 5h6v6h-6z"
      fill="currentColor"
      fillRule="evenodd"
      fillOpacity="0.35"
      stroke="none"
    />
    <rect x="5" y="5" width="6" height="6" rx="0.8" />
  </Icon>
);

/**
 * A pipette: round bulb, narrow neck, pointed tip.
 *
 * The bulb is filled and circular on purpose. The palette already holds a pen
 * and a highlighter, both of them slim diagonal wedges, and a third one would
 * be indistinguishable at 16px — the round head is the whole silhouette.
 */
export const IconEyedropper = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="11.6" cy="4.4" r="2.6" fill="currentColor" stroke="none" />
    <path d="M10.2 6.6 4.4 12.4l-2 .6.6-2 5.8-5.8" />
    <path d="m8.3 6.3 1.4 1.4" />
  </Icon>
);

/** The usual cog: a ring of teeth around a hub. */
export const IconGear = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="2.4" />
    <path d="M8 1.6v1.8M8 12.6v1.8M14.4 8h-1.8M3.4 8H1.6M12.5 3.5l-1.3 1.3M4.8 11.2l-1.3 1.3M12.5 12.5l-1.3-1.3M4.8 4.8 3.5 3.5" />
  </Icon>
);

/** The record button everyone knows: a filled dot in a ring. */
export const IconRecord = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="8" cy="8" r="6.2" />
    <circle cx="8" cy="8" r="3" fill="currentColor" stroke="none" />
  </Icon>
);

/** A keyboard: two rows of keys and a space bar under them. */
export const IconKeyboard = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="1.4" y="3.4" width="13.2" height="9.2" rx="1.8" />
    <path d="M4 6.2h.01M7 6.2h.01M10 6.2h.01M12.6 6.2h.01M3.4 8.8h.01M6 8.8h.01" />
    <path d="M5.2 10.9h5.6" />
  </Icon>
);

/**
 * A picture inside a margin: an outer frame with an inner one set well in,
 * which is exactly what a backdrop does to a capture.
 */
export const IconBackdrop = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="1.5" y="1.5" width="13" height="13" rx="2" strokeDasharray="2.4 1.8" />
    <rect x="4.5" y="4.5" width="7" height="7" rx="1.2" />
  </Icon>
);

/**
 * A drawing pin, head-on: the disc of the head with the pin behind it, angled
 * the way one sits when it has been pushed into a board.
 */
export const IconPin = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M9.6 1.9 14.1 6.4" />
    <path d="M11.2 3.5 7.4 5.1a1.2 1.2 0 0 0-.5.3L4.1 8.2a.8.8 0 0 0 0 1.1l2.6 2.6a.8.8 0 0 0 1.1 0l2.8-2.8a1.2 1.2 0 0 0 .3-.5l1.6-3.8" />
    <path d="M5.4 10.6 2 14" />
  </Icon>
);

/**
 * Text being lifted out of a picture: the corner marks of a selection, with
 * lines of prose caught inside them.
 *
 * Corner marks rather than a full rectangle, so it reads as "select this part
 * of the image" and not as the rectangle-drawing tool two buttons along.
 */
export const IconTextGrab = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2 5.2V3.2A1.2 1.2 0 0 1 3.2 2h2" />
    <path d="M10.8 2h2A1.2 1.2 0 0 1 14 3.2v2" />
    <path d="M14 10.8v2a1.2 1.2 0 0 1-1.2 1.2h-2" />
    <path d="M5.2 14h-2A1.2 1.2 0 0 1 2 12.8v-2" />
    <path d="M5 6.2h6" />
    <path d="M5 9h6" />
    <path d="M5 11.5h3.5" />
  </Icon>
);

/**
 * A dimension line: end ticks and a shaft, the way a drawing marks a span.
 *
 * Not a ruler with graduations — at 16px those collapse into a grey smear,
 * and the ticks are what actually says "this measures the gap".
 */
export const IconMeasure = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2.5 4v8" />
    <path d="M13.5 4v8" />
    <path d="M2.5 8h11" />
  </Icon>
);

/**
 * A picture with room made beside it: the frame, and the space it grew into.
 *
 * The dashed half is the bare canvas, which is the thing this control adds.
 */
export const IconCanvas = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2" y="3.5" width="7" height="9" rx="1.2" />
    <path d="M12 3.5h1.2a0.8 0.8 0 0 1 0.8 0.8V5" strokeDasharray="2 1.6" />
    <path d="M14 8v3.7a0.8 0.8 0 0 1-0.8 0.8H12" strokeDasharray="2 1.6" />
  </Icon>
);

/** Two links of a chain, for following a scanned code somewhere. */
export const IconLink = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M6.8 9.2a2.6 2.6 0 0 0 3.9.3l2-2a2.6 2.6 0 0 0-3.7-3.7l-1.1 1.1" />
    <path d="M9.2 6.8a2.6 2.6 0 0 0-3.9-.3l-2 2a2.6 2.6 0 0 0 3.7 3.7l1.1-1.1" />
  </Icon>
);

/**
 * One picture laid over another: a back frame, and a front one carrying the
 * usual hill-and-sun shorthand so it reads as an image rather than a rectangle.
 */
export const IconOverlay = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2 11V3.2A1.2 1.2 0 0 1 3.2 2H11" />
    <rect x="5" y="5" width="9.5" height="9.5" rx="1.6" />
    <path d="M5 12.2 8 9.4l2.2 2M11.6 8.2a.9.9 0 1 0 0-.1z" />
  </Icon>
);

export const IconCrop = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4.5 1.5v10h10" />
    <path d="M1.5 4.5h10v10" />
  </Icon>
);

export const IconUndo = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M3 7h7a3.5 3.5 0 0 1 0 7H6" />
    <path d="M5.5 4.5 3 7l2.5 2.5" />
  </Icon>
);

export const IconRedo = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M13 7H6a3.5 3.5 0 0 0 0 7h4" />
    <path d="M10.5 4.5 13 7l-2.5 2.5" />
  </Icon>
);

export const IconCopy = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
    <path d="M10.5 5.5v-1a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v4a2 2 0 0 0 2 2h1" />
  </Icon>
);

export const IconSave = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M8 2v7.5" />
    <path d="M5.2 6.8 8 9.6l2.8-2.8" />
    <path d="M2.5 11v1.5a1.5 1.5 0 0 0 1.5 1.5h8a1.5 1.5 0 0 0 1.5-1.5V11" />
  </Icon>
);

export const IconTrash = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2.5 4h11M6 4V2.5h4V4M4 4l.7 9a1.5 1.5 0 0 0 1.5 1.4h3.6A1.5 1.5 0 0 0 11.3 13L12 4" />
  </Icon>
);

export const IconZoomIn = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.4 10.4 14 14M7 5.2v3.6M5.2 7h3.6" />
  </Icon>
);

/** A plain magnifier — the zoom icons are the same shape carrying a sign. */
export const IconSearch = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.4 10.4 14 14" />
  </Icon>
);

export const IconZoomOut = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <circle cx="7" cy="7" r="4.5" />
    <path d="M10.4 10.4 14 14M5.2 7h3.6" />
  </Icon>
);

export const IconFit = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2.5 6V3.5a1 1 0 0 1 1-1H6M10 2.5h2.5a1 1 0 0 1 1 1V6M13.5 10v2.5a1 1 0 0 1-1 1H10M6 13.5H3.5a1 1 0 0 1-1-1V10" />
  </Icon>
);

export const IconCommand = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M5.5 2.5a1.5 1.5 0 1 0 1.5 1.5v8a1.5 1.5 0 1 1-1.5-1.5h5a1.5 1.5 0 1 1-1.5 1.5V4a1.5 1.5 0 1 0 1.5 1.5z" />
  </Icon>
);

export const IconLayers = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M8 2 2 5.5 8 9l6-3.5z" />
    <path d="m2.6 8.6 5.4 3 5.4-3" />
  </Icon>
);

export const IconClose = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m4 4 8 8M12 4l-8 8" />
  </Icon>
);

export const IconCheck = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="m3 8.5 3.2 3.2L13 5" />
  </Icon>
);

export const IconCamera = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.2l.9-1.5h4.8L11.3 4h1.2A1.5 1.5 0 0 1 14 5.5v6A1.5 1.5 0 0 1 12.5 13h-9A1.5 1.5 0 0 1 2 11.5z" />
    <circle cx="8" cy="8.2" r="2.4" />
  </Icon>
);

export const IconPen = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2.5 13.5 3.4 10l7-7a1.8 1.8 0 0 1 2.5 2.5l-7 7z" />
    <path d="M9.5 4.5 11.5 6.5" />
  </Icon>
);

export const IconBack = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M13 8H3.5M7 3.5 2.5 8 7 12.5" />
  </Icon>
);

export const IconGrid = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2.5" y="2.5" width="4.6" height="4.6" rx="1.2" />
    <rect x="8.9" y="2.5" width="4.6" height="4.6" rx="1.2" />
    <rect x="2.5" y="8.9" width="4.6" height="4.6" rx="1.2" />
    <rect x="8.9" y="8.9" width="4.6" height="4.6" rx="1.2" />
  </Icon>
);

export const IconFolder = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2 4.5a1.5 1.5 0 0 1 1.5-1.5h2.4l1.4 1.8h5.2A1.5 1.5 0 0 1 14 6.3v5.2a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" />
  </Icon>
);

/** Marquee corners — the region capture mode. */
export const IconRegion = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M2.5 5.8V3.9a1.4 1.4 0 0 1 1.4-1.4h1.9M10.2 2.5h1.9a1.4 1.4 0 0 1 1.4 1.4v1.9M13.5 10.2v1.9a1.4 1.4 0 0 1-1.4 1.4h-1.9M5.8 13.5H3.9a1.4 1.4 0 0 1-1.4-1.4v-1.9" />
  </Icon>
);

export const IconWindow = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <path d="M2 6.2h12" />
  </Icon>
);

export const IconDisplay = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="1.8" y="2.8" width="12.4" height="8.6" rx="1.6" />
    <path d="M6.2 13.5h3.6" />
  </Icon>
);

/** A tall page sliding through a viewport: the scrolling capture. */
export const IconScroll = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="3" y="4.5" width="10" height="7" rx="1.4" />
    <path d="M6 2l2-2 2 2" transform="translate(0,2)" />
    <path d="M6 14l2 2 2-2" transform="translate(0,-2)" />
  </Icon>
);

export const IconImage = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2" y="3" width="12" height="10" rx="1.6" />
    <circle cx="5.9" cy="6.5" r="1.05" />
    <path d="m2.6 11.8 3.1-2.9 2.5 2.2 2.3-2 3.1 2.7" />
  </Icon>
);

export const IconChevronDown = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M4.5 6.5 8 10l3.5-3.5" />
  </Icon>
);

/** An arrow curling back on itself — "check again", not "undo". */
export const IconRefresh = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M13.2 7A5.3 5.3 0 1 0 12 11.1" />
    <path d="M13.5 3.4V7H10" />
  </Icon>
);

export const IconSparkle = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <path d="M8 1.8 9.5 6 13.7 7.5 9.5 9 8 13.2 6.5 9 2.3 7.5 6.5 6z" />
  </Icon>
);

export const IconShadow = (p: SVGProps<SVGSVGElement>) => (
  <Icon {...p}>
    <rect x="2.5" y="2.5" width="8" height="8" rx="1.5" />
    <path d="M13.5 5.5v7a1 1 0 0 1-1 1h-7" />
  </Icon>
);
