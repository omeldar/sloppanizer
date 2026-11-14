import { type Todo, UrlInput } from "@organizer/shared";
import { type FormEvent, useState } from "react";
import { useToast } from "../../../components/toast/ToastProvider.tsx";
import { Button } from "../../../components/ui.tsx";
import { errorMessage } from "../../../lib/api.ts";
import { useAddUrls, useRemoveUrl } from "../../../lib/queries.ts";
import styles from "./Relations.module.css";

/** The host of a URL without "www.", for links without a label. */
export function urlHost(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === "mailto:") return parsed.pathname;
    return parsed.host.replace(/^www\./, "") + (parsed.pathname === "/" ? "" : parsed.pathname);
  } catch {
    return url;
  }
}

/** Web links of a todo (tickets, docs, pull requests): open, add, remove. */
export function WebLinks({ todo }: { todo: Todo }) {
  const add = useAddUrls(todo.id);
  const remove = useRemoveUrl(todo.id);
  const toast = useToast();
  const [url, setUrl] = useState("");
  const [label, setLabel] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = UrlInput.safeParse({ url, ...(label.trim() ? { label } : {}) });
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? "Enter a web address.");
      return;
    }
    setError(null);
    add.mutate([parsed.data], {
      onSuccess: () => {
        setUrl("");
        setLabel("");
      },
      onError: (failure) => setError(errorMessage(failure)),
    });
  };

  return (
    <section className={styles.section} aria-label="Web links">
      <div className={styles.sectionHead}>
        <h2 className={styles.sectionTitle}>Web links</h2>
      </div>
      {todo.urls.length > 0 && (
        <ul className={styles.webLinks}>
          {todo.urls.map((link) => (
            <li key={link.id} className={styles.webLink}>
              <a href={link.url} target="_blank" rel="noopener noreferrer" className={styles.webLinkMain}>
                <span className={styles.webLinkLabel}>{link.label || urlHost(link.url)}</span>
                {link.label && <span className={styles.webLinkHost}>{urlHost(link.url)}</span>}
              </a>
              <button
                type="button"
                className={styles.rowMenu}
                aria-label={`Remove the link ${link.label || link.url}`}
                onClick={() =>
                  remove.mutate(link.id, {
                    onError: (failure) =>
                      toast.show({
                        tone: "error",
                        message: `Could not remove the link. ${errorMessage(failure)}`,
                      }),
                  })
                }
              >
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
      <form className={styles.webLinkForm} onSubmit={submit}>
        <input
          className={styles.addInput}
          type="url"
          inputMode="url"
          placeholder="Paste a link (ticket, doc, pull request)"
          aria-label="Link address"
          value={url}
          onChange={(event) => setUrl(event.target.value)}
        />
        <input
          className={styles.addInput}
          placeholder="Label (optional)"
          aria-label="Link label"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
        />
        <Button type="submit" size="sm" disabled={add.isPending || url.trim() === ""}>
          Add
        </Button>
      </form>
      {error && (
        <p className={styles.error} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
