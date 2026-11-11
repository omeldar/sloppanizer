import { API_PREFIX, CreateProject, IdParams, Project, UpdateProject } from "@organizer/shared";
import { z } from "zod";
import {
  createProject,
  deleteProject,
  getProject,
  listProjects,
  updateProject,
} from "../services/projects.ts";
import { actorOf, type App, type Deps } from "./types.ts";

export function projectRoutes(app: App, deps: Deps): void {
  const tags = ["projects"];
  app.get(
    `${API_PREFIX}/projects`,
    { schema: { tags, summary: "All projects (archived included)", response: { 200: z.array(Project) } } },
    async () => listProjects(deps.db),
  );
  app.post(
    `${API_PREFIX}/projects`,
    { schema: { tags, summary: "Create a project", body: CreateProject, response: { 201: Project } } },
    async (request, reply) => reply.status(201).send(createProject(deps, request.body)),
  );
  app.get(
    `${API_PREFIX}/projects/:id`,
    { schema: { tags, params: IdParams, response: { 200: Project } } },
    async (request) => getProject(deps.db, request.params.id),
  );
  app.patch(
    `${API_PREFIX}/projects/:id`,
    { schema: { tags, params: IdParams, body: UpdateProject, response: { 200: Project } } },
    async (request) => updateProject(deps, request.params.id, request.body),
  );
  app.delete(
    `${API_PREFIX}/projects/:id`,
    { schema: { tags, summary: "Delete a project; its todos move to the Inbox", params: IdParams } },
    async (request, reply) => {
      deleteProject(deps, actorOf(request), request.params.id);
      return reply.status(204).send();
    },
  );
}
