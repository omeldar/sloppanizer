import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { Button } from "../../components/ui.tsx";
import { api, apiVoid, errorMessage } from "../../lib/api.ts";
import { relativeTime } from "../../lib/format.ts";
import styles from "./Settings.module.css";

const FeedStatus = z.object({
  active: z.boolean(),
  createdAt: z.string().nullable(),
  lastUsedAt: z.string().nullable(),
});
const CreatedFeed = z.object({ url: z.string(), webcalUrl: z.string() });
const KEY = ["calendarFeed"] as const;

/** The planner as a calendar subscription: a secret link, shown once, replaced or turned off here. */
export function CalendarFeedSection() {
  const client = useQueryClient();
  const toast = useToast();
  const status = useQuery({ queryKey: KEY, queryFn: () => api(FeedStatus, "/calendar-feed") });
  const [created, setCreated] = useState<z.infer<typeof CreatedFeed> | null>(null);
  const create = useMutation({
    mutationFn: () => api(CreatedFeed, "/calendar-feed", { method: "POST" }),
    onSuccess: (feed) => {
      setCreated(feed);
      return client.invalidateQueries({ queryKey: KEY });
    },
    onError: (error) => toast.show({ tone: "error", message: errorMessage(error) }),
  });
  const remove = useMutation({
    mutationFn: () => apiVoid("/calendar-feed", { method: "DELETE" }),
    onSuccess: () => {
      setCreated(null);
      return client.invalidateQueries({ queryKey: KEY });
    },
  });
  const copy = (text: string) =>
    void navigator.clipboard
      .writeText(text)
      .then(() => toast.show({ message: "Copied the calendar link" }))
      .catch(() => toast.show({ tone: "error", message: "Could not copy. Select the link and copy it." }));

  const active = status.data?.active ?? false;
  return (
    <section className={styles.section} aria-labelledby="calendar-heading">
      <h2 className={styles.heading} id="calendar-heading">
        Calendar feed
      </h2>
      <p className={styles.text}>
        See the planner&apos;s time blocks in Google Calendar, Apple Calendar or Outlook: subscribe to a
        secret link. Anyone with the link can read the titles of your planned time, so keep it to yourself.
      </p>
      {created && (
        <div className={styles.feedBox}>
          <p className={styles.text}>Copy it now; it is not shown again.</p>
          <code className={styles.feedUrl}>{created.url}</code>
          <div className={styles.exportRow}>
            <Button variant="primary" onClick={() => copy(created.url)}>
              Copy link
            </Button>
            <a className={styles.feedOpen} href={created.webcalUrl}>
              Open in calendar app
            </a>
          </div>
          <p className={styles.note}>
            Google Calendar: Other calendars, From URL. iPhone: Settings, Calendar, Accounts, Add subscribed
            calendar.
          </p>
        </div>
      )}
      <div className={styles.exportRow}>
        {active ? (
          <>
            <span className={styles.note}>
              On
              {status.data?.lastUsedAt
                ? `, last read ${relativeTime(status.data.lastUsedAt)}`
                : ", not read yet"}
              .
            </span>
            <Button onClick={() => create.mutate()} disabled={create.isPending}>
              New link
            </Button>
            <Button variant="ghost" onClick={() => remove.mutate()} disabled={remove.isPending}>
              Turn off
            </Button>
          </>
        ) : (
          <Button
            variant="primary"
            onClick={() => create.mutate()}
            disabled={create.isPending || status.isPending}
          >
            Create a calendar link
          </Button>
        )}
      </div>
      <p className={styles.note} role="note">
        Changes do not show up right away: depending on your calendar app it reads the link only every 8 to 12
        hours, some (like Google Calendar) only once a day. The planner here is always up to date.
      </p>
    </section>
  );
}
