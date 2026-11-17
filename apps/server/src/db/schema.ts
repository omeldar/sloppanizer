import { PERSON_ROLES } from "@organizer/shared";
import { sql } from "drizzle-orm";
import {
  check,
  foreignKey,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  unique,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { accounts } from "./auth-schema.ts";

/**
 * User data. Every change goes through a migration (`pnpm --filter @organizer/server db:generate`).
 * Timestamps are ISO 8601 UTC strings with milliseconds, calendar dates are `YYYY-MM-DD`.
 *
 * Every row belongs to one account (account_id, ON DELETE CASCADE from accounts). Tables with an id have
 * the primary key (account_id, id): ids are counted per account (account_sequences, services/owned.ts
 * nextId), so each account starts at #1 and an old single-user export keeps every id. References between
 * user tables are composite foreign keys that include account_id, so the database refuses a link between
 * two accounts' rows. Nullable references (todos.project_id, parent_id, recurrence_prev_id,
 * notes.project_id) use NO ACTION: a composite SET NULL would also null account_id, so the services clear
 * them before a delete in the same transaction.
 *
 * Hand edits in the baseline migration (drizzle-kit cannot express them): labels.name, topics.name and
 * person_tags.name are COLLATE NOCASE; their name_key (services/text.ts foldCase, unique per account) is
 * nullable in SQL (a restore leaves it out, services/name-keys.ts fills it) but notNull here so every insert
 * sets it; todos.recurrence has CHECK json_valid; the search index (search_fts, FTS5) exists only in SQL,
 * services/search-index.ts keeps it up to date.
 */

const accountId = () =>
  integer("account_id")
    .notNull()
    .references(() => accounts.id, { onDelete: "cascade" });

/** Per account and id table: the highest id ever given (never reused). */
export const accountSequences = sqliteTable(
  "account_sequences",
  {
    accountId: accountId(),
    tableName: text("table_name").notNull(),
    lastId: integer("last_id").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.tableName] })],
);

export const projects = sqliteTable(
  "projects",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    color: text("color").notNull().default("#8B95A5"),
    archivedAt: text("archived_at"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    unique("projects_slug_unique").on(t.accountId, t.slug),
  ],
);

export const labels = sqliteTable(
  "labels",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    scope: text("scope"),
    value: text("value").notNull(),
    color: text("color").notNull(),
    description: text("description").notNull().default(""),
    rank: integer("rank"),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    unique("labels_name_unique").on(t.accountId, t.name),
    unique("labels_name_key_unique").on(t.accountId, t.nameKey),
  ],
);

export const people = sqliteTable(
  "people",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    firstName: text("first_name").notNull(),
    lastName: text("last_name").notNull(),
    note: text("note").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    team: text("team").notNull().default(""),
    email: text("email").notNull().default(""),
    notesMd: text("notes_md").notNull().default(""),
    /** Language codes, comma-separated in the order of PERSON_LANGUAGES ("de,en"; "" = not set). */
    languages: text("languages").notNull().default(""),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    index("people_name_idx").on(t.accountId, sql`lower(${t.lastName})`, sql`lower(${t.firstName})`),
    index("people_team_idx").on(t.accountId, sql`lower(${t.team})`),
  ],
);

/** What people help with. A topic left with no people is deleted. */
export const topics = sqliteTable(
  "topics",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    unique("topics_name_unique").on(t.accountId, t.name),
    unique("topics_name_key_unique").on(t.accountId, t.nameKey),
  ],
);

