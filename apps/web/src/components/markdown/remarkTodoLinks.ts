import type { Link, Root } from "mdast";
import { findAndReplace } from "mdast-util-find-and-replace";

/**
 * "#123" not glued to a word, an entity or a URL fragment ("abc#12", "&#123;", "/page#4" stay text).
 * Code spans and blocks are separate node types, so they are never searched.
 */
const TODO_REF = /(?<![\w&#/])#(\d{1,9})(?!\w)/g;

export function todoPath(id: number | string): string {
  return `/todos/${id}`;
}

/** remark plugin: turns "#123" in text into a link to the todo (outside links and code). */
export function remarkTodoLinks() {
  return (tree: Root) => {
    findAndReplace(
      tree,
      [
        TODO_REF,
        (match: string, id: string): Link => ({
          type: "link",
          url: todoPath(id),
          children: [{ type: "text", value: match }],
        }),
      ],
      { ignore: ["link", "linkReference"] },
    );
  };
}

/** The todo id when an href points at a todo page of this app, else null. */
export function todoIdFromHref(href: string | undefined): number | null {
  const match = href ? /^\/todos\/(\d+)$/.exec(href) : null;
  return match ? Number(match[1]) : null;
}
