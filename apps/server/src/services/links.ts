import type { CreateLinks, LinkKind, Todo, TodoRef } from "@organizer/shared";
import { eq, inArray, or } from "drizzle-orm";
import { todoLinks, todos } from "../db/schema.ts";
import { ApiError } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { type EventInput, recordEvents } from "./events.ts";
import { chunks } from "./sql.ts";
import { getTodo } from "./todos.ts";

type StoredKind = "blocks" | "relates";

interface Row {
  fromId: number;
  toId: number;
  kind: StoredKind;
}

/** What the other todo sees: A blocks B means B is blocked by A. */
const MIRROR: Record<LinkKind, LinkKind> = { blocks: "blocked_by", blocked_by: "blocks", relates: "relates" };

/** The stored row of a link seen from `todoId`: blocked_by is the reverse blocks row, relates is sorted. */
function storedRow(todoId: number, otherId: number, kind: LinkKind): Row {
  if (kind === "blocks") return { fromId: todoId, toId: otherId, kind: "blocks" };
  if (kind === "blocked_by") return { fromId: otherId, toId: todoId, kind: "blocks" };
  return { fromId: Math.min(todoId, otherId), toId: Math.max(todoId, otherId), kind: "relates" };
}

function findRow(sc: Scoped, row: Row) {
  return sc.db
    .select()
    .from(todoLinks)
    .where(
      owned(
        sc,
        todoLinks,
        eq(todoLinks.fromId, row.fromId),
        eq(todoLinks.toId, row.toId),
        eq(todoLinks.kind, row.kind),
      ),
    )
    .get();
}

/**
 * The chain of todos from `start` to `goal` along blocks links, or null when there is none.
 * Data is small (a person's todos), so the links are loaded once and searched in memory.
 */
function blocksPath(sc: Scoped, start: number, goal: number): number[] | null {
  const next = new Map<number, number[]>();
  for (const { fromId, toId } of sc.db
    .select({ fromId: todoLinks.fromId, toId: todoLinks.toId })
    .from(todoLinks)
    .where(owned(sc, todoLinks, eq(todoLinks.kind, "blocks")))
    .all()) {
    next.set(fromId, [...(next.get(fromId) ?? []), toId]);
  }
  const previous = new Map<number, number>([[start, start]]);
  const queue = [start];
  while (queue.length > 0) {
    const id = queue.shift() as number;
    if (id === goal) {
      const path = [goal];
      while (path[0] !== start) path.unshift(previous.get(path[0] as number) as number);
      return path;
    }
    for (const to of next.get(id) ?? []) {
      if (!previous.has(to)) {
        previous.set(to, id);
        queue.push(to);
      }
    }
  }
  return null;
}

function titlesOf(sc: Scoped, ids: readonly number[]): Map<number, string> {
  const out = new Map<number, string>();
  for (const part of chunks([...new Set(ids)])) {
    for (const t of sc.db
      .select({ id: todos.id, title: todos.title })
      .from(todos)
      .where(owned(sc, todos, inArray(todos.id, part)))
      .all())
      out.set(t.id, t.title);
  }
  return out;
}

/** links_changed events on both todos of every changed link, grouped per todo and kind. */
function linkEvents(
  sc: Scoped,
  todoId: number,
  changes: readonly { kind: LinkKind; otherId: number }[],
  field: "added" | "removed",
): EventInput[] {
  const titles = titlesOf(sc, [todoId, ...changes.map((c) => c.otherId)]);
  const ref = (id: number) => ({ id, title: titles.get(id) ?? null });
  const groups = new Map<string, { todoId: number; kind: LinkKind; refs: number[] }>();
  const add = (owner: number, kind: LinkKind, other: number) => {
    const key = `${owner}:${kind}`;
    const group = groups.get(key) ?? { todoId: owner, kind, refs: [] };
    group.refs.push(other);
    groups.set(key, group);
  };
  for (const { kind, otherId } of changes) {
    add(todoId, kind, otherId);
    add(otherId, MIRROR[kind], todoId);
  }
  return [...groups.values()].map((g) => ({
    todoId: g.todoId,
    kind: "links_changed" as const,
    data: {
      kind: g.kind,
      added: field === "added" ? g.refs.map(ref) : [],
      removed: field === "removed" ? g.refs.map(ref) : [],
    },
  }));
}

function touch(sc: Scoped, at: string, ids: readonly number[]): void {
  if (ids.length > 0)
    sc.db
      .update(todos)
      .set({ updatedAt: at, lastActivityAt: at })
      .where(owned(sc, todos, inArray(todos.id, [...new Set(ids)])))
      .run();
}

/**
 * Links a todo to others. Existing links are kept silently; targets must exist (422 with
 * unknownTodoIds), a todo cannot link to itself, and blocks loops are refused naming the chain.
 * Events go on both todos in the same transaction.
 */
