import { z } from "zod";
import { ProjectRef, TodoRef } from "./entities.ts";
import { CalendarDate, Id, Timestamp } from "./primitives.ts";

/** Web links: http(s) or mailto, as typed (a bare host gets https://). */
export const WebUrl = z
  .string()
  .trim()
  .min(1, "Enter a link.")
  .max(2000, "A link has at most 2000 characters.")
  .transform((value) => (/^[a-z][a-z0-9+.-]*:/i.test(value) ? value : `https://${value}`))
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        ["http:", "https:", "mailto:"].includes(url.protocol) &&
        (url.protocol === "mailto:" || url.hostname.includes("."))
      );
    } catch {
      return false;
    }
  }, "Enter a web address like https://example.com/page.");

const UrlLabel = z.string().trim().max(200, "A link label has at most 200 characters.");

export const UrlInput = z.strictObject({ url: WebUrl, label: UrlLabel.optional() });
export type UrlInput = z.infer<typeof UrlInput>;

export const UrlList = z.array(UrlInput).max(50, "A todo has at most 50 links.");

export const AddUrls = z.strictObject({ urls: UrlList.min(1, "Send at least one link.") });
export type AddUrls = z.infer<typeof AddUrls>;

export const UpdateUrl = z
  .strictObject({ url: WebUrl.optional(), label: UrlLabel.optional() })
  .refine((v) => v.url !== undefined || v.label !== undefined, "Send url or label.");
export type UpdateUrl = z.infer<typeof UpdateUrl>;

/** Any ISO instant with an offset; stored as UTC with milliseconds. */
const Instant = z.iso.datetime({ offset: true }).transform((value) => new Date(value).toISOString());

export const MAX_BLOCK_MS = 24 * 60 * 60 * 1000;
export const MIN_BLOCK_MS = 5 * 60 * 1000;

const BlockTitle = z.string().trim().max(200, "A title has at most 200 characters.");

export const CreateTimeBlock = z
  .strictObject({
    /** The todo the time is for; without it, title names the block. */
    todoId: Id.nullable().optional(),
    title: BlockTitle.optional(),
    startAt: Instant,
    endAt: Instant,
  })
  .superRefine((value, ctx) => {
    if (!value.todoId && !value.title) {
      ctx.addIssue({ code: "custom", message: "Pick a todo or give the block a title.", path: ["title"] });
    }
    checkSpan(ctx, value.startAt, value.endAt);
  });
export type CreateTimeBlock = z.infer<typeof CreateTimeBlock>;

export const UpdateTimeBlock = z
  .strictObject({
    todoId: Id.nullable().optional(),
    title: BlockTitle.optional(),
    startAt: Instant.optional(),
    endAt: Instant.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Send at least one field to change.");
export type UpdateTimeBlock = z.infer<typeof UpdateTimeBlock>;

/** Start before end, at least 5 minutes, at most a day. */
export function checkSpan(ctx: z.RefinementCtx, startAt: string, endAt: string): void {
  const ms = Date.parse(endAt) - Date.parse(startAt);
  if (ms <= 0)
    ctx.addIssue({ code: "custom", message: "The block must end after it starts.", path: ["endAt"] });
  else if (ms < MIN_BLOCK_MS)
    ctx.addIssue({ code: "custom", message: "A block lasts at least 5 minutes.", path: ["endAt"] });
  else if (ms > MAX_BLOCK_MS)
    ctx.addIssue({ code: "custom", message: "A block lasts at most 24 hours.", path: ["endAt"] });
}

/** Days in the account's time zone, both included; at most 62 days. */
export const TimeBlockQuery = z
  .strictObject({
    from: CalendarDate,
    to: CalendarDate,
    todoId: z.coerce.number().int().positive().optional(),
  })
  .refine((v) => v.to >= v.from, { message: "to must not be before from.", path: ["to"] })
  .refine((v) => (Date.parse(v.to) - Date.parse(v.from)) / 86_400_000 <= 62, {
    message: "Ask for at most 62 days at once.",
    path: ["to"],
  });
export type TimeBlockQuery = z.infer<typeof TimeBlockQuery>;

export const TimeBlock = z.strictObject({
  id: Id,
  todoId: Id.nullable(),
  /** The block's own title; "" for a todo's block (show todo.title). */
  title: z.string(),
  startAt: Timestamp,
  endAt: Timestamp,
  todo: TodoRef.nullable(),
  /** The todo's project, for its color. */
  project: ProjectRef.nullable(),
  createdBy: z.string(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TimeBlock = z.infer<typeof TimeBlock>;
