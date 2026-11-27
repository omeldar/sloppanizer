import type { Todo } from "@organizer/shared";
import type { CSSProperties } from "react";
import { useCurrentAccount } from "../../app/account.tsx";
import { ProjectPicker } from "../../components/pickers/pickers.tsx";
import type { PickerItem } from "../../components/pickers/Picker.tsx";
import pickerStyles from "../../components/pickers/Picker.module.css";
import { useToast } from "../../components/toast/ToastProvider.tsx";
import { currentSpace, errorMessage } from "../../lib/api.ts";
import { movedTodoHref, useMoveTodo, useOwnProjects, useSpaces } from "../../lib/spaces.ts";

/** Where a todo can move to outside the tab's account: "space:<id>", "own:<project id>" or "own:inbox". */
interface Place {
  spaceId: number | null;
  projectId?: number | null;
  name: string;
}

const swatch = (color: string) => (
  <span className={pickerStyles.swatch} style={{ "--swatch": color } as CSSProperties} />
);

/** Leaves the page for the todo's new place (another tab's app: a full page load). */
const go = (href: string) => window.location.assign(href);

/**
 * The project picker of a todo, with the shared projects (S5#7) and, inside a shared project's tab, your
 * own projects. Those are other accounts, so picking one moves the todo there: it is copied (thread,
 * subtasks, files) and this one is marked done, after a confirmation.
 */
export function TodoProjectPicker({
  todo,
  onPick,
}: {
  todo: Todo;
  /** A project of this tab's account (or null for the Inbox). */
  onPick: (projectId: number | null) => void;
}) {
  const here = currentSpace();
  const account = useCurrentAccount();
  const spaces = useSpaces();
  const own = useOwnProjects(here !== null);
  const move = useMoveTodo();
  const toast = useToast();

  const places = new Map<string, Place>();
  const items: PickerItem[] = [];
  if (here !== null) {
    places.set("own:inbox", { spaceId: null, projectId: null, name: "your Inbox" });
    items.push({
      value: "own:inbox",
      search: "my inbox own",
      label: <span className={pickerStyles.sub}>My Inbox</span>,
      note: "my todos",
    });
    for (const project of (own.data ?? []).filter((p) => p.archivedAt === null)) {
      const value = `own:${project.id}`;
      places.set(value, { spaceId: null, projectId: project.id, name: project.name });
      items.push({
        value,
        search: `${project.name} ${project.slug} my own`,
        label: (
          <>
            {swatch(project.color)}
            {project.name}
          </>
        ),
        note: "my todos",
      });
    }
  }
  for (const space of (spaces.data ?? []).filter((s) => s.id !== here && s.projectSlug !== null)) {
    const value = `space:${space.id}`;
    places.set(value, { spaceId: space.id, name: space.name });
    items.push({
      value,
      search: `${space.name} shared S${space.id}`,
      label: (
        <>
          {swatch(space.color)}
          {space.name}
        </>
      ),
      note: "shared",
    });
  }

  const moveTo = async (value: string) => {
    const place = places.get(value);
    if (!place || !account) return;
    const subtasks = todo.progress.subtasks.total;
    const ok = window.confirm(
      `Move "${todo.title}" to ${place.name}?\n\n` +
        `It is copied there with its comments, checklist${subtasks > 0 ? `, ${subtasks} subtask${subtasks === 1 ? "" : "s"}` : ""}, labels, people and files, ` +
        "and this one is marked done with a link to the copy. Links to other todos stay here.",
    );
    if (!ok) return;
    try {
      const moved = await move.mutateAsync({
        todoId: todo.id,
        spaceId: place.spaceId,
        ...(place.projectId === undefined ? {} : { projectId: place.projectId }),
      });
      go(movedTodoHref(account.username, moved));
    } catch (error) {
      toast.show({ tone: "error", message: `Could not move it. ${errorMessage(error)}` });
    }
  };

  return (
    <ProjectPicker
      value={todo.projectId}
      onChange={onPick}
      elsewhere={items}
      onElsewhere={(value) => void moveTo(value)}
    />
  );
}
