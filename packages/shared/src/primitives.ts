import { z } from "zod";

/** Database ids are positive integers. */
export const Id = z.number().int().positive();

/** An id that arrives as a string (path or query parameter). */
export const IdParam = z.coerce.number().int().positive();

/** UTC instant with milliseconds, e.g. `2026-11-11T14:30:00.000Z`. */
export const Timestamp = z.iso.datetime({ precision: 3 });

/** Local calendar date `YYYY-MM-DD`. */
export const CalendarDate = z.iso.date();

export const Color = z.string().regex(/^#[0-9A-Fa-f]{6}$/, "Use a hex color like #8B95A5.");

export const Slug = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Use lowercase letters, digits and single dashes, e.g. home-lab.");

export const TODO_STATUSES = ["open", "in_progress", "blocked", "done"] as const;
export const TodoStatus = z.enum(TODO_STATUSES);
export type TodoStatus = z.infer<typeof TodoStatus>;

/** Status names for people, e.g. in the activity thread. */
export const STATUS_LABELS: Record<TodoStatus, string> = {
  open: "Open",
  in_progress: "In progress",
  blocked: "Blocked",
  done: "Done",
};

/** Statuses a list shows when no status filter is given. */
export const ACTIVE_STATUSES = ["open", "in_progress", "blocked"] as const satisfies readonly TodoStatus[];

/** How a person is linked to a todo: asked for it, or someone to ask about it. */
export const PERSON_ROLES = ["requester", "contact"] as const;
export const PersonRole = z.enum(PERSON_ROLES);
export type PersonRole = z.infer<typeof PersonRole>;

/** Languages to use with a person, as stable codes, in this order. */
export const PERSON_LANGUAGES = ["de", "en"] as const;
export const PersonLanguage = z.enum(PERSON_LANGUAGES);
export type PersonLanguage = z.infer<typeof PersonLanguage>;

/** Names of the person languages for people. */
export const LANGUAGE_LABELS: Record<PersonLanguage, string> = { de: "German", en: "English" };

/** Kinds of todo history events (comments are their own rows, not events). */
export const EVENT_KINDS = [
  "created",
  "title_changed",
  "description_changed",
  "status_changed",
  "labels_changed",
  "people_changed",
  "project_changed",
  "dates_changed",
  "parent_changed",
  "subtasks_changed",
  "links_changed",
  "checklist_changed",
  "recurrence_changed",
  "recurred",
  "assignee_changed",
  "action_needed_changed",
] as const;
export const EventKind = z.enum(EVENT_KINDS);
export type EventKind = z.infer<typeof EventKind>;

export const SEARCH_KINDS = ["todo", "note", "comment", "person"] as const;
export const SearchKind = z.enum(SEARCH_KINDS);
export type SearchKind = z.infer<typeof SearchKind>;

export const TOKEN_SCOPES = ["read", "write"] as const;
export const TokenScope = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof TokenScope>;

/** Raw API token: "spz_" plus 40 base62 characters. Access and refresh tokens are server-only formats. */
export const TOKEN_PATTERN = /^spz_[0-9A-Za-z]{40}$/;
export const TOKEN_PREFIX_LENGTH = 12;

export const API_PREFIX = "/api/v1";

/** Colors offered for projects, person tags and accounts. The first is the default. */
export const PROJECT_COLORS = [
  "#8B95A5",
  "#4C9AFF",
  "#36B37E",
  "#FFB224",
  "#F2555A",
  "#A77BF3",
  "#2EC5CE",
  "#E5739F",
] as const;

/**
 * Migrations of the single-user versions (0000 to 0007 plus the drizzle base). The squashed Sloppanizer
 * baseline counts as SCHEMA_BASE + 1, so every older export has a lower schemaVersion.
 */
export const SCHEMA_BASE = 8;

export const DEFAULT_PROJECT_COLOR = "#8B95A5";
export const DEFAULT_LABEL_COLOR = "#8B95A5";
export const DEFAULT_PERSON_TAG_COLOR = "#8B95A5";

/** Uploads can be up to 25 MiB. */
export const MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Image types shown inline; every other upload is served as a download. */
export const INLINE_IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"] as const;

/** Comma separated list in a query string, e.g. `?label=a,b`. Empty parts are dropped. */
export const commaList = <T extends z.ZodType<string, string>>(item: T) =>
  z
    .string()
    .transform((raw) =>
      raw
        .split(",")
        .map((part) => part.trim())
        .filter((part) => part.length > 0),
    )
    .pipe(z.array(item));

/** "true" or "false" in a query string. */
export const QueryBoolean = z.enum(["true", "false"]).transform((value) => value === "true");
