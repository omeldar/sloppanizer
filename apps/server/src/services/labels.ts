import {
  DEFAULT_LABEL_COLOR,
  type Label,
  type CreateLabel,
  type ScopeConflictDetails,
  type UpdateLabel,
  parseLabelName,
  scopeKey,
  sortLabels,
} from "@organizer/shared";
import { and, eq, inArray, isNotNull } from "drizzle-orm";
import { labels, todoLabels, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, now, type Tx } from "./context.ts";
import { recordEvents } from "./events.ts";

export type LabelRow = typeof labels.$inferSelect;

export const toLabel = (row: LabelRow): Label => ({
  id: row.id,
  name: row.name,
  scope: row.scope,
  value: row.value,
  color: row.color,
  description: row.description,
  rank: row.rank,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

export function listLabels(db: Tx): Label[] {
  return sortLabels(db.select().from(labels).all().map(toLabel));
}

/**
 * The label rows for the given names (case-insensitive), in the given order.
 * Unknown names: 422 listing every one of them.
 */
export function resolveLabels(db: Tx, names: readonly string[]): LabelRow[] {
  if (names.length === 0) return [];
  const byName = new Map<string, LabelRow>();
  for (const row of db.select().from(labels).all()) byName.set(row.name.toLowerCase(), row);
  const unknown = names.filter((name) => !byName.has(name.toLowerCase()));
  if (unknown.length > 0) {
    throw new ApiError(
      "validation_failed",
      `Unknown label${unknown.length > 1 ? "s" : ""}: ${unknown.join(", ")}. Create ${unknown.length > 1 ? "them" : "it"} first (POST /api/v1/labels).`,
      { unknownLabels: unknown },
    );
  }
  return names.map((name) => byName.get(name.toLowerCase()) as LabelRow);
}

function assertNameFree(db: Tx, name: string, exceptId?: number): void {
  const existing = db.select().from(labels).where(eq(labels.name, name)).get();
  if (existing && existing.id !== exceptId) {
    throw new ApiError("conflict", `A label named "${existing.name}" already exists. Pick another name.`, {
      existing: toLabel(existing),
    });
  }
}

export function createLabel(ctx: Ctx, input: CreateLabel): Label {
  assertNameFree(ctx.db, input.name);
  const { scope, value } = parseLabelName(input.name);
  const at = now(ctx);
  const row = ctx.db
    .insert(labels)
    .values({
      name: input.name,
      scope,
      value,
      color: input.color ?? DEFAULT_LABEL_COLOR,
      description: input.description ?? "",
      rank: input.rank ?? null,
      createdAt: at,
      updatedAt: at,
    })
    .returning()
    .get();
  return toLabel(row);
}

interface LabelLink {
  todoId: number;
  label: LabelRow;
}

/** Every scoped label link (todo id with the label row). */
function scopedLinks(db: Tx, todoIds?: readonly number[]): LabelLink[] {
  return db
    .select({ todoId: todoLabels.todoId, label: labels })
    .from(todoLabels)
    .innerJoin(labels, eq(labels.id, todoLabels.labelId))
    .where(
      todoIds === undefined
        ? isNotNull(labels.scope)
        : and(isNotNull(labels.scope), inArray(todoLabels.todoId, [...todoIds])),
    )
    .all();
}

/** Label names of each given todo, in display order. */
function labelNamesByTodo(db: Tx, todoIds: readonly number[]): Map<number, string[]> {
  if (todoIds.length === 0) return new Map();
  const rows = db
    .select({ todoId: todoLabels.todoId, label: labels })
    .from(todoLabels)
    .innerJoin(labels, eq(labels.id, todoLabels.labelId))
    .where(inArray(todoLabels.todoId, [...todoIds]))
    .all();
  const out = new Map<number, LabelRow[]>();
  for (const { todoId, label } of rows) out.set(todoId, [...(out.get(todoId) ?? []), label]);
  return new Map([...out].map(([id, list]) => [id, sortLabels(list).map((l) => l.name)]));
}

/**
 * Removes labels from todos and records one labels_changed event per todo; bumps updated_at and
 * last_activity_at. `remove` maps todo ids to the label ids to take off; `before` are the names
 * the events start from (default: the names right now).
 */
function removeLabelsFromTodos(
  tx: Tx,
  actor: string,
  at: string,
  remove: ReadonlyMap<number, readonly number[]>,
  before = labelNamesByTodo(tx, [...remove.keys()]),
): void {
  const todoIds = [...remove.keys()];
  if (todoIds.length === 0) return;
  for (const [todoId, labelIds] of remove) {
    tx.delete(todoLabels)
      .where(and(eq(todoLabels.todoId, todoId), inArray(todoLabels.labelId, [...labelIds])))
      .run();
  }
  const after = labelNamesByTodo(tx, todoIds);
  tx.update(todos).set({ updatedAt: at, lastActivityAt: at }).where(inArray(todos.id, todoIds)).run();
  recordEvents(
    tx,
    actor,
    at,
    todoIds.map((todoId) => ({
      todoId,
      kind: "labels_changed" as const,
      data: { from: before.get(todoId) ?? [], to: after.get(todoId) ?? [] },
    })),
  );
}

/**
 * Todos that have label `labelId` and another label of `scope` (case-insensitive), with the label
 * ids of that scope to remove from each.
 */
function scopeConflicts(db: Tx, labelId: number, scope: string): Map<number, number[]> {
  const key = scopeKey(scope);
  const withLabel = db
    .select({ todoId: todoLabels.todoId })
    .from(todoLabels)
    .where(eq(todoLabels.labelId, labelId))
    .all()
    .map((r) => r.todoId);
  if (withLabel.length === 0) return new Map();
  const out = new Map<number, number[]>();
  for (const { todoId, label } of scopedLinks(db, withLabel)) {
    if (label.id === labelId || scopeKey(label.scope as string) !== key) continue;
    out.set(todoId, [...(out.get(todoId) ?? []), label.id]);
  }
  return out;
}

/**
 * Updates a label. A rename into another scope that todos already use would give them two labels
 * of one scope: onScopeConflict "fail" (default) answers 409 listing them, "replace" keeps this
 * label and removes the other labels of that scope from them (one labels_changed event each).
 */
export function updateLabel(ctx: Ctx, actor: string, id: number, input: UpdateLabel): Label {
  return ctx.db.transaction((tx) => {
    const current = tx.select().from(labels).where(eq(labels.id, id)).get();
    if (!current) throw notFound("Label", id);
    const at = now(ctx);
    const patch: Partial<LabelRow> = { updatedAt: at };
    let conflicts = new Map<number, number[]>();
    if (input.name !== undefined) {
      assertNameFree(tx, input.name, id);
      const { scope, value } = parseLabelName(input.name);
      Object.assign(patch, { name: input.name, scope, value });
      const sameScope =
        scope === null || (current.scope !== null && scopeKey(current.scope) === scopeKey(scope));
      if (!sameScope) conflicts = scopeConflicts(tx, id, scope);
      if (conflicts.size > 0 && input.onScopeConflict !== "replace") {
        const titles = new Map(
          tx
            .select({ id: todos.id, title: todos.title })
            .from(todos)
            .where(inArray(todos.id, [...conflicts.keys()]))
            .all()
            .map((t) => [t.id, t.title]),
        );
        const names = labelNamesByTodo(tx, [...conflicts.keys()]);
        const details: ScopeConflictDetails = {
          conflicts: [...conflicts.keys()]
            .toSorted((a, b) => a - b)
            .map((todoId) => ({
              todoId,
              title: titles.get(todoId) ?? "",
              labels: names.get(todoId) ?? [],
            })),
        };
        const n = conflicts.size;
        throw new ApiError(
          "conflict",
          `Renaming would give ${n} todo${n > 1 ? "s" : ""} two scope labels. Rename with onScopeConflict replace to keep this label and remove the others.`,
          details,
        );
      }
    }
    if (input.color !== undefined) patch.color = input.color;
    if (input.description !== undefined) patch.description = input.description;
    if (input.rank !== undefined) patch.rank = input.rank;
    // The events start from the names as the todos had them before the rename.
    const before = labelNamesByTodo(tx, [...conflicts.keys()]);
    const row = tx.update(labels).set(patch).where(eq(labels.id, id)).returning().get() as LabelRow;
    removeLabelsFromTodos(tx, actor, at, conflicts, before);
    return toLabel(row);
  });
}

/**
 * Repairs todos that have two or more labels of one scope (left by renames before step 3, or by a
 * restored export): keeps the label with the lowest rank (no rank last), then the lowest id, and
 * removes the others with a labels_changed event by "system". Idempotent; returns how many todos
 * it fixed.
 */
export function repairScopeConflicts(ctx: Ctx): number {
  return ctx.db.transaction((tx) => {
    const groups = new Map<string, LabelLink[]>();
    for (const link of scopedLinks(tx)) {
      const key = `${link.todoId}\u0000${scopeKey(link.label.scope as string)}`;
      groups.set(key, [...(groups.get(key) ?? []), link]);
    }
    const remove = new Map<number, number[]>();
    for (const links of groups.values()) {
      if (links.length < 2) continue;
      const [, ...losers] = links.toSorted(
        (a, b) =>
          (a.label.rank ?? Number.POSITIVE_INFINITY) - (b.label.rank ?? Number.POSITIVE_INFINITY) ||
          a.label.id - b.label.id,
      );
      for (const { todoId, label } of losers) remove.set(todoId, [...(remove.get(todoId) ?? []), label.id]);
    }
    removeLabelsFromTodos(tx, "system", now(ctx), remove);
    return remove.size;
  });
}

/** Deletes a label; it disappears from every todo (cascade). */
export function deleteLabel(ctx: Ctx, id: number): void {
  const result = ctx.db.delete(labels).where(eq(labels.id, id)).run();
  if (result.changes === 0) throw notFound("Label", id);
}