export const personTopics = sqliteTable(
  "person_topics",
  {
    accountId: accountId(),
    personId: integer("person_id").notNull(),
    topicId: integer("topic_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.personId, t.topicId] }),
    foreignKey({
      name: "person_topics_person_fk",
      columns: [t.accountId, t.personId],
      foreignColumns: [people.accountId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_topics_topic_fk",
      columns: [t.accountId, t.topicId],
      foreignColumns: [topics.accountId, topics.id],
    }).onDelete("cascade"),
    index("person_topics_topic_idx").on(t.accountId, t.topicId),
  ],
);

/** The user's own judgments about people. Separate from todo labels (other lifecycle). */
export const personTags = sqliteTable(
  "person_tags",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    name: text("name").notNull(),
    nameKey: text("name_key").notNull(),
    color: text("color").notNull().default("#8B95A5"),
    description: text("description").notNull().default(""),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    unique("person_tags_name_unique").on(t.accountId, t.name),
    unique("person_tags_name_key_unique").on(t.accountId, t.nameKey),
  ],
);

export const personTagLinks = sqliteTable(
  "person_tag_links",
  {
    accountId: accountId(),
    personId: integer("person_id").notNull(),
    tagId: integer("tag_id").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.personId, t.tagId] }),
    foreignKey({
      name: "person_tag_links_person_fk",
      columns: [t.accountId, t.personId],
      foreignColumns: [people.accountId, people.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "person_tag_links_tag_fk",
      columns: [t.accountId, t.tagId],
      foreignColumns: [personTags.accountId, personTags.id],
    }).onDelete("cascade"),
    index("person_tag_links_tag_idx").on(t.accountId, t.tagId),
  ],
);

export const todos = sqliteTable(
  "todos",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    projectId: integer("project_id"),
    parentId: integer("parent_id"),
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
    /** The repeat rule as JSON (RecurrenceRule), or null. The migration adds CHECK json_valid by hand. */
    recurrence: text("recurrence"),
    /** The occurrence this todo was created from when the previous one was marked done. */
    recurrencePrevId: integer("recurrence_prev_id"),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    // NO ACTION (see the file comment): the services clear these before deleting the target.
    foreignKey({
      name: "todos_project_fk",
      columns: [t.accountId, t.projectId],
      foreignColumns: [projects.accountId, projects.id],
    }),
    foreignKey({
      name: "todos_parent_fk",
      columns: [t.accountId, t.parentId],
      foreignColumns: [t.accountId, t.id],
    }),
    foreignKey({
      name: "todos_recurrence_prev_fk",
      columns: [t.accountId, t.recurrencePrevId],
      foreignColumns: [t.accountId, t.id],
    }),
    check("todos_status_check", sql`${t.status} IN ('open','in_progress','blocked','done')`),
    check("todos_title_check", sql`length(${t.title}) BETWEEN 1 AND 300`),
    index("todos_status_idx").on(t.accountId, t.status),
    index("todos_project_idx").on(t.accountId, t.projectId),
    index("todos_parent_idx").on(t.accountId, t.parentId),
    index("todos_created_idx").on(t.accountId, t.createdAt),
    // One next occurrence per todo, also against double clicks and races.
    uniqueIndex("todos_recurrence_prev_idx")
      .on(t.accountId, t.recurrencePrevId)
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
    accountId: accountId(),
    id: integer("id").notNull(),
    fromId: integer("from_id").notNull(),
    toId: integer("to_id").notNull(),
    kind: text("kind", { enum: ["blocks", "relates"] }).notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    foreignKey({
      name: "todo_links_from_fk",
      columns: [t.accountId, t.fromId],
      foreignColumns: [todos.accountId, todos.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "todo_links_to_fk",
      columns: [t.accountId, t.toId],
      foreignColumns: [todos.accountId, todos.id],
    }).onDelete("cascade"),
    check("todo_links_kind_check", sql`${t.kind} IN ('blocks','relates')`),
    check("todo_links_self_check", sql`${t.fromId} <> ${t.toId}`),
    unique("todo_links_pair_unique").on(t.accountId, t.fromId, t.toId, t.kind),
    index("todo_links_to_idx").on(t.accountId, t.toId),
  ],
);

