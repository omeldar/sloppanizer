import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import type { Project } from "@organizer/shared";
import { Menu } from "../components/Menu.tsx";
import { Kbd } from "../components/ui.tsx";
import { BrandMark } from "./BrandMark.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { HelpOverlay } from "../features/help/HelpOverlay.tsx";
import { Palette } from "../features/palette/Palette.tsx";
import { NewNoteDialog } from "../features/notes/NewNoteDialog.tsx";
import { NewPersonDialog } from "../features/people/NewPersonDialog.tsx";
import { EditProjectDialog } from "../features/projects/EditProjectDialog.tsx";
import { NewProjectDialog } from "../features/projects/NewProjectDialog.tsx";
import { QuickAdd } from "../features/quickadd/QuickAdd.tsx";
import { type KeyBinding, useActiveBindings, useKeyHold, useKeys } from "../keyboard/KeyboardProvider.tsx";
import { useProjects, useStats, useTodo } from "../lib/queries.ts";
import { useSignups } from "../lib/adminQueries.ts";
import { useMeeting } from "../lib/meetings.ts";
import { useCurrentAccount } from "./account.tsx";
import { AccountSwitcher } from "./AccountSwitcher.tsx";
import { useCommands } from "./commands.tsx";
import styles from "./Layout.module.css";
import { StatusBar } from "./StatusBar.tsx";
import { UpdateBanner } from "./UpdateBanner.tsx";

export function Layout() {
  const navigate = useNavigate();
  const isAdmin = useCurrentAccount()?.role === "admin";
  const commands = useCommands();
  const page = usePageProject();
  const activeBindings = useActiveBindings();
  const [helpBindings, setHelpBindings] = useState<KeyBinding[]>([]);
  // Phones: the sidebar is a drawer, open on the page it was opened on, so any navigation closes it.
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const [drawerOn, setDrawerOn] = useState<string | null>(null);
  const drawer = drawerOn === pathname;
  const setDrawer = (open: boolean) => setDrawerOn(open ? pathname : null);

  const go = (to: string) => () => void navigate({ to });
  const globalKeys: KeyBinding[] = [
    {
      keys: "mod+k",
      run: () => commands.openPalette(),
      label: "Search and commands",
      group: "Global",
      whileTyping: true,
    },
    {
      keys: "c",
      run: () => commands.openQuickAdd(page.quickAddDefaults()),
      label: "New todo",
      group: "Global",
    },
    {
      keys: "n",
      run: () => commands.openNewNote(page.projectId()),
      label: "New note",
      group: "Global",
    },
    { keys: "/", run: go("/search"), label: "Search page", group: "Global" },
    { keys: "g n", run: go("/"), label: "Go to Next up", group: "Go to" },
    { keys: "g i", run: go("/inbox"), label: "Go to Inbox", group: "Go to" },
    { keys: "g b", run: go("/board"), label: "Go to Board", group: "Go to" },
    { keys: "g w", run: go("/week"), label: "Go to Week", group: "Go to" },
    { keys: "g t", run: go("/planner"), label: "Go to Planner", group: "Go to" },
    { keys: "g m", run: go("/meetings"), label: "Go to Meetings", group: "Go to" },
    { keys: "g r", run: go("/recurring"), label: "Go to Recurring", group: "Go to" },
    { keys: "g c", run: go("/stats"), label: "Go to Statistics", group: "Go to" },
    { keys: "g o", run: go("/notes"), label: "Go to Notes", group: "Go to" },
    { keys: "g l", run: go("/labels"), label: "Go to Labels", group: "Go to" },
    { keys: "g p", run: go("/people"), label: "Go to People", group: "Go to" },
    { keys: "g s", run: go("/settings"), label: "Go to Settings", group: "Go to" },
    { keys: "g u", run: go("/account"), label: "Go to Account", group: "Go to" },
    ...(isAdmin ? [{ keys: "g a", run: go("/admin"), label: "Go to Admin", group: "Go to" }] : []),
    {
      keys: "?",
      run: () => {
        setHelpBindings(activeBindings());
        commands.openHelp();
      },
      label: "Show shortcuts",
      group: "Global",
    },
    {
      keys: "Escape",
      run: (event) => (event.target instanceof HTMLElement ? event.target.blur() : undefined),
      label: "Leave the text field (back to normal mode)",
      group: "Global",
      whileTyping: true,
    },
  ];
  useKeys(globalKeys);
  // Keys typed while the next page loads (its code or data) wait for it instead of getting lost.
  const loading = useRouterState({ select: (s) => s.isLoading });
  useKeyHold(loading);

  return (
    <div className={styles.shell}>
      <Sidebar open={drawer} />
      <div
        className={styles.scrim}
        data-open={drawer || undefined}
        onClick={() => setDrawer(false)}
        aria-hidden="true"
      />
      <TopBar onMenu={() => setDrawer(true)} />
      <UpdateBanner />
      <main className={styles.main} id="main">
        <Outlet />
      </main>
      <StatusBar />
      <TabBar onMore={() => setDrawer(true)} />
      <QuickAdd />
      <NewNoteDialog />
      <NewPersonDialog />
      <Palette />
      <HelpOverlay bindings={helpBindings} />
    </div>
  );
}

