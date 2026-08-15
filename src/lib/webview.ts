/**
 * Strip the browser affordances WKWebView brings with it.
 *
 * Left alone, a right-click anywhere offers "Download Image", "Open Image in
 * New Window", "Inspect Element" — a web page's menu, in an app that is not a
 * web page. Suppressing it globally means a right-click only ever produces a
 * menu Shotly actually wrote.
 *
 * Kept in development builds, where Inspect Element is the fastest route into
 * the devtools. `npm run app` runs Vite in dev mode; every bundled build —
 * including `tauri build --debug` — compiles the front end in production mode,
 * so the installed app never shows it.
 */
export function suppressBrowserMenu() {
  if (import.meta.env.DEV) return;
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}
