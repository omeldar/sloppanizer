import { API_PREFIX, CreateLabel, IdParams, Label, UpdateLabel } from "@organizer/shared";
import { z } from "zod";
import { createLabel, deleteLabel, listLabels, updateLabel } from "../services/labels.ts";
import type { App, Deps } from "./types.ts";

export function labelRoutes(app: App, deps: Deps): void {
  const tags = ["labels"];
  app.get(
    `${API_PREFIX}/labels`,
    { schema: { tags, summary: "All labels, scoped first", response: { 200: z.array(Label) } } },
    async () => listLabels(deps.db),
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
    async (request, reply) => reply.status(201).send(createLabel(deps, request.body)),
  );
  app.patch(
    `${API_PREFIX}/labels/:id`,
    { schema: { tags, params: IdParams, body: UpdateLabel, response: { 200: Label } } },
    async (request) => updateLabel(deps, request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/labels/:id`,
    { schema: { tags, summary: "Delete a label (removed from every todo)", params: IdParams } },
    async (request, reply) => {
      deleteLabel(deps, request.params.id);
      return reply.status(204).send();
    },
  );
}
