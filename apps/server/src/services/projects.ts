import {
  type CreateProject,
  DEFAULT_PROJECT_COLOR,
  type Project,
  type UpdateProject,
} from "@organizer/shared";
import { asc, eq, sql } from "drizzle-orm";
import { projects, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, now, type Tx } from "./context.ts";
import { recordEvents } from "./events.ts";

type ProjectRow = typeof projects.$inferSelect;

const openCountSql = sql<number>`(SELECT count(*) FROM ${todos} WHERE ${todos.projectId} = ${projects.id} AND ${todos.status} <> 'done')`;

const toProject = (row: ProjectRow & { openCount: number }): Project => ({
  id: row.id,
  slug: row.slug,
  name: row.name,
  description: row.description,
  color: row.color,
  archivedAt: row.archivedAt,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  openCount: row.openCount,
});

function selectProjects(db: Tx) {
  return db
    .select({
      id: projects.id,
      slug: projects.slug,
      name: projects.name,
      description: projects.description,
      color: projects.color,
      archivedAt: projects.archivedAt,
      createdAt: projects.createdAt,
      updatedAt: projects.updatedAt,
      openCount: openCountSql,
    })
    .from(projects);
}

/** All projects, archived ones included (archivedAt tells them apart), by name. */
export function listProjects(db: Tx): Project[] {
  return selectProjects(db)
    .orderBy(sql`lower(${projects.name})`, asc(projects.id))
    .all()
    .map(toProject);
}

export function getProject(db: Tx, id: number): Project {
  const row = selectProjects(db).where(eq(projects.id, id)).get();
  if (!row) throw notFound("Project", id);
  return toProject(row);
}

/** "Home Lab!" -> "home-lab"; falls back to `fallback` when nothing is left. */
export function slugify(name: string, fallback = "project"): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/, "");
  return slug || fallback;
}

const slugTaken = (db: Tx, slug: string, exceptId?: number): boolean => {
  const row = db.select({ id: projects.id }).from(projects).where(eq(projects.slug, slug)).get();
  return row !== undefined && row.id !== exceptId;
};

function slugConflict(slug: string): ApiError {
  return new ApiError(
    "conflict",
    `The slug "${slug}" is already used by another project. Pick another slug.`,
  );
}

export function createProject(ctx: Ctx, input: CreateProject): Project {
  let slug = input.slug;
  if (slug !== undefined) {
    if (slugTaken(ctx.db, slug)) throw slugConflict(slug);
  } else {
    const base = slugify(input.name);
    slug = base;
    for (let n = 2; slugTaken(ctx.db, slug); n++) slug = `${base.slice(0, 60)}-${n}`;
  }
  const at = now(ctx);
  const row = ctx.db
    .insert(projects)
    .values({
      slug,
      name: input.name,
      description: input.description ?? "",
      color: input.color ?? DEFAULT_PROJECT_COLOR,
      createdAt: at,
      updatedAt: at,
    })
    .returning({ id: projects.id })
    .get();
  return getProject(ctx.db, row.id);
}

export function updateProject(ctx: Ctx, id: number, input: UpdateProject): Project {
  const current = getProject(ctx.db, id);
  const at = now(ctx);
  const patch: Partial<ProjectRow> = { updatedAt: at };
  if (input.slug !== undefined) {
    if (slugTaken(ctx.db, input.slug, id)) throw slugConflict(input.slug);
    patch.slug = input.slug;
  }
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.color !== undefined) patch.color = input.color;
  if (input.archived !== undefined) patch.archivedAt = input.archived ? (current.archivedAt ?? at) : null;
  ctx.db.update(projects).set(patch).where(eq(projects.id, id)).run();
  return getProject(ctx.db, id);
}

/** Deletes a project; its todos move to the Inbox (each gets a project_changed event). */
export function deleteProject(ctx: Ctx, actor: string, id: number): void {
  getProject(ctx.db, id);
  const at = now(ctx);
  ctx.db.transaction((tx) => {
    const moved = tx.select({ id: todos.id }).from(todos).where(eq(todos.projectId, id)).all();
    tx.update(todos)
      .set({ projectId: null, updatedAt: at, lastActivityAt: at })
      .where(eq(todos.projectId, id))
      .run();
    recordEvents(
      tx,
      actor,
      at,
      moved.map((t) => ({ todoId: t.id, kind: "project_changed" as const, data: { from: id, to: null } })),
    );
    tx.delete(projects).where(eq(projects.id, id)).run();
  });
}
