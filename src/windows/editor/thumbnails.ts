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

    // A capture whose bytes are in the cloud is left alone. Making a thumbnail
    // of one means downloading it, and the grid asks for a thumbnail per card
    // — so scrolling a folder of recordings would pull the whole folder back
    // onto the disk without anyone asking for it. Rust refuses this too; the
    // check is here as well so the request is never made.
    if (cloud) {
      setUrl(null);
      return;
    }

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
