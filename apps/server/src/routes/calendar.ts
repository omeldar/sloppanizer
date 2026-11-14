import { API_PREFIX } from "@organizer/shared";
import { z } from "zod";
import type { AuthServices } from "../services/auth/index.ts";
import { createFeed, deleteFeed, feedStatus, renderFeed } from "../services/calendar.ts";
import { authOf, type App, type Deps } from "./types.ts";

const FeedStatus = z.strictObject({
  active: z.boolean(),
  createdAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
const CreatedFeed = z.strictObject({ url: z.string(), webcalUrl: z.string() });
const FeedParams = z.strictObject({ file: z.string().max(80) });

/** The planner as a calendar feed: managed by the browser session, read by calendar apps with the secret link. */
export function calendarRoutes(app: App, deps: Deps, auth: AuthServices): void {
  const { config, limiters } = auth;
  const tags = ["planner"];

  app.get(
    `${API_PREFIX}/calendar-feed`,
    {
      config: { access: "session" },
      schema: {
        tags,
        summary: "Whether the calendar feed is on (session only)",
        response: { 200: FeedStatus },
      },
    },
    async (request) => feedStatus(deps.db, authOf(request).accountId),
  );

  app.post(
    `${API_PREFIX}/calendar-feed`,
    {
      config: { access: "session", reauth: true },
      schema: {
        tags,
        summary: "Turn on the calendar feed or replace its secret link (the old one stops working)",
        response: { 201: CreatedFeed },
      },
    },
    async (request, reply) => {
      const raw = createFeed(deps.db, deps.clock, authOf(request).accountId);
      const origin = config.publicUrl ?? `${request.protocol}://${request.host}`;
      const url = `${origin}${API_PREFIX}/calendar/${raw}.ics`;
      return reply.status(201).send({ url, webcalUrl: url.replace(/^https?:/, "webcal:") });
    },
  );

  app.delete(
    `${API_PREFIX}/calendar-feed`,
    { config: { access: "session" }, schema: { tags, summary: "Turn the calendar feed off" } },
    async (request, reply) => {
      deleteFeed(deps.db, authOf(request).accountId);
      return reply.status(204).send();
    },
  );

  app.get(
    `${API_PREFIX}/calendar/:file`,
    {
      config: { access: "public" },
      schema: {
        tags,
        summary: "The calendar feed (iCalendar) of a secret link",
        params: FeedParams,
        hide: true,
      },
    },
    async (request, reply) => {
      const verdict = limiters.calendarByIp.take(request.ip);
      if (!verdict.ok) {
        return reply
          .status(429)
          .header("retry-after", String(verdict.retryAfterSeconds))
          .type("text/plain")
          .send("Slow down.");
      }
      const raw = request.params.file.replace(/\.ics$/, "");
      const webOrigin = config.webDir !== null ? config.publicUrl : (config.webOrigins[0] ?? null);
      const ics = renderFeed(deps.db, deps.clock, raw, {
        fallbackTimeZone: deps.fallbackTimeZone,
        webOrigin,
      });
      if (ics === null) return reply.status(404).type("text/plain").send("No calendar here.");
      return reply
        .type("text/calendar; charset=utf-8")
        .header("cache-control", "private, max-age=300")
        .header("content-disposition", 'inline; filename="sloppanizer.ics"')
        .send(ics);
    },
  );
}
