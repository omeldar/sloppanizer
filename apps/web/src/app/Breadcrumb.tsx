import { Link, useRouterState } from "@tanstack/react-router";
import type { Project, Todo } from "@organizer/shared";
import { currentSpace } from "../lib/api.ts";
import { accountBase } from "../lib/entry.ts";
import { useMeeting } from "../lib/meetings.ts";
import { useProjects, useTodo } from "../lib/queries.ts";
import { useCurrentAccount } from "./account.tsx";
import styles from "./Layout.module.css";

/**
 * One step of the trail. `to` is a path in this tab's app (a router link); `href` leaves it (a shared
 * project's tab going back to the account's own todos is a full page load). The last step is the page.
 */
export interface Crumb {
  label: string;
  to?: string;
  href?: string;
  mono?: boolean;
}

interface TrailContext {
  projects: readonly Pick<Project, "slug" | "name">[] | undefined;
  todo: Pick<Todo, "project" | "parent"> | undefined;
  meetingName: string | undefined;
  /** Where "My todos" goes: "/" in the account's own tab, the account's address in a shared project's tab. */
  home: Crumb | null;
}

/** The trail for a path: every step but the last links somewhere (S5#8). */
export function breadcrumbTrail(pathname: string, context: TrailContext): Crumb[] {
  const single: Record<string, string> = {
    "/": "Next up",
    "/inbox": "Inbox",
    "/labels": "Labels",
    "/board": "Board",
    "/week": "Week",
    "/planner": "Planner",
    "/meetings": "Meetings",
    "/recurring": "Recurring",
    "/stats": "Statistics",
    "/search": "Search",
    "/notes": "Notes",
    "/people": "People",
    "/settings": "Settings",
    "/account": "Account",
    "/admin": "Admin",
  };
  const page = single[pathname];
  if (page) return [{ label: page }];
  if (pathname.startsWith("/meetings/"))
    return [{ label: "Meetings", to: "/meetings" }, { label: context.meetingName ?? "Meeting" }];
  if (pathname.startsWith("/notes/")) return [{ label: "Notes", to: "/notes" }, { label: "Note" }];
  if (pathname === "/people/stats") return [{ label: "People", to: "/people" }, { label: "Statistics" }];
  if (pathname.startsWith("/people/")) return [{ label: "People", to: "/people" }, { label: "Person" }];
  if (pathname === "/settings/tokens")
    return [{ label: "Settings", to: "/settings" }, { label: "API tokens" }];
  if (pathname === "/settings/files") return [{ label: "Settings", to: "/settings" }, { label: "Files" }];
  if (pathname.startsWith("/projects/")) {
    const slug = decodeURIComponent(pathname.slice("/projects/".length));
    const name = context.projects?.find((p) => p.slug === slug)?.name ?? slug;
    return [...(context.home ? [context.home] : []), { label: name }];
  }
  const todoId = /^\/todos\/(\d+)/.exec(pathname)?.[1];
  if (todoId) {
    const project = context.todo?.project;
    const parent = context.todo?.parent;
    return [
      project ? { label: project.name, to: `/projects/${project.slug}` } : { label: "Inbox", to: "/inbox" },
      ...(parent ? [{ label: `#${parent.id}`, to: `/todos/${parent.id}`, mono: true }] : []),
      { label: `#${todoId}`, mono: true },
    ];
  }
  return [];
}

export function Breadcrumb() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const projects = useProjects();
  const todoId = Number(/^\/todos\/(\d+)/.exec(pathname)?.[1] ?? Number.NaN);
  const todo = useTodo(todoId);
  const meetingId = Number(/^\/meetings\/(\d+)/.exec(pathname)?.[1] ?? Number.NaN);
  // Phones show no page title, so the trail names the meeting.
  const meeting = useMeeting(meetingId);
  const account = useCurrentAccount();
  const inSpace = currentSpace() !== null;
  const home: Crumb | null = !inSpace
    ? { label: "My todos", to: "/" }
    : account
      ? { label: "My todos", href: `${accountBase(account.username)}/` }
      : null;

  const trail = breadcrumbTrail(pathname, {
    projects: projects.data,
    todo: todo.data,
    meetingName: meeting.data?.name,
    home,
  });

  return (
    <ol className={styles.breadcrumb} aria-label="Breadcrumb">
      {trail.map((part, i) => {
        const last = i === trail.length - 1;
        return (
          <li key={`${part.label}-${last}`} data-mono={part.mono || undefined}>
            {last ? (
              <span aria-current="page">{part.label}</span>
            ) : part.href ? (
              <a href={part.href}>{part.label}</a>
            ) : part.to ? (
              <Link to={part.to}>{part.label}</Link>
            ) : (
              <span>{part.label}</span>
            )}
          </li>
        );
      })}
    </ol>
  );
}