/** The project the current page is about: a project page, or the notes list filtered to one. */
export function pageProjectSlug(pathname: string, search: Record<string, unknown>): string | undefined {
  const slug = /^\/projects\/([^/]+)/.exec(pathname)?.[1];
  if (slug) return decodeURIComponent(slug);
  if (pathname.startsWith("/notes") && typeof search.project === "string" && search.project !== "none") {
    return search.project;
  }
  return undefined;
}

/** Quick add and new notes start in the page's project. */
function usePageProject() {
  const location = useRouterState({ select: (s) => s.location });
  const projects = useProjects();
  const slug = pageProjectSlug(location.pathname, location.search as Record<string, unknown>);
  return {
    quickAddDefaults: () => (slug && location.pathname.startsWith("/projects/") ? { projectSlug: slug } : {}),
    projectId: () => projects.data?.find((p) => p.slug === slug)?.id ?? null,
  };
}

function Sidebar({ open }: { open: boolean }) {
  const isAdmin = useCurrentAccount()?.role === "admin";
  const signups = useSignups(isAdmin);
  const projects = useProjects();
  const stats = useStats();
  const [newProject, setNewProject] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const setEditing = (project: Project) => setEditingId(project.id);
  const active = (projects.data ?? []).filter((p) => p.archivedAt === null);

  return (
    <nav className={styles.sidebar} data-open={open || undefined} aria-label="Main">
      <Link to="/" className={styles.brand}>
        <BrandMark />
        <span>Sloppanizer</span>
      </Link>
      <ul className={styles.nav}>
        <NavItem to="/" icon="next" label="Next up" keys="g n" exact />
        <NavItem to="/inbox" icon="inbox" label="Inbox" count={stats.data?.inbox} keys="g i" />
        <NavItem to="/board" icon="board" label="Board" keys="g b" />
        <NavItem to="/planner" icon="planner" label="Planner" keys="g t" />
        <NavItem to="/meetings" icon="meetings" label="Meetings" keys="g m" />
        <NavItem to="/recurring" icon="recurring" label="Recurring" keys="g r" />
        <NavItem to="/week" icon="week" label="Week" keys="g w" />
        <NavItem to="/notes" icon="notes" label="Notes" keys="g o" />
        <NavItem to="/stats" icon="stats" label="Statistics" keys="g c" />
      </ul>
      <div className={styles.sectionHead}>
        <span>Projects</span>
        <button
          type="button"
          className={styles.sectionAdd}
          onClick={() => setNewProject(true)}
          aria-label="New project"
          title="New project"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M5 0v10M0 5h10" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      <ul className={styles.nav}>
        {active.map((project) => (
          <li key={project.id} className={styles.projectItem}>
            <Link
              to="/projects/$slug"
              params={{ slug: project.slug }}
              className={styles.navLink}
              activeProps={{ "data-active": true } as Record<string, unknown>}
            >
              <span className={styles.swatch} style={{ "--swatch": project.color } as CSSProperties} />
              <span className={styles.navLabel}>{project.name}</span>
              <span className={styles.count}>{project.openCount}</span>
            </Link>
            <Menu
              label={`${project.name} menu`}
              items={[{ label: "Edit project", run: () => setEditing(project) }]}
              trigger={
                <button
                  type="button"
                  className={styles.navMore}
                  aria-label={`More for ${project.name}`}
                  title="More"
                >
                  <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                    <circle cx="2" cy="6" r="1.2" fill="currentColor" />
                    <circle cx="6" cy="6" r="1.2" fill="currentColor" />
                    <circle cx="10" cy="6" r="1.2" fill="currentColor" />
                  </svg>
                </button>
              }
            />
          </li>
        ))}
        {projects.isSuccess && active.length === 0 && (
          <li className={styles.navEmpty}>No projects yet. Use the plus to add one.</li>
        )}
      </ul>
      <ul className={[styles.nav, styles.navBottom].join(" ")}>
        <NavItem to="/labels" icon="labels" label="Labels" keys="g l" />
        <NavItem to="/people" icon="people" label="People" keys="g p" />
        <NavItem to="/settings" icon="settings" label="Settings" keys="g s" />
        {isAdmin && (
          <NavItem to="/admin" icon="admin" label="Admin" count={signups.data?.length} keys="g a" />
        )}
      </ul>
      <AccountSwitcher />
      <NewProjectDialog open={newProject} onOpenChange={setNewProject} />
      <EditProjectDialog
        project={projects.data?.find((p) => p.id === editingId) ?? null}
        onOpenChange={(on) => !on && setEditingId(null)}
      />
    </nav>
  );
}

