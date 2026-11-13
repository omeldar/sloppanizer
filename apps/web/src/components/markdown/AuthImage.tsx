import { useEffect, useState } from "react";
import { attachmentBlob } from "../../lib/attachmentCache.ts";
import styles from "./Markdown.module.css";

/**
 * An attachment image: loaded with the tab's token, shown from a blob URL that is revoked when the
 * image leaves the page. A click opens the full image in a new tab.
 */
export function AuthImage({ src, alt }: { src: string; alt: string }) {
  const [state, setState] = useState<{ src: string; url: string | null; failed: boolean }>({
    src,
    url: null,
    failed: false,
  });
  const current = state.src === src ? state : { src, url: null, failed: false };

  useEffect(() => {
    let alive = true;
    let made: string | null = null;
    attachmentBlob(src).then(
      (blob) => {
        if (!alive) return;
        made = URL.createObjectURL(blob);
        setState({ src, url: made, failed: false });
      },
      () => alive && setState({ src, url: null, failed: true }),
    );
    return () => {
      alive = false;
      if (made) URL.revokeObjectURL(made);
    };
  }, [src]);

  if (current.failed) return <span className={styles.imageMissing}>{alt || "Image"} (could not load)</span>;
  if (!current.url) {
    return (
      <span className={styles.imageLoading}>
        <span className="visually-hidden">Loading {alt || "image"}</span>
      </span>
    );
  }
  return (
    <a href={current.url} target="_blank" rel="noreferrer noopener" className={styles.imageLink}>
      <img src={current.url} alt={alt} />
    </a>
  );
}
