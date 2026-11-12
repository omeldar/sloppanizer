import {
  API_PREFIX,
  BulkUpdate,
  BulkUpdateResult,
  CreateTodo,
  IdParams,
  NextQuery,
  NextUp,
  Stats,
  Todo,
  TodoListQuery,
  TodoPage,
  UpdateTodo,
} from "@organizer/shared";
import { stats } from "../services/stats.ts";
import {
  bulkUpdate,
  createTodo,
  deleteTodo,
  getTodo,
  listTodos,
  nextUp,
  updateTodo,
} from "../services/todos.ts";
import { actorOf, type App, type Deps } from "./types.ts";

export function todoRoutes(app: App, deps: Deps): void {
  const tags = ["todos"];
  app.get(
    `${API_PREFIX}/todos`,
    {
      schema: {
        tags,
        summary: "List todos (filters, sort, paging)",
        querystring: TodoListQuery,
        response: { 200: TodoPage },
      },
    },
    async (request) => listTodos(deps, request.query),
  );
  app.post(
    `${API_PREFIX}/todos`,
    { schema: { tags, summary: "Create a todo", body: CreateTodo, response: { 201: Todo } } },
    async (request, reply) => reply.status(201).send(createTodo(deps, actorOf(request), request.body)),
  );
  app.post(
    `${API_PREFIX}/todos/bulk`,
    {
      schema: {
        tags,
        summary: "Apply one patch to many todos (all or nothing)",
        body: BulkUpdate,
        response: { 200: BulkUpdateResult },
      },
    },
    async (request) => ({
      updated: bulkUpdate(deps, actorOf(request), request.body.ids, request.body.patch),
    }),
  );
  app.get(
    `${API_PREFIX}/todos/:id`,
    { schema: { tags, params: IdParams, response: { 200: Todo } } },
    async (request) => getTodo(deps.db, request.params.id),
  );
  app.patch(
    `${API_PREFIX}/todos/:id`,
    {
      schema: {
        tags,
        summary: "Change a todo (labels: full set, or addLabels/removeLabels)",
        params: IdParams,
        body: UpdateTodo,
        response: { 200: Todo },
      },
    },
    async (request) => updateTodo(deps, actorOf(request), request.params.id, request.body),
  );
  app.delete(`${API_PREFIX}/todos/:id`, { schema: { tags, params: IdParams } }, async (request, reply) => {
    deleteTodo(deps, actorOf(request), request.params.id);
    return reply.status(204).send();
  });
  app.get(
    `${API_PREFIX}/next`,
    {
      schema: {
        tags: ["next up"],
        summary: "Ranked todos to work on next",
        querystring: NextQuery,
        response: { 200: NextUp },
      },
    },
    async (request) => nextUp(deps, request.query),
  );
  app.get(
    `${API_PREFIX}/stats`,
    { schema: { tags: ["next up"], summary: "Counters for the status bar", response: { 200: Stats } } },
    async () => stats(deps),
  );
}
