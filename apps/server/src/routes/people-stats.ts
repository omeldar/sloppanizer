import {
  API_PREFIX,
  IdParams,
  PeopleStats,
  PeopleStatsQuery,
  PersonStatDetail,
  PersonStatsQuery,
  WorkStats,
  WorkStatsQuery,
} from "@organizer/shared";
import { peopleStats, personStats } from "../services/people-stats.ts";
import { workStats } from "../services/work-stats.ts";
import { type App, ctxOf, type Deps } from "./types.ts";

export function peopleStatsRoutes(app: App, deps: Deps): void {
  const tags = ["people"];
  app.get(
    `${API_PREFIX}/stats/people`,
    {
      schema: {
        tags,
        summary: "Per-person numbers: requested, open, done, how long they took, contact counts",
        querystring: PeopleStatsQuery,
        response: { 200: PeopleStats },
      },
    },
    async (request) => peopleStats(ctxOf(request, deps), request.query),
  );
  app.get(
    `${API_PREFIX}/stats/people/:id`,
    {
      schema: {
        tags,
        summary: "One person's numbers with the last 12 months",
        params: IdParams,
        querystring: PersonStatsQuery,
        response: { 200: PersonStatDetail },
      },
    },
    async (request) => personStats(ctxOf(request, deps), request.params.id, request.query),
  );
  app.get(
    `${API_PREFIX}/stats/overview`,
    {
      schema: {
        tags: ["stats"],
        summary:
          "Worked time (planned time that has happened), todos created and done, per project, requester, week, day and hour",
        querystring: WorkStatsQuery,
        response: { 200: WorkStats },
      },
    },
    async (request) => workStats(ctxOf(request, deps), request.query),
  );
}
