/** Delivers whatever the harness pushes into window.EMIT. */
type Handler = (e: { payload: unknown }) => void;
const handlers = new Map<string, Handler[]>();
(window as any).EMIT = (event: string, payload: unknown) =>
  (handlers.get(event) ?? []).forEach((h) => h({ payload }));
export async function listen(event: string, handler: Handler) {
  handlers.set(event, [...(handlers.get(event) ?? []), handler]);
  return () => {};
}
