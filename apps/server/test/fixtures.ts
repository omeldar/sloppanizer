import type { Attachment, Label, Meeting, Note, Person, PersonTag, Project, Todo } from "@organizer/shared";
import type { TestApp } from "./helpers.ts";

/** Data in every export table, plus a deleted newest todo and attachment so sequences are ahead of the ids. */
export async function fillEveryTable(t: Pick<TestApp, "call" | "create" | "account" | "ctx">) {
  const project = await t.create<Project>("/api/v1/projects", { name: "Lab" });
  const homelab = await t.create<Label>("/api/v1/labels", { name: "homelab" });
  await t.create<PersonTag>("/api/v1/person-tags", { name: "fast reply" });
  const anna = await t.create<Person>("/api/v1/people", {
    firstName: "Anna",
    lastName: "Müller",
    topics: ["dns"],
    tags: ["fast reply"],
    notesMd: "Prefers chat",
    languages: ["de"],
  });
  const upload = await t.call(
    "POST",
    "/api/v1/attachments?name=shot.png",
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]),
    {
      "content-type": "image/png",
    },
  );
  const file = upload.json() as Attachment;
  const todo = await t.create<Todo>("/api/v1/todos", {
    title: "Rack",
    projectId: project.id,
    labels: ["homelab", "priority::high"],
    requestedBy: [{ personId: anna.id }],
    contacts: [{ firstName: "Bo", lastName: "Li" }],
    descriptionMd: `- [ ] cables ![shot](${file.url})`,
  });
  const [child] = (
    await t.call("POST", `/api/v1/todos/${todo.id}/subtasks`, { titles: ["Child"] })
  ).json() as Todo[];
  await t.call("POST", `/api/v1/todos/${todo.id}/links`, { links: [{ kind: "blocks", todoId: child?.id }] });
  await t.call("POST", `/api/v1/todos/${todo.id}/comments`, { bodyMd: "First comment" });
  await t.call("POST", `/api/v1/todos/${todo.id}/urls`, {
    urls: [{ url: "https://example.com/rack", label: "Rack spec" }],
  });
  await t.create("/api/v1/blocks", {
    todoId: todo.id,
    startAt: "2026-11-12T09:00:00.000Z",
    endAt: "2026-11-12T10:30:00.000Z",
  });
  const weekly = await t.create<Todo>("/api/v1/todos", {
    title: "Weekly check",
    dueOn: "2026-11-11",
    recurrence: { every: "week" },
  });
  await t.call("PATCH", `/api/v1/todos/${weekly.id}`, { status: "done" });
  await t.create<Note>("/api/v1/notes", {
    title: "Plan",
    bodyMd: "Notes",
    projectId: project.id,
    pinned: true,
  });
  // A standup with a moved date, a said todo, a note on its first date and a todo added by hand.
  const meeting = await t.create<Meeting>("/api/v1/meetings", {
    name: "Team standup",
    schedule: { rule: { every: "week" }, startsOn: "2026-11-12", startTime: "09:00", durationMinutes: 15 },
    filter: { projectIds: [project.id], labelIds: [homelab.id] },
  });
  await t.call("PATCH", `/api/v1/meetings/${meeting.id}/occurrences/2026-11-19`, {
    scope: "this",
    startAt: "2026-11-18T13:00:00.000Z",
    endAt: "2026-11-18T13:15:00.000Z",
  });
  await t.call("POST", `/api/v1/meetings/${meeting.id}/standup/marks`, {
    on: "2026-11-12",
    marks: [{ todoId: todo.id, kind: "said", coveredUntil: "2026-11-11T10:00:00.000Z" }],
  });
  await t.create(`/api/v1/meetings/${meeting.id}/notes`, { on: "2026-11-12" });
  await t.create(`/api/v1/meetings/${meeting.id}/todos`, { todoId: todo.id });
  const gone = await t.create<Todo>("/api/v1/todos", { title: "Deleted newest" });
  await t.call("DELETE", `/api/v1/todos/${gone.id}`);
  const goneFile = json(
    await t.call("POST", "/api/v1/attachments?name=x.bin", Buffer.from("x"), {
      "content-type": "application/octet-stream",
    }),
  );
  t.ctx()
    .db.$client.prepare("DELETE FROM attachments WHERE account_id = ? AND id = ?")
    .run(t.account.id, goneFile.id);
  return { project, anna, todo, file, meeting };
}

const json = (res: { json: () => unknown }) => res.json() as { id: number };
