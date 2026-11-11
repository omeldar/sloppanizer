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

/** Statuses a list shows when no status filter is given. */
export const ACTIVE_STATUSES = ["open", "in_progress", "blocked"] as const satisfies readonly TodoStatus[];

export const TOKEN_SCOPES = ["read", "write"] as const;
export const TokenScope = z.enum(TOKEN_SCOPES);
export type TokenScope = z.infer<typeof TokenScope>;

/** Raw API token: "org_" plus 40 base62 characters. */
export const TOKEN_PATTERN = /^org_[0-9A-Za-z]{40}$/;
export const TOKEN_PREFIX_LENGTH = 12;

export const API_PREFIX = "/api/v1";

export const DEFAULT_PROJECT_COLOR = "#8B95A5";
export const DEFAULT_LABEL_COLOR = "#8B95A5";

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
