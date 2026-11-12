import { STATUS_LABELS } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type ComponentProps, type ReactNode, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useTodo } from "../../lib/queries.ts";
import { HoverCard } from "../HoverCard.tsx";
import styles from "./Markdown.module.css";
import { remarkTodoLinks, todoIdFromHref } from "./remarkTodoLinks.ts";

/** Only files stored by this app render as images; anything else stays a plain link. */
export const ATTACHMENT_PREFIX = "/api/v1/attachments/";

export function isAttachmentSrc(src: unknown): src is string {
  return typeof src === "string" && src.startsWith(ATTACHMENT_PREFIX) && !src.includes("..");
}

const remarkPlugins = [remarkGfm, remarkTodoLinks];
const rehypePlugins = [rehypeSanitize];

/**
 * Stored Markdown is untrusted text: it renders through rehype-sanitize. Outside links open in a new tab,
 * "#123" opens the todo inside the app, and only the app's own attachments show as images.
 */
export function MarkdownPreview({ source }: { source: string }) {
  return (
    <div className={styles.preview}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={{ a: Anchor, img: Image }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}

function Anchor({ node: _node, href, children, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  const todoId = todoIdFromHref(href);
  if (todoId !== null) return <TodoRef id={todoId}>{children}</TodoRef>;
  return (
    <a {...props} href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  );
}

function Image({ node: _node, src, alt }: ComponentProps<"img"> & { node?: unknown }) {
  if (!isAttachmentSrc(src)) {
    // The CSP blocks outside images anyway; a link keeps the reference usable.
    return typeof src === "string" && src ? (
      <a href={src} target="_blank" rel="noreferrer noopener">
        {alt || src}
      </a>
    ) : (
      <span>{alt}</span>
    );
  }
  return (
    <a href={src} target="_blank" rel="noreferrer noopener" className={styles.imageLink}>
      <img src={src} alt={alt ?? ""} loading="lazy" />
    </a>
  );
}

/** "#123" as an in-app link; hovering shows the title from the cache, or loads it once. */
function TodoRef({ id, children }: { id: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  // Cached todos show at once; otherwise the first hover loads it.
  const todo = useTodo(id, open);
  return (
    <HoverCard
      onOpenChange={setOpen}
      trigger={
        <Link to="/todos/$id" params={{ id: String(id) }} className={styles.todoRef}>
          {children}
        </Link>
      }
    >
      {todo.data ? (
        <span className={styles.refCard}>
          <span className={styles.refId}>#{id}</span>
          <span className={styles.refTitle}>{todo.data.title}</span>
          <span className={styles.refMeta}>
            {STATUS_LABELS[todo.data.status]}, {todo.data.project?.name ?? "Inbox"}
          </span>
        </span>
      ) : (
        <span className={styles.refMeta}>{todo.isError ? `No todo #${id}.` : `Loading #${id}`}</span>
      )}
    </HoverCard>
  );
}
