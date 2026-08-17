import { useEffect, useState } from "react";
import * as ipc from "@/lib/ipc";

/**
 * The thumbnail for one capture, fetched on mount.
 *
 * Per item rather than for the whole listing, so a large library paints
 * immediately and fills in progressively instead of blocking on a few hundred
 * image decodes.
 */
export function useThumbnail(path: string, modified: number, cloud = false) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setFailed(false);

    // A cloud capture is asked about like any other. Rust hands back a
    // thumbnail it made earlier if it has one — reading its own cache touches
    // nothing in the library — and refuses only when it would have to read the
    // capture itself, which is what would trigger a download. Skipping the
    // request outright, as this used to, left a library of grey rectangles the
    // day macOS evicted the lot.

    void ipc
      .libraryThumbnail(path)
      .then((file) => !cancelled && setUrl(ipc.assetUrl(file)))
      .catch(() => !cancelled && setFailed(true));

    return () => {
      cancelled = true;
    };
    // `modified` matters as much as the path: the thumbnail cache is keyed on
    // mtime, so re-saving a capture yields a *new* thumbnail file. Without it
    // the card keeps showing the version from before you annotated it.
  }, [path, modified, cloud]);

  return { url, failed };
}