export const todoLabels = sqliteTable(
  "todo_labels",
  {
    accountId: accountId(),
    todoId: integer("todo_id").notNull(),
    labelId: integer("label_id").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.todoId, t.labelId] }),
    foreignKey({
      name: "todo_labels_todo_fk",
      columns: [t.accountId, t.todoId],
      foreignColumns: [todos.accountId, todos.id],
    }).onDelete("cascade"),
    foreignKey({
      name: "todo_labels_label_fk",
      columns: [t.accountId, t.labelId],
      foreignColumns: [labels.accountId, labels.id],
    }).onDelete("cascade"),
    index("todo_labels_label_idx").on(t.accountId, t.labelId),
  ],
);

export const todoPeople = sqliteTable(
  "todo_people",
  {
    accountId: accountId(),
    todoId: integer("todo_id").notNull(),
    personId: integer("person_id").notNull(),
    role: text("role", { enum: PERSON_ROLES }).notNull().default("requester"),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.todoId, t.personId, t.role] }),
    foreignKey({
      name: "todo_people_todo_fk",
      columns: [t.accountId, t.todoId],
      foreignColumns: [todos.accountId, todos.id],
    }).onDelete("cascade"),
    // NO ACTION: a person who is still linked cannot be deleted (the API answers 409 first).
    foreignKey({
      name: "todo_people_person_fk",
      columns: [t.accountId, t.personId],
      foreignColumns: [people.accountId, people.id],
    }),
    check("todo_people_role_check", sql`${t.role} IN ('requester','contact')`),
    index("todo_people_person_idx").on(t.accountId, t.personId),
  ],
);

export const events = sqliteTable(
  "events",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    todoId: integer("todo_id"),
    actor: text("actor").notNull(),
    kind: text("kind").notNull(),
    /** JSON with from/to. */
    data: text("data").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    foreignKey({
      name: "events_todo_fk",
      columns: [t.accountId, t.todoId],
      foreignColumns: [todos.accountId, todos.id],
    }).onDelete("cascade"),
    index("events_todo_idx").on(t.accountId, t.todoId),
  ],
);

export const apiTokens = sqliteTable(
  "api_tokens",
  {
    /** Global id: tokens are auth objects, never shown as #ids. */
    id: integer("id").primaryKey(),
    accountId: accountId(),
    name: text("name").notNull(),
    prefix: text("prefix").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    scope: text("scope", { enum: ["read", "write"] }).notNull(),
    createdAt: text("created_at").notNull(),
    lastUsedAt: text("last_used_at"),
    expiresAt: text("expires_at"),
    revokedAt: text("revoked_at"),
  },
  (t) => [
    check("api_tokens_scope_check", sql`${t.scope} IN ('read','write')`),
    unique("api_tokens_account_id_unique").on(t.accountId, t.id),
    index("api_tokens_account_idx").on(t.accountId),
  ],
);

/** Comments in a todo's thread. Delete is permanent. */
export const comments = sqliteTable(
  "comments",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    todoId: integer("todo_id").notNull(),
    /** Display name of the author at the time of writing ("you" for the session, else the token name). */
    actor: text("actor").notNull(),
    bodyMd: text("body_md").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
    editedAt: text("edited_at"),
    /**
     * Who wrote it: the browser session or an API token (author_token_id, owner of the comment). The id
     * is only valid on this server: it is left out of exports and linked again after a restore. NULL
     * for a token comment means no token owns it any more (only the session may change it). The
     * services only ever set the caller's own token.
     */
    authorKind: text("author_kind", { enum: ["session", "token"] }).notNull(),
    authorTokenId: integer("author_token_id").references(() => apiTokens.id, { onDelete: "set null" }),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    foreignKey({
      name: "comments_todo_fk",
      columns: [t.accountId, t.todoId],
      foreignColumns: [todos.accountId, todos.id],
    }).onDelete("cascade"),
    check("comments_body_check", sql`length(${t.bodyMd}) BETWEEN 1 AND 50000`),
    check("comments_author_kind_check", sql`${t.authorKind} IN ('session','token')`),
    index("comments_todo_idx").on(t.accountId, t.todoId, t.createdAt),
  ],
);

