import {
  type CreateProject,
  DEFAULT_PROJECT_COLOR,
  type Project,
  type ProjectRef,
  type UpdateProject,
} from "@organizer/shared";
import { asc, eq, inArray, type SQL, sql } from "drizzle-orm";
import { notes, projects, todos } from "../db/schema.ts";
import { ApiError, notFound } from "../http/errors.ts";
import { type Ctx, inTx, now, type Scoped } from "./context.ts";
import { recordEvents } from "./events.ts";
import { insertOwnedRow, owned } from "./owned.ts";
import { chunks } from "./sql.ts";

type ProjectRow = typeof projects.$inferSelect;

// Written out: drizzle renders select-list columns without their table, which a subquery would misread.
const openCountSql = sql<number>`(SELECT count(*) FROM "todos" t WHERE t.account_id = "projects"."account_id" AND t.project_id = "projects"."id" AND t.status <> 'done')`;

const toProject = (row: Omit<ProjectRow, "accountId"> & { openCount: number }): Project => ({
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

function selectProjects(sc: Scoped, ...where: (SQL | undefined)[]) {
  return sc.db
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
    .from(projects)
    .where(owned(sc, projects, ...where));
}

/** All projects, archived ones included (archivedAt tells them apart), by name. */
export function listProjects(sc: Scoped): Project[] {
  return selectProjects(sc)
    .orderBy(sql`lower(${projects.name})`, asc(projects.id))
    .all()
    .map(toProject);
}

export function getProject(sc: Scoped, id: number): Project {
  const row = selectProjects(sc, eq(projects.id, id)).get();
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

const slugTaken = (sc: Scoped, slug: string, exceptId?: number): boolean => {
  const row = sc.db
    .select({ id: projects.id })
    .from(projects)
    .where(owned(sc, projects, eq(projects.slug, slug)))
    .get();
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
    if (slugTaken(ctx, slug)) throw slugConflict(slug);
  } else {
    const base = slugify(input.name);
    slug = base;
    for (let n = 2; slugTaken(ctx, slug); n++) slug = `${base.slice(0, 60)}-${n}`;
  }
  const at = now(ctx);
  const id = ctx.db.transaction((tx) =>
    insertOwnedRow(inTx(ctx, tx), projects, {
      slug,
      name: input.name,
      description: input.description ?? "",
      color: input.color ?? DEFAULT_PROJECT_COLOR,
      createdAt: at,
      updatedAt: at,
    }),
  );
  return getProject(ctx, id);
}

export function updateProject(ctx: Ctx, id: number, input: UpdateProject): Project {
  const current = getProject(ctx, id);
  const at = now(ctx);
  const patch: Partial<ProjectRow> = { updatedAt: at };
  if (input.slug !== undefined) {
    if (slugTaken(ctx, input.slug, id)) throw slugConflict(input.slug);
    patch.slug = input.slug;
  }
  if (input.name !== undefined) patch.name = input.name;
  if (input.description !== undefined) patch.description = input.description;
  if (input.color !== undefined) patch.color = input.color;
  if (input.archived !== undefined) patch.archivedAt = input.archived ? (current.archivedAt ?? at) : null;
  ctx.db
    .update(projects)
    .set(patch)
    .where(owned(ctx, projects, eq(projects.id, id)))
    .run();
  return getProject(ctx, id);
}

/**
 * Deletes a project; its todos move to the Inbox (each gets a project_changed event) and its notes to no
 * project, before the delete (the references are NO ACTION, see db/schema.ts).
 */
export function deleteProject(ctx: Ctx, actor: string, id: number): void {
  getProject(ctx, id);
  const at = now(ctx);
  ctx.db.transaction((tx) => {
    const sc = inTx(ctx, tx);
    const moved = tx
      .select({ id: todos.id })
      .from(todos)
      .where(owned(sc, todos, eq(todos.projectId, id)))
      .all();
    tx.update(todos)
      .set({ projectId: null, updatedAt: at, lastActivityAt: at })
      .where(owned(sc, todos, eq(todos.projectId, id)))
      .run();
    tx.update(notes)
      .set({ projectId: null })
      .where(owned(sc, notes, eq(notes.projectId, id)))
      .run();
    recordEvents(
      sc,
      actor,
      at,
      moved.map((t) => ({ todoId: t.id, kind: "project_changed" as const, data: { from: id, to: null } })),
    );
    tx.delete(projects)
      .where(owned(sc, projects, eq(projects.id, id)))
      .run();
  });
}

/** A projectId in a write must name an existing project (422); null or undefined is fine. */
export function assertProjectExists(sc: Scoped, projectId: number | null | undefined): void {
  if (projectId === null || projectId === undefined) return;
  const row = sc.db
    .select({ id: projects.id })
    .from(projects)
    .where(owned(sc, projects, eq(projects.id, projectId)))
    .get();
  if (!row) {
    throw new ApiError(
      "validation_failed",
      `Project ${projectId} does not exist. Use an id from GET /api/v1/projects, or null for no project.`,
    );
  }
}

/** Short project references by id, for the given ids (nulls skipped). */
export function projectRefs(sc: Scoped, ids: readonly (number | null)[]): Map<number, ProjectRef> {
  const out = new Map<number, ProjectRef>();
  const unique = [...new Set(ids.filter((id) => id !== null))];
  for (const part of chunks(unique)) {
    for (const p of sc.db
      .select({ id: projects.id, slug: projects.slug, name: projects.name, color: projects.color })
      .from(projects)
      .where(owned(sc, projects, inArray(projects.id, part)))
      .all()) {
      out.set(p.id, p);
    }
  }
  return out;
}