function NavItem({
  to,
  icon,
  label,
  count,
  keys,
  exact,
}: {
  to: string;
  icon: IconName;
  label: string;
  count?: number;
  keys: string;
  exact?: boolean;
}) {
  return (
    <li>
      <Link
        to={to}
        className={styles.navLink}
        activeOptions={{ exact: exact ?? false }}
        activeProps={{ "data-active": true } as Record<string, unknown>}
      >
        <span className={styles.navIcon}>
          <Icon name={icon} />
        </span>
        <span className={styles.navLabel}>{label}</span>
        {count !== undefined && count > 0 && <span className={styles.count}>{count}</span>}
        <span className={styles.navKeys}>
          <Kbd keys={keys} subtle />
        </span>
      </Link>
    </li>
  );
}

function TopBar({ onMenu }: { onMenu: () => void }) {
  const commands = useCommands();
  const page = usePageProject();
  return (
    <header className={styles.topbar}>
      <button type="button" className={styles.menuButton} onClick={onMenu} aria-label="Open the menu">
        <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path
            d="M2 4.5h14M2 9h14M2 13.5h14"
            stroke="currentColor"
            strokeWidth="1.6"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <Breadcrumb />
      <div className={styles.topActions}>
        <button type="button" className={styles.search} onClick={() => commands.openPalette()}>
          <svg width="13" height="13" viewBox="0 0 13 13" aria-hidden="true">
            <circle cx="5.5" cy="5.5" r="4.25" fill="none" stroke="currentColor" strokeWidth="1.4" />
            <path d="M8.7 8.7L12 12" stroke="currentColor" strokeWidth="1.4" />
          </svg>
          <span>Search and commands</span>
          <Kbd keys="ctrl+k" />
        </button>
        <button
          type="button"
          className={styles.newTodo}
          onClick={() => commands.openQuickAdd(page.quickAddDefaults())}
        >
          New todo
          <Kbd keys="c" subtle />
        </button>
      </div>
    </header>
  );
}