export const notes = sqliteTable(
  "notes",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    projectId: integer("project_id"),
    title: text("title").notNull(),
    bodyMd: text("body_md").notNull().default(""),
    pinnedAt: text("pinned_at"),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    // NO ACTION (see the file comment): a project delete moves its notes to no project first.
    foreignKey({
      name: "notes_project_fk",
      columns: [t.accountId, t.projectId],
      foreignColumns: [projects.accountId, projects.id],
    }),
    check("notes_title_check", sql`length(${t.title}) BETWEEN 1 AND 200`),
    index("notes_project_idx").on(t.accountId, t.projectId),
  ],
);

/** Web links of a todo (tickets, docs, pull requests): the URL and an optional label, in order. */
export const todoUrls = sqliteTable(
  "todo_urls",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    todoId: integer("todo_id").notNull(),
    url: text("url").notNull(),
    label: text("label").notNull().default(""),
    position: real("position").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    foreignKey({
      name: "todo_urls_todo_fk",
      columns: [t.accountId, t.todoId],
      foreignColumns: [todos.accountId, todos.id],
    }).onDelete("cascade"),
    check("todo_urls_url_check", sql`length(${t.url}) BETWEEN 1 AND 2000`),
    check("todo_urls_label_check", sql`length(${t.label}) <= 200`),
    index("todo_urls_todo_idx").on(t.accountId, t.todoId, t.position),
  ],
);

/**
 * Planner: reserved time, for a todo or with its own title. Start and end are UTC instants; the web app
 * and the tools show them in the account's time zone.
 */
export const timeBlocks = sqliteTable(
  "time_blocks",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    todoId: integer("todo_id"),
    title: text("title").notNull().default(""),
    startAt: text("start_at").notNull(),
    endAt: text("end_at").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
    updatedAt: text("updated_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    foreignKey({
      name: "time_blocks_todo_fk",
      columns: [t.accountId, t.todoId],
      foreignColumns: [todos.accountId, todos.id],
    }).onDelete("cascade"),
    check("time_blocks_order_check", sql`${t.endAt} > ${t.startAt}`),
    check("time_blocks_title_check", sql`length(${t.title}) <= 200`),
    check("time_blocks_what_check", sql`${t.todoId} IS NOT NULL OR length(${t.title}) > 0`),
    index("time_blocks_start_idx").on(t.accountId, t.startAt),
    index("time_blocks_todo_idx").on(t.accountId, t.todoId),
  ],
);

/**
 * Uploaded files, stored at <files dir>/<account id>/<id>. Ids are never reused (they are in Markdown
 * links). No owner columns: what uses an attachment is the Markdown that links it.
 */
export const attachments = sqliteTable(
  "attachments",
  {
    accountId: accountId(),
    id: integer("id").notNull(),
    name: text("name").notNull(),
    mimeType: text("mime_type").notNull(),
    size: integer("size").notNull(),
    sha256: text("sha256").notNull(),
    createdBy: text("created_by").notNull(),
    createdAt: text("created_at").notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.accountId, t.id] }),
    index("attachments_sha256_idx").on(t.accountId, t.sha256),
  ],
);

/** Settings per account. Keys: lastExportAt (exported), restoreInProgress (local, never exported). */
export const accountSettings = sqliteTable(
  "account_settings",
  {
    accountId: accountId(),
    key: text("key").notNull(),
    /** JSON. */
    value: text("value").notNull(),
  },
  (t) => [primaryKey({ columns: [t.accountId, t.key] })],
);

/** Every table with a per-account id (counted in account_sequences). */
export const ID_TABLES = [
  "projects",
  "labels",
  "people",
  "topics",
  "person_tags",
  "todos",
  "todo_links",
  "events",
  "comments",
  "notes",
  "attachments",
  "todo_urls",
  "time_blocks",
] as const;
export type IdTable = (typeof ID_TABLES)[number];
