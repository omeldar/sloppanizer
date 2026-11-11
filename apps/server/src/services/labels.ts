import {
  DEFAULT_LABEL_COLOR,
  type Label,
  type CreateLabel,
  type UpdateLabel,
  parseLabelName,
  sortLabels,
} from "@organizer/shared";
import { eq } from "drizzle-orm";
import { labels } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, now, type Tx } from "./context.ts";

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

export function updateLabel(ctx: Ctx, id: number, input: UpdateLabel): Label {
  const current = ctx.db.select().from(labels).where(eq(labels.id, id)).get();
  if (!current) throw notFound("Label", id);
  const patch: Partial<LabelRow> = { updatedAt: now(ctx) };
  if (input.name !== undefined) {
    assertNameFree(ctx.db, input.name, id);
    const { scope, value } = parseLabelName(input.name);
    Object.assign(patch, { name: input.name, scope, value });
  }
  if (input.color !== undefined) patch.color = input.color;
  if (input.description !== undefined) patch.description = input.description;
  if (input.rank !== undefined) patch.rank = input.rank;
  const row = ctx.db.update(labels).set(patch).where(eq(labels.id, id)).returning().get();
  return toLabel(row as LabelRow);
}

/** Deletes a label; it disappears from every todo (cascade). */
export function deleteLabel(ctx: Ctx, id: number): void {
  const result = ctx.db.delete(labels).where(eq(labels.id, id)).run();
  if (result.changes === 0) throw notFound("Label", id);
}
