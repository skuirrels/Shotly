/** Records rather than opens, so the harness can assert on it. */
export async function openUrl(url: string): Promise<void> {
  (window as unknown as { OPENED: string[] }).OPENED ??= [];
  (window as unknown as { OPENED: string[] }).OPENED.push(url);
}