export function addLinks(ctx: Ctx, actor: string, todoId: number, input: CreateLinks): Todo {
  return ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    getTodo(sc, todoId);
    const targets = [...new Set(input.links.map((l) => l.todoId))];
    if (targets.includes(todoId))
      throw new ApiError("validation_failed", "A todo cannot be linked to itself.");
    const known = titlesOf(sc, targets);
    const unknown = targets.filter((id) => !known.has(id));
    if (unknown.length > 0) {
      throw new ApiError(
        "validation_failed",
        `Todo${unknown.length > 1 ? "s" : ""} ${unknown.map((id) => `#${id}`).join(", ")} ${unknown.length > 1 ? "do" : "does"} not exist.`,
        { unknownTodoIds: unknown },
      );
    }
    const at = now(ctx);
    const added: { kind: LinkKind; otherId: number }[] = [];
    for (const { kind, todoId: otherId } of input.links) {
      const row = storedRow(todoId, otherId, kind);
      if (findRow(sc, row)) continue;
      if (row.kind === "blocks") {
        const loop = blocksPath(sc, row.toId, row.fromId);
        if (loop) {
          const chain = [row.fromId, ...loop].map((id) => `#${id}`).join(" blocks ");
          throw new ApiError("validation_failed", `That would make a loop: ${chain}.`, {
            chain: [row.fromId, ...loop],
          });
        }
      }
      insertOwnedRow(sc, todoLinks, { ...row, createdBy: actor, createdAt: at });
      added.push({ kind, otherId });
    }
    if (added.length > 0) {
      touch(sc, at, [todoId, ...added.map((a) => a.otherId)]);
      recordEvents(sc, actor, at, linkEvents(sc, todoId, added, "added"));
    }
    return getTodo(sc, todoId);
  });
}

/** Removes one link seen from `todoId`; 404 when there is no such link. */
export function removeLink(ctx: Ctx, actor: string, todoId: number, otherId: number, kind: LinkKind): void {
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    getTodo(sc, todoId);
    const existing = findRow(sc, storedRow(todoId, otherId, kind));
    if (!existing) {
      throw new ApiError("not_found", `Todo ${todoId} has no "${kind}" link to #${otherId}.`);
    }
    sc.db
      .delete(todoLinks)
      .where(owned(sc, todoLinks, eq(todoLinks.id, existing.id)))
      .run();
    const at = now(ctx);
    touch(sc, at, [todoId, otherId]);
    recordEvents(sc, actor, at, linkEvents(sc, todoId, [{ kind, otherId }], "removed"));
  });
}

export interface TodoLinks {
  blocks: TodoRef[];
  blockedBy: TodoRef[];
  relatesTo: TodoRef[];
}

/** Links of the given todos as small references, each list by id. */
export function linksByTodo(sc: Scoped, ids: readonly number[]): Map<number, TodoLinks> {
  const out = new Map<number, TodoLinks>();
  const entry = (id: number) => {
    let links = out.get(id);
    if (!links) {
      links = { blocks: [], blockedBy: [], relatesTo: [] };
      out.set(id, links);
    }
    return links;
  };
  const wanted = new Set(ids);
  const rows: Row[] = [];
  for (const part of chunks(ids)) {
    rows.push(
      ...sc.db
        .select({ fromId: todoLinks.fromId, toId: todoLinks.toId, kind: todoLinks.kind })
        .from(todoLinks)
        .where(owned(sc, todoLinks, or(inArray(todoLinks.fromId, part), inArray(todoLinks.toId, part))))
        .all(),
    );
  }
  const refs = new Map<number, TodoRef>();
  const other = [...new Set(rows.flatMap((r) => [r.fromId, r.toId]))];
  for (const part of chunks(other)) {
    for (const t of sc.db
      .select({ id: todos.id, title: todos.title, status: todos.status })
      .from(todos)
      .where(owned(sc, todos, inArray(todos.id, part)))
      .all())
      refs.set(t.id, t);
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.fromId}:${row.toId}:${row.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const from = refs.get(row.fromId) as TodoRef;
    const to = refs.get(row.toId) as TodoRef;
    if (row.kind === "blocks") {
      if (wanted.has(row.fromId)) entry(row.fromId).blocks.push(to);
      if (wanted.has(row.toId)) entry(row.toId).blockedBy.push(from);
    } else {
      if (wanted.has(row.fromId)) entry(row.fromId).relatesTo.push(to);
      if (wanted.has(row.toId)) entry(row.toId).relatesTo.push(from);
    }
  }
  for (const links of out.values()) {
    for (const list of [links.blocks, links.blockedBy, links.relatesTo]) list.sort((a, b) => a.id - b.id);
  }
  return out;
}
