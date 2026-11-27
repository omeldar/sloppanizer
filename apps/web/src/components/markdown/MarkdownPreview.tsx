import { API_PREFIX, type ChecklistItem, parseChecklist, STATUS_LABELS } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { type ComponentProps, createContext, type ReactNode, useContext, useMemo, useState } from "react";
import ReactMarkdown from "react-markdown";
import rehypeSanitize from "rehype-sanitize";
import remarkGfm from "remark-gfm";
import { useTodo } from "../../lib/queries.ts";
import { HoverCard } from "../HoverCard.tsx";
import { useDownload } from "../useDownload.ts";
import { AuthImage } from "./AuthImage.tsx";
import styles from "./Markdown.module.css";
import { MermaidDiagram, mermaidSourceOf } from "./MermaidDiagram.tsx";
import { remarkTodoLinks, todoIdFromHref } from "./remarkTodoLinks.ts";

/** Only files stored by this app render as images; anything else stays a plain link. */
export const ATTACHMENT_PREFIX = `${API_PREFIX}/attachments/`;

export function isAttachmentSrc(src: unknown): src is string {
  return typeof src === "string" && src.startsWith(ATTACHMENT_PREFIX) && !src.includes("..");
}

const remarkPlugins = [remarkGfm, remarkTodoLinks];
const rehypePlugins = [rehypeSanitize];

/** Clickable task list checkboxes; only the todo description passes this. */
export interface ChecklistControl {
  onToggle: (item: ChecklistItem, checked: boolean) => void;
  /** A click is on its way: the boxes wait. */
  busy?: boolean;
}

const ChecklistContext = createContext<(ChecklistControl & { items: ChecklistItem[] }) | null>(null);
/** The checklist item of the nearest task list line. */
const ItemContext = createContext<ChecklistItem | null>(null);

const baseComponents = { a: Anchor, img: Image, pre: Pre };
const checklistComponents = { ...baseComponents, li: ListItem, input: Checkbox };

/**
 * Stored Markdown is untrusted text: it renders through rehype-sanitize. Outside links open in a new tab,
 * "#123" opens the todo inside the app, and only the app's own attachments show as images. A ```mermaid
 * block shows as a diagram (the renderer loads only then). With `checklist`, task list boxes can be
 * clicked; each box is matched to its item by source line.
 */
export function MarkdownPreview({ source, checklist }: { source: string; checklist?: ChecklistControl }) {
  const clickable = checklist !== undefined;
  const items = useMemo(() => (clickable ? parseChecklist(source) : []), [clickable, source]);
  const context = useMemo(() => (checklist ? { ...checklist, items } : null), [checklist, items]);
  return (
    <div className={styles.preview}>
      <ChecklistContext.Provider value={context}>
        <ReactMarkdown
          remarkPlugins={remarkPlugins}
          rehypePlugins={rehypePlugins}
          components={checklist ? checklistComponents : baseComponents}
        >
          {source}
        </ReactMarkdown>
      </ChecklistContext.Provider>
    </div>
  );
}

interface PositionedNode {
  position?: { start: { line: number } };
}

function ListItem({ node, children, ...props }: ComponentProps<"li"> & { node?: PositionedNode }) {
  const checklist = useContext(ChecklistContext);
  const line = node?.position ? node.position.start.line - 1 : -1;
  const isTask = String(props.className ?? "").includes("task-list-item");
  const item = (isTask && checklist?.items.find((i) => i.line === line)) || null;
  return (
    <li {...props}>
      <ItemContext.Provider value={item}>{children}</ItemContext.Provider>
    </li>
  );
}

function Checkbox({ node: _node, ...props }: ComponentProps<"input"> & { node?: unknown }) {
  const checklist = useContext(ChecklistContext);
  const item = useContext(ItemContext);
  if (!checklist || !item || props.type !== "checkbox") return <input {...props} />;
  return (
    <input
      type="checkbox"
      className={styles.taskBox}
      checked={item.checked}
      disabled={checklist.busy}
      aria-label={item.text.trim() || `Item ${item.index + 1}`}
      onChange={(event) => checklist.onToggle(item, event.target.checked)}
    />
  );
}

/** A code block, or a diagram for a ```mermaid fence. */
function Pre({
  node,
  children,
  ...props
}: ComponentProps<"pre"> & { node?: Parameters<typeof mermaidSourceOf>[0] }) {
  const diagram = mermaidSourceOf(node);
  if (diagram !== null) return <MermaidDiagram source={diagram} />;
  return <pre {...props}>{children}</pre>;
}

function Anchor({ node: _node, href, children, ...props }: ComponentProps<"a"> & { node?: unknown }) {
  const todoId = todoIdFromHref(href);
  if (todoId !== null) return <TodoRef id={todoId}>{children}</TodoRef>;
  if (isAttachmentSrc(href)) return <FileLink href={href}>{children}</FileLink>;
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
  return <AuthImage src={src} alt={alt ?? ""} />;
}

/** The file name at the end of an attachment link, for the saved file. */
export function fileNameOf(href: string): string {
  const last = href.split("/").pop() || "file";
  try {
    return decodeURIComponent(last);
  } catch {
    return last;
  }
}

/** A stored file: downloads with the tab's token (a plain link would carry none). */
function FileLink({ href, children }: { href: string; children: ReactNode }) {
  const download = useDownload();
  const name = fileNameOf(href);
  return (
    <a
      href={href}
      onClick={(event) => {
        event.preventDefault();
        download(href.slice(API_PREFIX.length), name);
      }}
    >
      {children}
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
