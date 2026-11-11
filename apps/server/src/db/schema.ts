import { sql } from "drizzle-orm";
import {
  type AnySQLiteColumn,
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from "drizzle-orm/sqlite-core";

/**
 * Database schema. Every change goes through a migration (`pnpm --filter @organizer/server db:generate`).
 * Timestamps are ISO 8601 UTC strings with milliseconds, calendar dates are `YYYY-MM-DD`.
 * labels.name is COLLATE NOCASE: drizzle-kit cannot express that, so the migration SQL adds it by hand.
 */

export const projects = sqliteTable("projects", {
  id: integer("id").primaryKey(),
  slug: text("slug").notNull().unique(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  color: text("color").notNull().default("#8B95A5"),
  archivedAt: text("archived_at"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const labels = sqliteTable("labels", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  scope: text("scope"),
  value: text("value").notNull(),
  color: text("color").notNull(),
  description: text("description").notNull().default(""),
  rank: integer("rank"),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const people = sqliteTable(
  "people",
  {
    id: integer("id").primaryKey(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [index("people_name_idx").on(sql`lower(${t.lastName})`, sql`lower(${t.firstName})`)],
);

export const todos = sqliteTable(
  "todos",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
    parentId: integer("parent_id").references((): AnySQLiteColumn => todos.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    descriptionMd: text("description_md").notNull().default(""),
    status: text("status", { enum: ["open", "in_progress", "blocked", "done"] })
      .notNull()
      .default("open"),
    dueOn: text("due_on"),
    plannedOn: text("planned_on"),
    position: real("position").notNull().default(0),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    doneAt: text("done_at"),
    lastActivityAt: text("last_activity_at").notNull(),
  },
  (t) => [
    check("todos_status_check", sql`${t.status} IN ('open','in_progress','blocked','done')`),
    check("todos_title_check", sql`length(${t.title}) BETWEEN 1 AND 300`),
    index("todos_project_idx").on(t.projectId),
    index("todos_status_idx").on(t.status),
  ],
);

export const todoLabels = sqliteTable(
  "todo_labels",
  {
    todoId: integer("todo_id")
      .notNull()
      .references(() => todos.id, { onDelete: "cascade" }),
    labelId: integer("label_id")
      .notNull()
      .references(() => labels.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.todoId, t.labelId] }), index("todo_labels_label_idx").on(t.labelId)],
);

export const todoPeople = sqliteTable(
  "todo_people",
  {
    todoId: integer("todo_id")
      .notNull()
      .references(() => todos.id, { onDelete: "cascade" }),
    // RESTRICT: a person who is still linked cannot be deleted (the API answers 409 first).
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "restrict" }),
    role: text("role", { enum: ["requester"] })
      .notNull()
      .default("requester"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.todoId, t.personId, t.role] }),
    check("todo_people_role_check", sql`${t.role} IN ('requester')`),
    index("todo_people_person_idx").on(t.personId),
  ],
);

export const EVENT_KINDS = [
  "created",
  "title_changed",
  "description_changed",
  "status_changed",
  "labels_changed",
  "people_changed",
  "project_changed",
  "dates_changed",
] as const;
export type EventKind = (typeof EVENT_KINDS)[number];

export const events = sqliteTable(
  "events",
  {
    id: integer("id").primaryKey(),
    todoId: integer("todo_id").references(() => todos.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    kind: text("kind").notNull(),
    /** JSON with from/to. */
    data: text("data").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("events_todo_idx").on(t.todoId)],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    id: integer("id").primaryKey(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scope: text("scope", { enum: ["read", "write"] }).notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [check("api_tokens_scope_check", sql`${t.scope} IN ('read','write')`)],
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  /** JSON. */
  value: text("value").notNull(),
});
