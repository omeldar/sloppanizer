import { Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import { type CSSProperties, useState } from "react";
import type { Project, Space } from "@organizer/shared";
import { Menu } from "../components/Menu.tsx";
import { Kbd } from "../components/ui.tsx";
import { BrandMark } from "./BrandMark.tsx";
import { Breadcrumb } from "./Breadcrumb.tsx";
import { Icon, type IconName } from "./icons.tsx";
import { HelpOverlay } from "../features/help/HelpOverlay.tsx";
import { Palette } from "../features/palette/Palette.tsx";
import { NewNoteDialog } from "../features/notes/NewNoteDialog.tsx";
import { NewPersonDialog } from "../features/people/NewPersonDialog.tsx";
import { EditProjectDialog } from "../features/projects/EditProjectDialog.tsx";
import { NewProjectDialog } from "../features/projects/NewProjectDialog.tsx";
import { QuickAdd } from "../features/quickadd/QuickAdd.tsx";
import { FeedbackDialog } from "../features/spaces/FeedbackDialog.tsx";
import { NewSpaceDialog, SpaceDialog } from "../features/spaces/SpaceDialogs.tsx";
import { currentSpace } from "../lib/api.ts";
import { accountBase } from "../lib/entry.ts";
import { spaceHref, useCurrentSpace, useSpaces } from "../lib/spaces.ts";
import { type KeyBinding, useActiveBindings, useKeyHold, useKeys } from "../keyboard/KeyboardProvider.tsx";
import { useProjects, useStats } from "../lib/queries.ts";
import { useSignups } from "../lib/adminQueries.ts";
import { useCurrentAccount } from "./account.tsx";
import { AccountSwitcher } from "./AccountSwitcher.tsx";
import { useCommands } from "./commands.tsx";
import styles from "./Layout.module.css";
import { StatusBar } from "./StatusBar.tsx";
import { MoveSignInBanner } from "./MoveSignIn.tsx";
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
  const inSpace = currentSpace() !== null;
  const allKeys: KeyBinding[] = [
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
  // Meetings, settings, account and admin are personal: a shared project has none of them.
  const personalOnly = new Set(["g m", "g s", "g u", "g a"]);
  const globalKeys = inSpace ? allKeys.filter((k) => !personalOnly.has(k.keys)) : allKeys;
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
      <div className={styles.banners}>
        <UpdateBanner />
        {!inSpace && <MoveSignInBanner />}
      </div>
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
      <FeedbackDialog />
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
  const inSpace = currentSpace() !== null;
  const commands = useCommands();
  const signups = useSignups(isAdmin && !inSpace);
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
      {inSpace && <SpaceBanner />}
      <ul className={styles.nav}>
        <NavItem to="/" icon="next" label="Next up" keys="g n" exact />
        <NavItem to="/inbox" icon="inbox" label="Inbox" count={stats.data?.inbox} keys="g i" />
        <NavItem to="/board" icon="board" label="Board" keys="g b" />
        <NavItem to="/planner" icon="planner" label="Planner" keys="g t" />
        {!inSpace && <NavItem to="/meetings" icon="meetings" label="Meetings" keys="g m" />}
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
      {!inSpace && <SharedSection />}
      <ul className={[styles.nav, styles.navBottom].join(" ")}>
        <NavItem to="/labels" icon="labels" label="Labels" keys="g l" />
        <NavItem to="/people" icon="people" label="People" keys="g p" />
        {!inSpace && <NavItem to="/settings" icon="settings" label="Settings" keys="g s" />}
        <li>
          <button type="button" className={styles.navLink} onClick={() => commands.openFeedback("bug")}>
            <span className={styles.navIcon}>
              <Icon name="feedback" />
            </span>
            <span className={styles.navLabel}>Feedback</span>
          </button>
        </li>
        {isAdmin && !inSpace && (
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

/** Inside a shared project: which one, and the way back to your own todos. */
function SpaceBanner() {
  const space = useCurrentSpace();
  const account = useCurrentAccount();
  return (
    <div className={styles.spaceBanner}>
      <span className={styles.spaceKicker}>Shared project</span>
      <span className={styles.spaceName}>
        <span
          className={styles.swatch}
          style={{ "--swatch": space.data?.color ?? "#8B95A5" } as CSSProperties}
        />
        {space.data?.name ?? (space.isError ? "Not available" : "Loading")}
      </span>
      {space.data && (
        <span className={styles.spaceMembers}>
          {space.data.members.length} {space.data.members.length === 1 ? "member" : "members"}
        </span>
      )}
      {account && (
        <a className={styles.spaceBack} href={`${accountBase(account.username)}/`}>
          Back to my todos
        </a>
      )}
    </div>
  );
}

/** Shared projects you are in (the Sloppanizer project for admins), each opening in its own scope. */
function SharedSection() {
  const spaces = useSpaces();
  const account = useCurrentAccount();
  const [creating, setCreating] = useState(false);
  const [managingId, setManagingId] = useState<number | null>(null);
  const list = spaces.data ?? [];
  const managing: Space | null = list.find((s) => s.id === managingId) ?? null;
  return (
    <>
      <div className={styles.sectionHead}>
        <span>Shared</span>
        <button
          type="button"
          className={styles.sectionAdd}
          onClick={() => setCreating(true)}
          aria-label="New shared project"
          title="New shared project"
        >
          <svg width="10" height="10" viewBox="0 0 10 10" aria-hidden="true">
            <path d="M5 0v10M0 5h10" stroke="currentColor" strokeWidth="1.5" />
          </svg>
        </button>
      </div>
      <ul className={styles.nav}>
        {account &&
          list.map((space) => (
            <li key={space.id} className={styles.projectItem}>
              <a href={spaceHref(account.username, space)} className={styles.navLink}>
                <span className={styles.swatch} style={{ "--swatch": space.color } as CSSProperties} />
                <span className={styles.navLabel}>{space.name}</span>
                <span className={styles.count}>{space.openCount}</span>
              </a>
              <Menu
                label={`${space.name} menu`}
                items={[{ label: "Members and settings", run: () => setManagingId(space.id) }]}
                trigger={
                  <button
                    type="button"
                    className={styles.navMore}
                    aria-label={`More for ${space.name}`}
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
        {spaces.isSuccess && list.length === 0 && (
          <li className={styles.navEmpty}>Work on a project with others: use the plus.</li>
        )}
      </ul>
      <NewSpaceDialog open={creating} onOpenChange={setCreating} />
      <SpaceDialog space={managing} onOpenChange={(on) => !on && setManagingId(null)} />
    </>
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
