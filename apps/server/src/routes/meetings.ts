import {
  API_PREFIX,
  CreateMeeting,
  IdParams,
  Meeting,
  MeetingDateParams,
  MeetingOccurrence,
  OccurrenceChange,
  OccurrenceQuery,
  ScheduleChange,
  UpdateMeeting,
} from "@organizer/shared";
import { z } from "zod";
import {
  changeOccurrence,
  changeSchedule,
  createMeeting,
  deleteMeeting,
  getMeeting,
  listMeetings,
  listOccurrences,
  updateMeeting,
} from "../services/meetings.ts";
import { type App, ctxOf, type Deps } from "./types.ts";

/** Meetings, their repeat and single date changes. Every id is looked up in the caller's account. */
export function meetingRoutes(app: App, deps: Deps): void {
  const tags = ["meetings"];
  app.get(
    `${API_PREFIX}/meetings`,
    {
      schema: {
        tags,
        summary: "Every meeting, the next one first",
        response: { 200: z.array(Meeting) },
      },
    },
    async (request) => listMeetings(ctxOf(request, deps)),
  );
  app.post(
    `${API_PREFIX}/meetings`,
    {
      schema: {
        tags,
        summary: "Create a meeting with its repeat (type left out: suggested from the name)",
        body: CreateMeeting,
        response: { 201: Meeting },
      },
    },
    async (request, reply) => reply.status(201).send(createMeeting(ctxOf(request, deps), request.body)),
  );
  app.get(
    `${API_PREFIX}/meetings/occurrences`,
    {
      schema: {
        tags,
        summary: "Meeting dates that overlap the days from..to (account time zone), by start",
        querystring: OccurrenceQuery,
        response: { 200: z.array(MeetingOccurrence) },
      },
    },
    async (request) => listOccurrences(ctxOf(request, deps), request.query),
  );
  app.get(
    `${API_PREFIX}/meetings/:id`,
    { schema: { tags, params: IdParams, response: { 200: Meeting } } },
    async (request) => getMeeting(ctxOf(request, deps), request.params.id),
  );
  app.patch(
    `${API_PREFIX}/meetings/:id`,
    {
      schema: {
        tags,
        summary: "Rename a meeting, change its type, standup filter or where the list counts from",
        params: IdParams,
        body: UpdateMeeting,
        response: { 200: Meeting },
      },
    },
    async (request) => updateMeeting(ctxOf(request, deps), request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/meetings/:id`,
    { schema: { tags, summary: "Delete a meeting (its notes stay)", params: IdParams } },
    async (request, reply) => {
      deleteMeeting(ctxOf(request, deps), request.params.id);
      return reply.status(204).send();
    },
  );
  app.patch(
    `${API_PREFIX}/meetings/:id/schedule`,
    {
      schema: {
        tags,
        summary: "Change the repeat from a date on (following) or of the part that holds it (all)",
        params: IdParams,
        body: ScheduleChange,
        response: { 200: Meeting },
      },
    },
    async (request) => changeSchedule(ctxOf(request, deps), request.params.id, request.body),
  );
  app.patch(
    `${API_PREFIX}/meetings/:id/occurrences/:on`,
    {
      schema: {
        tags,
        summary: "Move, cancel or restore one date (this one, this and following, or all)",
        params: MeetingDateParams,
        body: OccurrenceChange,
        response: { 200: Meeting },
      },
    },
    async (request) =>
      changeOccurrence(ctxOf(request, deps), request.params.id, request.params.on, request.body),
  );
}
