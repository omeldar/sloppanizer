import { PERSON_ROLES } from "@organizer/shared";
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
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";

/**
 * Database schema. Every change goes through a migration (`pnpm --filter @organizer/server db:generate`).
 * Timestamps are ISO 8601 UTC strings with milliseconds, calendar dates are `YYYY-MM-DD`.
 * labels.name, topics.name and person_tags.name are COLLATE NOCASE: drizzle-kit cannot express that,
 * so the migration SQL adds it by hand. NOCASE folds ASCII only, so these tables also have name_key
 * (services/text.ts foldCase: NFC and lowercase for every script), unique, set by the services on every
 * write. In the database name_key may be NULL (migration 0006 adds it to filled tables, a restore leaves
 * it out); services/name-keys.ts repairNameKeys fills it and merges duplicates at every start and after
 * a restore. The schema says notNull so that every insert has to set it. The search index (search_fts, FTS5) lives only in a custom
 * migration; services/search-index.ts keeps it up to date.
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
  nameKey: text("name_key").notNull().unique(),
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
    team: text("team").notNull().default(""),
    email: text("email").notNull().default(""),
    notesMd: text("notes_md").notNull().default(""),
  },
  (t) => [
    index("people_name_idx").on(sql`lower(${t.lastName})`, sql`lower(${t.firstName})`),
    index("people_team_idx").on(sql`lower(${t.team})`),
  ],
);

/** What people help with. A topic left with no people is deleted. */
export const topics = sqliteTable("topics", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  nameKey: text("name_key").notNull().unique(),
  createdAt: text("created_at").notNull(),
});

export const personTopics = sqliteTable(
  "person_topics",
  {
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    topicId: integer("topic_id")
      .notNull()
      .references(() => topics.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.topicId] }), index("person_topics_topic_idx").on(t.topicId)],
);

/** The user's own judgments about people. Separate from todo labels (other lifecycle, private later). */
export const personTags = sqliteTable("person_tags", {
  id: integer("id").primaryKey(),
  name: text("name").notNull().unique(),
  nameKey: text("name_key").notNull().unique(),
  color: text("color").notNull().default("#8B95A5"),
  description: text("description").notNull().default(""),
  createdAt: text("created_at").notNull(),
  updatedAt: text("updated_at").notNull(),
});

export const personTagLinks = sqliteTable(
  "person_tag_links",
  {
    personId: integer("person_id")
      .notNull()
      .references(() => people.id, { onDelete: "cascade" }),
    tagId: integer("tag_id")
      .notNull()
      .references(() => personTags.id, { onDelete: "cascade" }),
    createdAt: text("created_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.personId, t.tagId] }), index("person_tag_links_tag_idx").on(t.tagId)],
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
    /** The repeat rule as JSON (RecurrenceRule), or null. 0005 adds CHECK json_valid by hand. */
    recurrence: text("recurrence"),
    /** The occurrence this todo was created from when the previous one was marked done. */
    recurrencePrevId: integer("recurrence_prev_id").references((): AnySQLiteColumn => todos.id, {
      onDelete: "set null",
    }),
  },
  (t) => [
    check("todos_status_check", sql`${t.status} IN ('open','in_progress','blocked','done')`),
    check("todos_title_check", sql`length(${t.title}) BETWEEN 1 AND 300`),
    index("todos_project_idx").on(t.projectId),
    index("todos_status_idx").on(t.status),
    index("todos_parent_idx").on(t.parentId),
    // One next occurrence per todo, also against double clicks and races.
    uniqueIndex("todos_recurrence_prev_idx")
      .on(t.recurrencePrevId)
      .where(sql`${t.recurrencePrevId} IS NOT NULL`),
  ],
);

/**
 * Links between todos. "blocks": from_id blocks to_id. "relates" has no direction and is stored
 * with from_id < to_id, so a pair has one row.
 */
export const todoLinks = sqliteTable(
  "todo_links",
  {
    id: integer("id").primaryKey(),
    fromId: integer("from_id")
      .notNull()
      .references(() => todos.id, { onDelete: "cascade" }),
    toId: integer("to_id")
      .notNull()
      .references(() => todos.id, { onDelete: "cascade" }),
    kind: text("kind", { enum: ["blocks", "relates"] }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    check("todo_links_kind_check", sql`${t.kind} IN ('blocks','relates')`),
    check("todo_links_self_check", sql`${t.fromId} <> ${t.toId}`),
    unique("todo_links_pair_unique").on(t.fromId, t.toId, t.kind),
    index("todo_links_to_idx").on(t.toId),
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
    role: text("role", { enum: PERSON_ROLES }).notNull().default("requester"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.todoId, t.personId, t.role] }),
    check("todo_people_role_check", sql`${t.role} IN ('requester','contact')`),
    index("todo_people_person_idx").on(t.personId),
  ],
);

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

/** Comments in a todo's thread. Delete is permanent. */
export const comments = sqliteTable(
  "comments",
  {
    id: integer("id").primaryKey(),
    todoId: integer("todo_id")
      .notNull()
      .references(() => todos.id, { onDelete: "cascade" }),
    actor: text("actor").notNull(),
    bodyMd: text("body_md").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    editedAt: text("edited_at"),
  },
  (t) => [
    check("comments_body_check", sql`length(${t.bodyMd}) BETWEEN 1 AND 50000`),
    index("comments_todo_idx").on(t.todoId, t.createdAt),
  ],
);

export const notes = sqliteTable(
  "notes",
  {
    id: integer("id").primaryKey(),
    projectId: integer("project_id").references(() => projects.id, { onDelete: "set null" }),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull().default(""),
    pinnedAt: text("pinned_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    check("notes_title_check", sql`length(${t.title}) BETWEEN 1 AND 200`),
    index("notes_project_idx").on(t.projectId),
  ],
);

/**
 * Uploaded files, stored at <data dir>/attachments/<id>. Ids are never reused (they are in Markdown
 * links). No owner columns: what uses an attachment is the Markdown that links it.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [index("attachments_sha256_idx").on(t.sha256)],
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