function Breadcrumb() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const projects = useProjects();
  const todoId = Number(/^\/todos\/(\d+)/.exec(pathname)?.[1] ?? Number.NaN);
  const todo = useTodo(todoId);
  const meetingId = Number(/^\/meetings\/(\d+)/.exec(pathname)?.[1] ?? Number.NaN);
  // Phones show no page title, so the trail names the meeting.
  const meeting = useMeeting(meetingId);

  let trail: { label: string; to?: string; mono?: boolean }[] = [];
  if (pathname === "/") trail = [{ label: "Next up" }];
  else if (pathname === "/inbox") trail = [{ label: "Inbox" }];
  else if (pathname === "/labels") trail = [{ label: "Labels" }];
  else if (pathname === "/board") trail = [{ label: "Board" }];
  else if (pathname === "/week") trail = [{ label: "Week" }];
  else if (pathname === "/planner") trail = [{ label: "Planner" }];
  else if (pathname === "/meetings") trail = [{ label: "Meetings" }];
  else if (pathname === "/recurring") trail = [{ label: "Recurring" }];
  else if (pathname === "/stats") trail = [{ label: "Statistics" }];
  else if (pathname.startsWith("/meetings/"))
    trail = [{ label: "Meetings", to: "/meetings" }, { label: meeting.data?.name ?? "Meeting" }];
  else if (pathname === "/search") trail = [{ label: "Search" }];
  else if (pathname === "/notes") trail = [{ label: "Notes" }];
  else if (pathname.startsWith("/notes/")) trail = [{ label: "Notes", to: "/notes" }, { label: "Note" }];
  else if (pathname === "/people") trail = [{ label: "People" }];
  else if (pathname === "/people/stats")
    trail = [{ label: "People", to: "/people" }, { label: "Statistics" }];
  else if (pathname.startsWith("/people/")) trail = [{ label: "People", to: "/people" }, { label: "Person" }];
  else if (pathname === "/settings") trail = [{ label: "Settings" }];
  else if (pathname === "/account") trail = [{ label: "Account" }];
  else if (pathname === "/admin") trail = [{ label: "Admin" }];
  else if (pathname === "/settings/tokens")
    trail = [{ label: "Settings", to: "/settings" }, { label: "API tokens" }];
  else if (pathname.startsWith("/projects/")) {
    const slug = decodeURIComponent(pathname.slice("/projects/".length));
    trail = [{ label: "Projects" }, { label: projects.data?.find((p) => p.slug === slug)?.name ?? slug }];
  } else if (Number.isInteger(todoId)) {
    const project = todo.data?.project;
    trail = [
      project ? { label: project.name, to: `/projects/${project.slug}` } : { label: "Inbox", to: "/inbox" },
      { label: `#${todoId}`, mono: true },
    ];
  }

  return (
    <ol className={styles.breadcrumb} aria-label="Breadcrumb">
      {trail.map((part, i) => (
        <li key={`${part.label}-${i === trail.length - 1}`} data-mono={part.mono || undefined}>
          {part.to ? (
            <Link to={part.to}>{part.label}</Link>
          ) : (
            <span aria-current={i === trail.length - 1 ? "page" : undefined}>{part.label}</span>
          )}
        </li>
      ))}
    </ol>
  );
}

/** Phones: the main places at the thumb, new todo in the middle, everything else in the drawer. */
function TabBar({ onMore }: { onMore: () => void }) {
  const commands = useCommands();
  const page = usePageProject();
  const stats = useStats();
  const inbox = stats.data?.inbox ?? 0;
  return (
    <nav className={styles.tabbar} aria-label="Main places">
      <TabLink to="/" label="Next up" exact icon="next" />
      <TabLink to="/inbox" label="Inbox" badge={inbox > 0 ? inbox : undefined} icon="inbox" />
      <button
        type="button"
        className={styles.tabAdd}
        onClick={() => commands.openQuickAdd(page.quickAddDefaults())}
        aria-label="New todo"
      >
        <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden="true">
          <path d="M11 4v14M4 11h14" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" />
        </svg>
      </button>
      <TabLink to="/planner" label="Planner" icon="planner" />
      <button type="button" className={styles.tab} onClick={onMore}>
        <Icon name="more" size={22} />
        <span>More</span>
      </button>
    </nav>
  );
}

function TabLink({
  to,
  label,
  icon,
  badge,
  exact,
}: {
  to: string;
  label: string;
  icon: IconName;
  badge?: number | undefined;
  exact?: boolean;
}) {
  return (
    <Link
      to={to}
      className={styles.tab}
      activeOptions={{ exact: exact ?? false }}
      activeProps={{ "data-active": true } as Record<string, unknown>}
    >
      <Icon name={icon} size={22} />
      <span>{label}</span>
      {badge !== undefined && <span className={styles.tabBadge}>{badge}</span>}
    </Link>
  );
}
