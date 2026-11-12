import { z } from "zod";
import { LabelName } from "./labels.ts";
import { NextMode } from "./entities.ts";
import { PersonTagName, TopicName } from "./inputs.ts";
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
