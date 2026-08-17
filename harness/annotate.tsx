import { createRoot } from "react-dom/client";
import "./harness.css";
import { AnnotateApp } from "@/windows/annotate/AnnotateApp";

/**
 * The live screen-annotation layer, over a stand-in for the desktop.
 *
 * In the app this is a transparent window on top of everything; here it is the
 * same component over a background image, which is enough to exercise every
 * tool — including the neon callout, whose box is drawn by the same recipe the
 * editor uses.
 */
createRoot(document.getElementById("root")!).render(
  <div className="relative h-screen w-screen">
    <img
      src="/source.png"
      alt=""
      className="absolute inset-0 h-full w-full object-cover"
      style={{ filter: "brightness(0.5)" }}
    />
    <AnnotateApp />
  </div>,
);
