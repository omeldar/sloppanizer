import { copyFileSync, renameSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { join } from "node:path";
import {
  API_PREFIX,
  type MovedTodo,
  type MoveTodo,
  type PersonRef,
  parseLabelName,
  SESSION_ACTOR,
  type Todo,
} from "@organizer/shared";
import { asc, eq, inArray, isNull } from "drizzle-orm";
import { attachments, comments, labels, people, projects, todos } from "../db/schema.ts";
import type { Db } from "../db/index.ts";
import { ApiError } from "../http/errors.ts";
import { type AccountRow, getAccount } from "./accounts.ts";
import { accountFilesDir, assertFilesQuota } from "./attachments.ts";
import { isAssignable } from "./assignees.ts";
import type { Auth, Scoped, Tx } from "./context.ts";
import { recordEvents } from "./events.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { findNamesakes, resolvePeople } from "./people.ts";
import { assertProjectExists } from "./projects.ts";
import { indexComment } from "./search-index.ts";
import { memberName, openSpace } from "./spaces.ts";
import { foldCase } from "./text.ts";
import { getTodo, insertTodo } from "./todos.ts";

/**
 * Moving a todo between accounts (your own todos and shared projects). Todos never change accounts (ids,
 * labels, people and files are per account), so the todo and its subtasks are copied into the other
 * account in one transaction, with their comments, checklist (in the description), labels (made there
 * when missing), people (found or made there by name, Sloppanizer users by username), web links, repeat
 * rule and the files their text shows. The originals are marked done (no next repeat) and the original
 * gets a comment naming the copy, so nothing is lost and the way back is the same move. Links to other
 * todos cannot cross accounts: the copy's first comment lists them. Planned time stays with the original.
 */

type TodoRow = typeof todos.$inferSelect;

export interface MoveEnv {
  filesDir: string;
  filesLimitBytes: number;
}

/** `/api/v1/attachments/<id>/...` in Markdown (images and file links). */
const ATTACHMENT_URL = new RegExp(
  `${API_PREFIX.replaceAll("/", "\\/")}\\/attachments\\/(\\d+)(?=[/)\\s"'?#]|$)`,
  "g",
);

const attachmentIds = (texts: readonly string[]): number[] => [
  ...new Set(texts.flatMap((text) => [...text.matchAll(ATTACHMENT_URL)].map((m) => Number(m[1])))),
];

const rewriteAttachments = (text: string, ids: ReadonlyMap<number, number>): string =>
  text.replace(ATTACHMENT_URL, (whole, id: string) => {
    const to = ids.get(Number(id));
    return to === undefined ? whole : `${API_PREFIX}/attachments/${to}`;
  });

/** The subtasks under a todo, parents before children, in their order. */
function subtree(sc: Scoped, rootId: number): TodoRow[] {
  const out: TodoRow[] = [];
  let level = [rootId];
  while (level.length > 0) {
    const rows = sc.db
      .select()
      .from(todos)
      .where(owned(sc, todos, inArray(todos.parentId, level)))
      .orderBy(asc(todos.position), asc(todos.id))
      .all();
    out.push(...rows);
    level = rows.map((r) => r.id);
  }
  return out;
}

/** The labels' names in the other account, made there (same color, description and rank) when missing. */
function labelsThere(from: Scoped, to: Scoped, at: string, names: readonly string[]): string[] {
  if (names.length === 0) return [];
  const existing = new Set(
    to.db
      .select({ nameKey: labels.nameKey })
      .from(labels)
      .where(owned(to, labels))
      .all()
      .map((r) => r.nameKey),
  );
  for (const name of names) {
    const key = foldCase(name);
    if (existing.has(key)) continue;
    const source = from.db
      .select()
      .from(labels)
      .where(owned(from, labels, eq(labels.nameKey, key)))
      .get();
    const { scope, value } = parseLabelName(name);
    insertOwnedRow(to, labels, {
      name,
      nameKey: key,
      scope,
      value,
      color: source?.color ?? "#8B95A5",
      description: source?.description ?? "",
      rank: source?.rank ?? null,
      createdAt: at,
      updatedAt: at,
    });
    existing.add(key);
  }
  return [...names];
}

/** The people of the todo as references in the other account: users by username, others by name. */
function peopleThere(from: Scoped, to: Scoped, at: string, ids: readonly number[]): PersonRef[] {
  if (ids.length === 0) return [];
  const rows = from.db
    .select()
    .from(people)
    .where(owned(from, people, inArray(people.id, [...ids])))
    .all();
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.flatMap((id): PersonRef[] => {
    const row = byId.get(id);
    if (!row) return [];
    const byName = (): PersonRef[] => {
      // Several namesakes there: the first one (the move must not fail on it).
      const matches = findNamesakes(to, row.firstName, row.lastName);
      const found =
        matches[0] ?? resolvePeople(to, at, [{ firstName: row.firstName, lastName: row.lastName }], true)[0];
      return found ? [{ personId: found.id }] : [];
    };
    if (row.username) {
      try {
        const [found] = resolvePeople(to, at, [{ username: row.username }], true);
        return found ? [{ personId: found.id }] : [];
      } catch {
        // The user is gone or disabled: keep the person by name.
        return byName();
      }
    }
    return byName();
  });
}

/** Copies the files the texts show into the other account; old id -> new id. */
function copyFiles(
  from: Scoped,
  to: Scoped,
  env: MoveEnv,
  texts: readonly string[],
  written: string[],
): Map<number, number> {
  const ids = attachmentIds(texts);
  const map = new Map<number, number>();
  if (ids.length === 0) return map;
  const rows = from.db
    .select()
    .from(attachments)
    .where(owned(from, attachments, inArray(attachments.id, ids)))
    .all();
  if (rows.length === 0) return map;
  assertFilesQuota(
    to,
    env.filesLimitBytes,
    rows.reduce((sum, r) => sum + r.size, 0),
  );
  const fromDir = accountFilesDir(env.filesDir, from.accountId);
  const toDir = accountFilesDir(env.filesDir, to.accountId);
  for (const row of rows) {
    const temp = join(toDir, `.move-${randomBytes(8).toString("hex")}`);
    try {
      copyFileSync(join(fromDir, String(row.id)), temp);
    } catch {
      // The file is missing from the data folder: the link stays as it was.
      continue;
    }
    written.push(temp);
    const id = insertOwnedRow(to, attachments, {
      name: row.name,
      mimeType: row.mimeType,
      size: row.size,
      sha256: row.sha256,
      createdBy: row.createdBy,
      createdAt: row.createdAt,
    });
    const path = join(toDir, String(id));
    renameSync(temp, path);
    written[written.length - 1] = path;
    map.set(row.id, id);
  }
  return map;
}

interface Side {
  sc: Scoped;
  /** The shared project's id, or null for the member's own todos. */
  spaceId: number | null;
  /** "the shared project Extranet" / "Anna Berg's own todos". */
  label: string;
  actor: string;
  ref: (id: number) => string;
}

/**
 * Moves the todo `id` of the request's account (the caller's own, or the shared project it acts in) to
 * `input.spaceId` (null: the caller's own todos).
 */
export function moveTodo(
  db: Db,
  clock: () => Date,
  env: MoveEnv,
  auth: Auth,
  id: number,
  input: MoveTodo,
): MovedTodo {
  const member = getAccount(db, auth.account.id) as AccountRow;
  const name = memberName(member);
  const targetId = input.spaceId ?? member.id;
  if (targetId === auth.accountId) {
    throw new ApiError(
      "validation_failed",
      "The todo is already there. Pick one of its projects to move it inside it.",
    );
  }
  // A token's own name, also when it acts in a shared project ("Anna Berg via assistant").
  const tokenName =
    auth.via === "token" ? (auth.space ? auth.actor.slice(`${name} via `.length) : auth.actor) : null;
  const spaceName = (spaceId: number): string =>
    `the shared project ${getAccount(db, spaceId)?.displayName ?? spaceId}`;
  const mine = `${name}'s own todos`;
  const side = (tx: Tx, accountId: number, spaceId: number | null, actor: string): Side => ({
    sc: { db: tx, accountId },
    spaceId,
    label: spaceId === null ? mine : spaceName(spaceId),
    actor,
    ref: (n) => (spaceId === null ? `#${n}` : `S${spaceId}#${n}`),
  });
  if (input.spaceId !== null && !openSpace(db, member, input.spaceId)) {
    throw new ApiError(
      "not_found",
      "That shared project does not exist or you are not a member. Ask its owner to add you.",
    );
  }
  const at = clock().toISOString();
  const written: string[] = [];
  try {
    return db.transaction((tx) => {
      const from = side(tx, auth.accountId, auth.space?.id ?? null, auth.actor);
      const to = side(
        tx,
        targetId,
        input.spaceId,
        input.spaceId === null ? (tokenName ?? SESSION_ACTOR) : tokenName ? `${name} via ${tokenName}` : name,
      );
      const root = getTodo(from.sc, id);
      const projectId =
        input.projectId !== undefined
          ? input.projectId
          : input.spaceId === null
            ? null
            : (tx
                .select({ id: projects.id })
                .from(projects)
                .where(owned(to.sc, projects, isNull(projects.archivedAt)))
                .orderBy(asc(projects.id))
                .get()?.id ?? null);
      assertProjectExists(to.sc, projectId);

      const rootRow = tx
        .select()
        .from(todos)
        .where(owned(from.sc, todos, eq(todos.id, id)))
        .get() as TodoRow;
      const tree = [rootRow, ...subtree(from.sc, id)];
      const full = tree.map((row) => (row.id === id ? root : getTodo(from.sc, row.id)));
      const threads = new Map(
        tree.map((row) => [
          row.id,
          tx
            .select()
            .from(comments)
            .where(owned(from.sc, comments, eq(comments.todoId, row.id)))
            .orderBy(asc(comments.createdAt), asc(comments.id))
            .all(),
        ]),
      );
      const files = copyFiles(
        from.sc,
        to.sc,
        env,
        [...tree.map((r) => r.descriptionMd), ...[...threads.values()].flat().map((c) => c.bodyMd)],
        written,
      );

      // Comment authors as the other account names them: the member is "you" in their own todos.
      const author = (actor: string): string => {
        if (from.spaceId === null) return actor === SESSION_ACTOR ? name : `${name} via ${actor}`;
        if (to.spaceId !== null) return actor;
        if (actor === name) return SESSION_ACTOR;
        return actor.startsWith(`${name} via `) ? actor.slice(`${name} via `.length) : actor;
      };

      const copies = new Map<number, number>();
      for (const [i, row] of tree.entries()) {
        const todo = full[i] as Todo;
        const assigneeId =
          to.spaceId === null
            ? null
            : row.assigneeId !== null && isAssignable(tx, to.spaceId, row.assigneeId)
              ? row.assigneeId
              : from.spaceId === null || row.id === id
                ? isAssignable(tx, to.spaceId, member.id)
                  ? member.id
                  : null
                : null;
        const copy = insertTodo(
          to.sc,
          at,
          to.actor,
          {
            title: row.title,
            descriptionMd: rewriteAttachments(row.descriptionMd, files),
            status: row.status,
            projectId,
            dueOn: row.dueOn,
            plannedOn: row.plannedOn,
            labels: labelsThere(
              from.sc,
              to.sc,
              at,
              todo.labels.map((l) => l.name),
            ),
            requestedBy: peopleThere(
              from.sc,
              to.sc,
              at,
              todo.requestedBy.map((p) => p.id),
            ),
            contacts: peopleThere(
              from.sc,
              to.sc,
              at,
              todo.contacts.map((p) => p.id),
            ),
            urls: todo.urls.map((u) => ({ url: u.url, label: u.label })),
          },
          {
            parentId: row.id === id ? null : (copies.get(row.parentId as number) ?? null),
            position: row.position,
            recurrence: row.recurrence,
            assigneeId,
          },
        );
        copies.set(row.id, copy.id);
        for (const comment of threads.get(row.id) ?? []) {
          const commentId = insertOwnedRow(to.sc, comments, {
            todoId: copy.id,
            actor: author(comment.actor),
            authorKind: comment.authorKind,
            authorTokenId: comment.authorTokenId,
            bodyMd: rewriteAttachments(comment.bodyMd, files),
            createdAt: comment.createdAt,
            updatedAt: comment.updatedAt,
            editedAt: comment.editedAt,
          });
          indexComment(to.sc, commentId);
        }
      }

      const newId = copies.get(id) as number;
      const links = [
        ...root.links.blocks.map((t) => `blocks ${from.ref(t.id)} ${t.title}`),
        ...root.links.blockedBy.map((t) => `blocked by ${from.ref(t.id)} ${t.title}`),
        ...root.links.relatesTo.map((t) => `relates to ${from.ref(t.id)} ${t.title}`),
      ];
      const note = (sc: Scoped, todoId: number, actor: string, bodyMd: string) => {
        const commentId = insertOwnedRow(sc, comments, {
          todoId,
          actor,
          authorKind: auth.via,
          authorTokenId: auth.via === "token" ? auth.tokenId : null,
          bodyMd,
          createdAt: at,
          updatedAt: at,
        });
        indexComment(sc, commentId);
      };
      note(
        to.sc,
        newId,
        to.actor,
        [
          `Moved here from ${from.label} (${from.ref(id)}). Its history and planned time stay with the original there.`,
          ...(links.length > 0
            ? ["", "Links to other todos stayed there:", ...links.map((l) => `- ${l}`)]
            : []),
        ].join("\n"),
      );

      // The originals are done (directly: a repeat makes no next todo, the copy repeats instead).
      const open = tree.filter((row) => row.status !== "done");
      if (open.length > 0) {
        tx.update(todos)
          .set({ status: "done", doneAt: at, updatedAt: at, lastActivityAt: at })
          .where(
            owned(
              from.sc,
              todos,
              inArray(
                todos.id,
                open.map((r) => r.id),
              ),
            ),
          )
          .run();
        recordEvents(
          from.sc,
          from.actor,
          at,
          open.map((row) => ({
            todoId: row.id,
            kind: "status_changed" as const,
            data: { from: row.status, to: "done" },
          })),
        );
      }
      const there =
        to.spaceId === null
          ? `[${to.ref(newId)}](/u/${member.username}/todos/${newId})`
          : from.spaceId === null
            ? `[${to.ref(newId)}](/u/${member.username}/shared/${to.spaceId}/todos/${newId})`
            : to.ref(newId);
      note(
        from.sc,
        id,
        from.actor,
        `Moved to ${to.label} as ${there}${tree.length > 1 ? `, with its ${tree.length - 1} subtask${tree.length > 2 ? "s" : ""}` : ""}. This one is done; work goes on there.`,
      );
      tx.update(todos)
        .set({ lastActivityAt: at })
        .where(owned(to.sc, todos, eq(todos.id, newId)))
        .run();

      return {
        spaceId: input.spaceId,
        todo: getTodo(to.sc, newId),
        ref: to.ref(newId),
        original: getTodo(from.sc, id),
      };
    });
  } catch (error) {
    for (const path of written) rmSync(path, { force: true });
    throw error;
  }
}
