import { useEffect, useState } from "react";
import { attachmentBlob } from "../../lib/attachmentCache.ts";

/** An attachment image loaded with the tab's token (no link around it, unlike the Markdown images). */
export function BlobImage({ src, alt }: { src: string; alt: string }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    const load = async () => {
      try {
        const blob = await attachmentBlob(src);
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setUrl(made);
      } catch {
        // Not loadable (deleted, offline): the button stays empty.
      }
    };
    void load();
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);
  return url ? <img src={url} alt={alt} /> : <span aria-hidden="true" />;
}
