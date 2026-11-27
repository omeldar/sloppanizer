import {
  API_PREFIX,
  CreatedDrawHandoff,
  DRAW_TOKEN_HEADER,
  DrawHandoff,
  DrawingList,
  IdParams,
  MAX_DRAWING_BYTES,
  PhoneDrawHandoff,
  RecentDrawingsQuery,
} from "@organizer/shared";
import type { FastifyRequest } from "fastify";
import { enforce } from "../http/rate-limit.ts";
import type { AuthServices } from "../services/auth/index.ts";
import {
  cancelHandoff,
  createHandoff,
  handoffStatus,
  phoneHandoff,
  receiveDrawing,
  recentDrawings,
} from "../services/drawings.ts";
import { actorOf, type App, authOf, ctxOf, type Deps } from "./types.ts";

/** The user acting (the member inside a shared project), who alone may see their hand-offs. */
const creatorOf = (request: FastifyRequest): number => {
  const auth = authOf(request);
  return auth.space?.memberId ?? auth.account.id;
};

/** The token header (one value), never the URL: URLs are logged, this header is redacted. */
const tokenOf = (request: FastifyRequest): string | undefined => {
  const value = request.headers[DRAW_TOKEN_HEADER];
  return Array.isArray(value) ? value[0] : value;
};

export function drawingRoutes(app: App, deps: Deps, auth: AuthServices): void {
  const tags = ["drawings"];
  const { limiters } = auth;

  app.get(
    `${API_PREFIX}/drawings`,
    {
      schema: {
        tags,
        summary: "Recent drawings of the account (PNG attachments named drawing-….png), newest first",
        querystring: RecentDrawingsQuery,
        response: { 200: DrawingList },
      },
    },
    async (request) => ({ items: recentDrawings(ctxOf(request, deps), request.query.limit ?? 12) }),
  );

  app.post(
    `${API_PREFIX}/drawings/handoffs`,
    {
      config: { access: "session" },
      schema: {
        tags,
        summary:
          "Draw on your phone: a single-use token (10 minutes) that lets a phone send one drawing here",
        response: { 201: CreatedDrawHandoff },
      },
    },
    async (request, reply) => {
      const creator = creatorOf(request);
      enforce(
        limiters.drawHandoffsByUser.take(String(creator)),
        "Too many phone links in a short time. Wait a few minutes.",
      );
      return reply.status(201).send(createHandoff(ctxOf(request, deps), creator, actorOf(request)));
    },
  );

  app.get(
    `${API_PREFIX}/drawings/handoffs/:id`,
    {
      config: { access: "session" },
      schema: {
        tags,
        summary: "Whether the phone sent its drawing yet",
        params: IdParams,
        response: { 200: DrawHandoff },
      },
    },
    async (request) => handoffStatus(ctxOf(request, deps), creatorOf(request), request.params.id),
  );

  app.delete(
    `${API_PREFIX}/drawings/handoffs/:id`,
    {
      config: { access: "session" },
      schema: { tags, summary: "End a phone link now", params: IdParams },
    },
    async (request, reply) => {
      cancelHandoff(ctxOf(request, deps), creatorOf(request), request.params.id);
      return reply.status(204).send();
    },
  );

  /** The phone's calls carry no session, only the token in its header: limited per IP (429 with Retry-After). */
  const limitPhone = (request: FastifyRequest) => enforce(limiters.drawPhoneByIp.take(request.ip));

  app.get(
    `${API_PREFIX}/draw-handoff`,
    {
      config: { access: "public" },
      schema: {
        tags,
        summary: `The phone's link: whether it still works (token in the ${DRAW_TOKEN_HEADER} header)`,
        response: { 200: PhoneDrawHandoff },
      },
    },
    async (request) => {
      limitPhone(request);
      return phoneHandoff(deps.db, deps.clock, tokenOf(request));
    },
  );

  app.register(async (scope: App) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "buffer" }, (_request, body, done) => done(null, body));
    scope.post(
      `${API_PREFIX}/draw-handoff`,
      {
        bodyLimit: MAX_DRAWING_BYTES,
        config: { access: "public", tooLargeMessage: "Drawings can be up to 10 MB." },
        schema: {
          tags,
          summary: `The phone sends its drawing: the PNG as body, the token in the ${DRAW_TOKEN_HEADER} header`,
        },
      },
      async (request, reply) => {
        limitPhone(request);
        const body = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
        receiveDrawing(deps, tokenOf(request), body);
        return reply.status(204).send();
      },
    );
  });
}
