import { API_PREFIX, CreateLabel, IdParams, Label, UpdateLabel } from "@organizer/shared";
import { z } from "zod";
import { createLabel, deleteLabel, listLabels, updateLabel } from "../services/labels.ts";
import { actorOf, type App, ctxOf, type Deps } from "./types.ts";

export function labelRoutes(app: App, deps: Deps): void {
  const tags = ["labels"];
  app.get(
    `${API_PREFIX}/labels`,
    { schema: { tags, summary: "All labels, scoped first", response: { 200: z.array(Label) } } },
    async (request) => listLabels(ctxOf(request, deps)),
  );
  app.post(
    `${API_PREFIX}/labels`,
    {
      schema: {
        tags,
        summary: 'Create a label ("scope::value" or plain)',
        body: CreateLabel,
        response: { 201: Label },
      },
    },
    async (request, reply) => reply.status(201).send(createLabel(ctxOf(request, deps), request.body)),
  );
  app.patch(
    `${API_PREFIX}/labels/:id`,
    {
      schema: {
        tags,
        summary: "Change a label; a rename into a used scope answers 409 unless onScopeConflict is replace",
        params: IdParams,
        body: UpdateLabel,
        response: { 200: Label },
      },
    },
    async (request) => updateLabel(ctxOf(request, deps), actorOf(request), request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/labels/:id`,
    { schema: { tags, summary: "Delete a label (removed from every todo)", params: IdParams } },
    async (request, reply) => {
      deleteLabel(ctxOf(request, deps), request.params.id);
      return reply.status(204).send();
    },
  );
}
