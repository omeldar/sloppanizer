import { z } from "zod";
import { LabelName } from "./labels.ts";
import { NextMode } from "./entities.ts";
import { LinkKind, PersonTagName, TopicName } from "./inputs.ts";
import {
  ACTIVE_STATUSES,
  CalendarDate,
  commaList,
  IdParam,
  PersonRole,
  QueryBoolean,
  SEARCH_KINDS,
  SearchKind,
  TodoStatus,
} from "./primitives.ts";

export const IdParams = z.strictObject({ id: IdParam });
export type IdParams = z.infer<typeof IdParams>;

/** `projectId` filter: a project id or "inbox" (todos without a project). */
export const ProjectFilter = z.union([z.literal("inbox"), IdParam]);
export type ProjectFilter = z.infer<typeof ProjectFilter>;

/** `status` filter: comma list of statuses, or "all". Defaults to the active statuses. */
export const StatusFilter = z.union([z.literal("all"), commaList(TodoStatus)]).default([...ACTIVE_STATUSES]);
export type StatusFilter = z.infer<typeof StatusFilter>;

export const TODO_SORTS = ["created", "updated", "due", "priority", "position"] as const;

export const TodoListQuery = z
  .strictObject({
    status: StatusFilter,
    projectId: ProjectFilter.optional(),
    /** Comma list; a todo must have every label (AND). */
    label: commaList(LabelName).optional(),
    personId: IdParam.optional(),
    /** Children of this todo, or "none" for top-level todos only. */
    parentId: z.union([z.literal("none"), IdParam]).optional(),
    /** How personId is linked: requester (default, the step 1 meaning), contact or any. */
    personRole: z.enum([...PersonRole.options, "any"]).default("requester"),
    /** Title substring for now. */
    q: z.string().trim().max(200).optional(),
    dueBefore: CalendarDate.optional(),
    plannedOn: CalendarDate.optional(),
    /** Inclusive range of planned dates. */
    plannedFrom: CalendarDate.optional(),
    plannedTo: CalendarDate.optional(),
    /** true = only todos without a planned date. */
    unplanned: QueryBoolean.optional(),
    /** Done todos only from the start of that local day on; other statuses are not affected. */
    doneAfter: CalendarDate.optional(),
    sort: z.enum(TODO_SORTS).default("created"),
    order: z.enum(["asc", "desc"]).default("desc"),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .superRefine((value, ctx) => {
    if (value.unplanned === true && (value.plannedFrom !== undefined || value.plannedTo !== undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["unplanned"],
        message: "Send either unplanned=true or plannedFrom/plannedTo, not both.",
      });
    }
  });
export type TodoListQuery = z.infer<typeof TodoListQuery>;

export const NextQuery = z.strictObject({
  mode: NextMode.default("smart"),
  projectId: ProjectFilter.optional(),
  label: commaList(LabelName).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type NextQuery = z.infer<typeof NextQuery>;

export const PEOPLE_KINDS = ["requester", "contact"] as const;
export const PEOPLE_SORTS = ["name", "requested", "contact", "recent"] as const;

export const PeopleQuery = z.strictObject({
  /** Names, note, team, email and topic names; case-insensitive, umlauts folded. */
  q: z.string().trim().max(200).optional(),
  /** Comma list of topic names; a person must have every one (AND). */
  topic: commaList(TopicName).optional(),
  /** Exact team, case-insensitive. */
  team: z.string().trim().max(100).optional(),
  /** Comma list of person tag names (AND). */
  tag: commaList(PersonTagName).optional(),
  /** requester: requested at least one todo; contact: contact on a todo or has a topic. */
  kind: z.enum(PEOPLE_KINDS).optional(),
  /** name (default), requested / contact (most first), recent (newest todo link first). */
  sort: z.enum(PEOPLE_SORTS).default("name"),
});
export type PeopleQuery = z.infer<typeof PeopleQuery>;

/** `projectId` filter for notes: a project id or "none" (notes without a project). */
export const NoteProjectFilter = z.union([z.literal("none"), IdParam]);
export type NoteProjectFilter = z.infer<typeof NoteProjectFilter>;

export const NoteListQuery = z.strictObject({
  projectId: NoteProjectFilter.optional(),
  pinned: QueryBoolean.optional(),
  /** Title substring, case-insensitive. */
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type NoteListQuery = z.infer<typeof NoteListQuery>;

export const SearchQuery = z.strictObject({
  q: z.string().trim().min(1, "Type something to search for.").max(200),
  /** Comma list; default all four kinds. */
  kinds: commaList(SearchKind)
    .refine((kinds) => kinds.length > 0, "Name at least one kind: todo, note, comment or person.")
    .default([...SEARCH_KINDS]),
  /** Per kind. */
  limit: z.coerce.number().int().min(1).max(100).default(20),
});
export type SearchQuery = z.infer<typeof SearchQuery>;

export const TopicQuery = z.strictObject({
  /** Substring, case-insensitive. */
  q: z.string().trim().max(60).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(20),
});
export type TopicQuery = z.infer<typeof TopicQuery>;

export const AttachmentUploadQuery = z.strictObject({
  /** Original file name; sanitized by the server. */
  name: z.string().max(1000).optional(),
});
export type AttachmentUploadQuery = z.infer<typeof AttachmentUploadQuery>;

/** /attachments/:id/:name; the name is only there for readable links and is ignored. */
export const AttachmentFileParams = z.strictObject({ id: IdParam, name: z.string() });
export type AttachmentFileParams = z.infer<typeof AttachmentFileParams>;

export const PEOPLE_STATS_SORTS = ["total", "open", "done", "speed", "recent", "name"] as const;

/** Filters of the people statistics; from/to are inclusive and apply to the todo's local created date. */
const peopleStatsFilters = {
  from: CalendarDate.optional(),
  to: CalendarDate.optional(),
  /** Comma lists of names (AND); they choose the people. */
  topic: commaList(TopicName).optional(),
  tag: commaList(PersonTagName).optional(),
  /** Exact team, case-insensitive. */
  team: z.string().trim().max(100).optional(),
  /** Todo labels (AND); they narrow the todos. */
  label: commaList(LabelName).optional(),
  projectId: ProjectFilter.optional(),
};

function checkPeriod(value: { from?: string | undefined; to?: string | undefined }, ctx: z.RefinementCtx) {
  if (value.from !== undefined && value.to !== undefined && value.from > value.to) {
    ctx.addIssue({ code: "custom", path: ["to"], message: "The end of the period is before its start." });
  }
}

export const PeopleStatsQuery = z
  .strictObject({
    ...peopleStatsFilters,
    /** Who is listed and what total/open/done sort on. */
    role: PersonRole.default("requester"),
    /** speed = median took, fastest first, people without done todos last. */
    sort: z.enum(PEOPLE_STATS_SORTS).default("total"),
    limit: z.coerce.number().int().min(1).max(500).default(50),
  })
  .superRefine(checkPeriod);
export type PeopleStatsQuery = z.infer<typeof PeopleStatsQuery>;

/** GET /stats/people/:id: the same filters without role and sort. */
export const PersonStatsQuery = z.strictObject(peopleStatsFilters).superRefine(checkPeriod);
export type PersonStatsQuery = z.infer<typeof PersonStatsQuery>;

/** DELETE /todos/:id/links/:otherId. */
export const LinkParams = z.strictObject({ id: IdParam, otherId: IdParam });
export type LinkParams = z.infer<typeof LinkParams>;

export const LinkDeleteQuery = z.strictObject({ kind: LinkKind });
export type LinkDeleteQuery = z.infer<typeof LinkDeleteQuery>;

export const RestoreUploadQuery = z.strictObject({
  /** Original file name, shown in the preview. */
  name: z.string().max(1000).optional(),
});
export type RestoreUploadQuery = z.infer<typeof RestoreUploadQuery>;

export const RestoreParams = z.strictObject({
  uploadId: z.string().regex(/^[0-9a-f]{32}$/, "Unknown upload id."),
});
export type RestoreParams = z.infer<typeof RestoreParams>;

export const BackupParams = z.strictObject({ fileName: z.string().max(200) });
export type BackupParams = z.infer<typeof BackupParams>;

export const UrlParams = z.strictObject({ id: IdParam, urlId: IdParam });
export type UrlParams = z.infer<typeof UrlParams>;
