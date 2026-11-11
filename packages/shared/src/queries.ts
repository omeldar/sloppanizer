import { z } from "zod";
import { LabelName } from "./labels.ts";
import { NextMode } from "./entities.ts";
import { ACTIVE_STATUSES, CalendarDate, commaList, IdParam, TodoStatus } from "./primitives.ts";

export const IdParams = z.strictObject({ id: IdParam });
export type IdParams = z.infer<typeof IdParams>;

/** `projectId` filter: a project id or "inbox" (todos without a project). */
export const ProjectFilter = z.union([z.literal("inbox"), IdParam]);
export type ProjectFilter = z.infer<typeof ProjectFilter>;

/** `status` filter: comma list of statuses, or "all". Defaults to the active statuses. */
export const StatusFilter = z.union([z.literal("all"), commaList(TodoStatus)]).default([...ACTIVE_STATUSES]);
export type StatusFilter = z.infer<typeof StatusFilter>;

export const TODO_SORTS = ["created", "updated", "due", "priority", "position"] as const;

export const TodoListQuery = z.strictObject({
  status: StatusFilter,
  projectId: ProjectFilter.optional(),
  /** Comma list; a todo must have every label (AND). */
  label: commaList(LabelName).optional(),
  personId: IdParam.optional(),
  /** Title substring for now. */
  q: z.string().trim().max(200).optional(),
  dueBefore: CalendarDate.optional(),
  plannedOn: CalendarDate.optional(),
  sort: z.enum(TODO_SORTS).default("created"),
  order: z.enum(["asc", "desc"]).default("desc"),
  limit: z.coerce.number().int().min(1).max(500).default(100),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TodoListQuery = z.infer<typeof TodoListQuery>;

export const NextQuery = z.strictObject({
  mode: NextMode.default("smart"),
  projectId: ProjectFilter.optional(),
  label: commaList(LabelName).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});
export type NextQuery = z.infer<typeof NextQuery>;

export const PeopleQuery = z.strictObject({ q: z.string().trim().max(200).optional() });
export type PeopleQuery = z.infer<typeof PeopleQuery>;
