import { type MarkNotificationsInput, NotificationList } from "@organizer/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "./api.ts";

/** The bell's list: your own, whichever tab is open (the API path is personal, see api.ts). */
export const notificationKeys = { all: ["notifications"] as const };

/** Newest first with the unread count; checked again every minute and when the window gets focus. */
export const useNotifications = () =>
  useQuery({
    queryKey: notificationKeys.all,
    queryFn: () => api(NotificationList, "/notifications", { query: { limit: 30 } }),
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

export function useMarkNotifications() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: MarkNotificationsInput) =>
      api(NotificationList, "/notifications/read", { method: "POST", body: input }),
    onSuccess: (list) => client.setQueryData(notificationKeys.all, list),
  });
}
