import type { Project } from "@organizer/shared";
import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import { Kbd } from "../components/ui.tsx";
import { HelpOverlay } from "../features/help/HelpOverlay.tsx";
import { Palette } from "../features/palette/Palette.tsx";
import { NewNoteDialog } from "../features/notes/NewNoteDialog.tsx";
import { NewPersonDialog } from "../features/people/NewPersonDialog.tsx";
import { NewProjectDialog } from "../features/projects/NewProjectDialog.tsx";
import { QuickAdd } from "../features/quickadd/QuickAdd.tsx";
import { type KeyBinding, useActiveBindings, useKeys } from "../keyboard/KeyboardProvider.tsx";
import { useProjects, useStats, useTodo } from "../lib/queries.ts";
import { useCommands } from "./commands.tsx";
import styles from "./Layout.module.css";
import { StatusBar } from "./StatusBar.tsx";

export function Layout() {
  const navigate = useNavigate();
  const commands = useCommands();
  const projects = useProjects();
  const activeBindings = useActiveBindings();
  const [helpBindings, setHelpBindings] = useState<KeyBinding[]>([]);

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
      run: () => commands.openQuickAdd(currentProjectDefaults()),
      label: "New todo",
      group: "Global",
    },
    {
      keys: "n",
      run: () => commands.openNewNote(currentProjectId(projects.data)),
      label: "New note",
      group: "Global",
    },
    { keys: "/", run: go("/search"), label: "Search page", group: "Global" },
    { keys: "g n", run: go("/"), label: "Go to Next up", group: "Go to" },
    { keys: "g i", run: go("/inbox"), label: "Go to Inbox", group: "Go to" },
    { keys: "g b", run: go("/board"), label: "Go to Board", group: "Go to" },
    { keys: "g w", run: go("/week"), label: "Go to Week", group: "Go to" },
    { keys: "g o", run: go("/notes"), label: "Go to Notes", group: "Go to" },
    { keys: "g l", run: go("/labels"), label: "Go to Labels", group: "Go to" },
    { keys: "g p", run: go("/people"), label: "Go to People", group: "Go to" },
    { keys: "g s", run: go("/settings"), label: "Go to Settings", group: "Go to" },
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

  return (
    <div className={styles.shell}>
      <Sidebar />
      <TopBar />
      <main className={styles.main} id="main">
        <Outlet />
      </main>
      <StatusBar />
      <QuickAdd />
      <NewNoteDialog />
      <NewPersonDialog />
      <Palette />
      <HelpOverlay bindings={helpBindings} />
    </div>
  );
}

function currentProjectSlug(): string | undefined {
  const slug = /^\/projects\/([^/]+)/.exec(window.location.pathname)?.[1];
  return slug ? decodeURIComponent(slug) : undefined;
}

/** New todos made on a project page start in that project. */
function currentProjectDefaults() {
  const slug = currentProjectSlug();
  return slug ? { projectSlug: slug } : {};
}

/** New notes made on a project page start in that project too. */
function currentProjectId(projects: readonly Project[] | undefined): number | null {
  const slug = currentProjectSlug();
  return projects?.find((p) => p.slug === slug)?.id ?? null;
}

function Sidebar() {
  const projects = useProjects();
  const stats = useStats();
  const [newProject, setNewProject] = useState(false);
  const active = (projects.data ?? []).filter((p) => p.archivedAt === null);

  return (
    <nav className={styles.sidebar} aria-label="Main">
      <Link to="/" className={styles.brand}>
        <BrandMark />
        <span>organizer</span>
      </Link>
      <ul className={styles.nav}>
        <NavItem to="/" label="Next up" keys="g n" exact />
        <NavItem to="/inbox" label="Inbox" count={stats.data?.inbox} keys="g i" />
        <NavItem to="/board" label="Board" keys="g b" />
        <NavItem to="/week" label="Week" keys="g w" />
        <NavItem to="/notes" label="Notes" keys="g o" />
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
          <li key={project.id}>
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
          </li>
        ))}
        {projects.isSuccess && active.length === 0 && (
          <li className={styles.navEmpty}>No projects yet. Use the plus to add one.</li>
        )}
      </ul>
      <ul className={[styles.nav, styles.navBottom].join(" ")}>
        <NavItem to="/labels" label="Labels" keys="g l" />
        <NavItem to="/people" label="People" keys="g p" />
        <NavItem to="/settings" label="Settings" keys="g s" />
      </ul>
      <NewProjectDialog open={newProject} onOpenChange={setNewProject} />
    </nav>
  );
}

function NavItem({
  to,
  label,
  count,
  keys,
  exact,
}: {
  to: string;
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
        <span className={styles.navLabel}>{label}</span>
        {count !== undefined && count > 0 && <span className={styles.count}>{count}</span>}
        <span className={styles.navKeys}>
          <Kbd keys={keys} subtle />
        </span>
      </Link>
    </li>
  );
}

function TopBar() {
  const commands = useCommands();
  return (
    <header className={styles.topbar}>
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
          onClick={() => commands.openQuickAdd(currentProjectDefaults())}
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

  let trail: { label: string; to?: string; mono?: boolean }[] = [];
  if (pathname === "/") trail = [{ label: "Next up" }];
  else if (pathname === "/inbox") trail = [{ label: "Inbox" }];
  else if (pathname === "/labels") trail = [{ label: "Labels" }];
  else if (pathname === "/board") trail = [{ label: "Board" }];
  else if (pathname === "/week") trail = [{ label: "Week" }];
  else if (pathname === "/search") trail = [{ label: "Search" }];
  else if (pathname === "/notes") trail = [{ label: "Notes" }];
  else if (pathname.startsWith("/notes/")) trail = [{ label: "Notes", to: "/notes" }, { label: "Note" }];
  else if (pathname === "/people") trail = [{ label: "People" }];
  else if (pathname.startsWith("/people/")) trail = [{ label: "People", to: "/people" }, { label: "Person" }];
  else if (pathname === "/settings") trail = [{ label: "Settings" }];
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

/** Three stacked strips, the newest one with the amber band. */
export function BrandMark() {
  return (
    <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true" className={styles.brandMark}>
      <rect x="1" y="2" width="16" height="3.6" rx="0.6" fill="currentColor" opacity="0.35" />
      <rect x="1" y="7.2" width="16" height="3.6" rx="0.6" fill="currentColor" opacity="0.6" />
      <rect x="1" y="12.4" width="16" height="3.6" rx="0.6" fill="currentColor" />
      <rect x="1" y="12.4" width="2.4" height="3.6" fill="var(--amber)" />
    </svg>
  );
}
