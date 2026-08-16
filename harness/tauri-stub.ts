/** Stands in for the one Tauri call the exporter makes. See vite.harness.config.ts. */
export async function invoke<T>(cmd: string): Promise<T> {
  if (cmd === "read_capture_bytes") {
    const response = await fetch("/source.png");
    const buffer = await response.arrayBuffer();
    return Array.from(new Uint8Array(buffer)) as T;
  }
  throw new Error(`harness has no stub for ${cmd}`);
}

export function convertFileSrc(path: string): string {
  return path;
}
