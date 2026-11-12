import {
  API_PREFIX,
  CreateNote,
  IdParams,
  Note,
  NoteListQuery,
  NotePage,
  UpdateNote,
} from "@organizer/shared";
import { createNote, deleteNote, getNote, listNotes, updateNote } from "../services/notes.ts";
import { actorOf, type App, type Deps } from "./types.ts";

export function noteRoutes(app: App, deps: Deps): void {
  const tags = ["notes"];
  app.get(
    `${API_PREFIX}/notes`,
    {
      schema: {
        tags,
        summary: "Notes, pinned first, then by last change (no bodies; excerpt instead)",
        querystring: NoteListQuery,
        response: { 200: NotePage },
      },
    },
    async (request) => listNotes(deps.db, request.query),
  );
  app.post(
    `${API_PREFIX}/notes`,
    { schema: { tags, summary: "Write a note", body: CreateNote, response: { 201: Note } } },
    async (request, reply) => reply.status(201).send(createNote(deps, actorOf(request), request.body)),
  );
  app.get(
    `${API_PREFIX}/notes/:id`,
    { schema: { tags, params: IdParams, response: { 200: Note } } },
    async (request) => getNote(deps.db, request.params.id),
  );
  app.patch(
    `${API_PREFIX}/notes/:id`,
    {
      schema: {
        tags,
        summary: "Change a note (pinned true or false pins or unpins)",
        params: IdParams,
        body: UpdateNote,
        response: { 200: Note },
      },
    },
    async (request) => updateNote(deps, request.params.id, request.body),
  );
  app.delete(`${API_PREFIX}/notes/:id`, { schema: { tags, params: IdParams } }, async (request, reply) => {
    deleteNote(deps, request.params.id);
    return reply.status(204).send();
  });
}
