import { API_PREFIX, SearchQuery, SearchResult } from "@organizer/shared";
import { search } from "../services/search.ts";
import { type App, ctxOf, type Deps } from "./types.ts";

export function searchRoutes(app: App, deps: Deps): void {
  app.get(
    `${API_PREFIX}/search`,
    {
      schema: {
        tags: ["search"],
        summary: "Search todos, notes, comments and people (terms ANDed; #123 finds todo 123 first)",
        querystring: SearchQuery,
        response: { 200: SearchResult },
      },
    },
    async (request) => search(ctxOf(request, deps), request.query),
  );
}
