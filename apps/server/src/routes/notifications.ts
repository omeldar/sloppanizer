import { API_PREFIX, MarkNotifications, NotificationList, NotificationQuery } from "@organizer/shared";
import { listNotifications, markNotifications } from "../services/notifications.ts";
import { type App, authOf, type Deps } from "./types.ts";

/**
 * The caller's own notifications (never inside a shared project: they gather what happened in all of
 * them). A read token may list them, a write token mark them read.
 */
export function notificationRoutes(app: App, deps: Deps): void {
  const tags = ["notifications"];
  app.get(
    `${API_PREFIX}/notifications`,
    {
      schema: {
        tags,
        summary: "Your notifications, newest first, with the unread count",
        querystring: NotificationQuery,
        response: { 200: NotificationList },
      },
    },
    async (request) => listNotifications(deps, authOf(request).account.id, request.query),
  );
  app.post(
    `${API_PREFIX}/notifications/read`,
    {
      schema: {
        tags,
        summary: "Mark notifications read (ids or all), or unread again with read: false",
        body: MarkNotifications,
        response: { 200: NotificationList },
      },
    },
    async (request) => {
      const userId = authOf(request).account.id;
      markNotifications(deps, userId, request.body);
      return listNotifications(deps, userId, { limit: 30 });
    },
  );
}
