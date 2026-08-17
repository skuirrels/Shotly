import { createRoot } from "react-dom/client";
import "./harness.css";
import { RecordApp } from "@/windows/record/RecordApp";

/**
 * The recording window's two phases in a plain browser: the selection overlay,
 * and — once something is chosen, or with `#hud` — the floating panel.
 *
 * The stub answers `record_region`/`record_window`/`record_screen` by emitting
 * the phase change, exactly as Rust does, so choosing an area here really does
 * hand over to the panel.
 */
/**
 * `#panel` shows the panel at the size Rust actually gives it, by loading
 * `#hud` into an iframe of exactly those dimensions — the only way to see the
 * real proportions of a window whose layout is in viewport units, since no
 * browser window goes down to 92 points tall.
 */
if (location.hash === "#panel") {
  const frame = document.createElement("iframe");
  frame.src = "/record.html#hud";
  frame.style.cssText =
    "position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:232px;height:92px;border:0;background:transparent";
  document.body.append(frame);
} else {
  // No EMIT for `#hud`: the point of that case is that nothing is emitted and
  // the page has to ask. The stub answers `record_phase` from the hash.
  createRoot(document.getElementById("root")!).render(<RecordApp />);
}
