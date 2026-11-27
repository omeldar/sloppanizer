import type { Notification } from "@organizer/shared";
import { Link } from "@tanstack/react-router";
import { useState } from "react";
import { useCurrentAccount } from "../../app/account.tsx";
import { Popover } from "../../components/Popover.tsx";
import { relativeTime } from "../../lib/format.ts";
import { useMarkNotifications, useNotifications } from "../../lib/notifications.ts";
import { sharedTodoHref } from "../../lib/spaces.ts";
import styles from "./Notifications.module.css";

const WHAT: Record<Notification["kind"], string> = {
  assigned: "assigned it to you",
  mentioned: "mentioned you",
  commented: "commented",
  action_needed: "needs you to act",
};

/**
 * The bell in the top bar: unread count, and the newest notifications (assigned, mentioned, comments,
 * action needed). Opening one marks it read and goes to the todo (a shared one in its project's tab).
 */
export function NotificationBell() {
  const [open, setOpen] = useState(false);
  const list = useNotifications();
  const mark = useMarkNotifications();
  const account = useCurrentAccount();
  const unread = list.data?.unreadCount ?? 0;
  const items = list.data?.items ?? [];

  const read = (n: Notification) => {
    setOpen(false);
    if (n.readAt === null) mark.mutate({ ids: [n.id] });
  };

  return (
    <Popover
      open={open}
      onOpenChange={setOpen}
      align="end"
      className={styles.popover}
      trigger={
        <button
          type="button"
          className={styles.bell}
          aria-label={unread > 0 ? `Notifications, ${unread} unread` : "Notifications"}
        >
          <svg
            width="18"
            height="18"
            viewBox="0 0 20 20"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 8a5 5 0 0 1 10 0c0 4 1.5 5.5 2 6H3c.5-.5 2-2 2-6zM8 16.5a2 2 0 0 0 4 0" />
          </svg>
          {unread > 0 && <span className={styles.badge}>{unread > 99 ? "99+" : unread}</span>}
        </button>
      }
    >
      <div className={styles.panel} aria-label="Notifications" role="region">
        <div className={styles.head}>
          <span className={styles.title}>Notifications</span>
          {unread > 0 && (
            <button type="button" className={styles.markAll} onClick={() => mark.mutate({ all: true })}>
              Mark all read
            </button>
          )}
        </div>
        {items.length === 0 ? (
          <p className={styles.empty}>
            Nothing yet. You hear here when someone assigns you a shared todo, mentions you with
            @your-username, comments on a todo of yours or marks one "action needed".
          </p>
        ) : (
          <ul className={styles.list}>
            {items.map((n) => (
              <li key={n.id} data-unread={n.readAt === null || undefined} data-kind={n.kind}>
                <NotificationLink
                  notification={n}
                  username={account?.username ?? ""}
                  onOpen={() => read(n)}
                />
              </li>
            ))}
          </ul>
        )}
      </div>
    </Popover>
  );
}

function NotificationLink({
  notification: n,
  username,
  onOpen,
}: {
  notification: Notification;
  username: string;
  onOpen: () => void;
}) {
  const body = (
    <>
      <span className={styles.line}>
        <span className={styles.actor}>{n.actor}</span> {WHAT[n.kind]}
        <span className={styles.when}> · {relativeTime(n.createdAt)}</span>
      </span>
      <span className={styles.todo}>
        {n.space && <span className={styles.space}>{n.space.name}</span>}
        <span className={styles.todoTitle}>{n.todo.title}</span>
      </span>
      {n.excerpt && <span className={styles.excerpt}>{n.excerpt}</span>}
    </>
  );
  // A shared todo opens in its project's tab; an own one in this tab.
  if (n.space)
    return (
      <a className={styles.item} href={sharedTodoHref(username, n.space.id, n.todo.id)} onClick={onOpen}>
        {body}
      </a>
    );
  return (
    <Link className={styles.item} to="/todos/$id" params={{ id: String(n.todo.id) }} onClick={onOpen}>
      {body}
    </Link>
  );
}
