import type { Attachment, Label, Note, Person, PersonTag, Project, Todo } from "@organizer/shared";
import type { TestApp } from "./helpers.ts";

/** Data in every export table, plus a deleted newest todo and attachment so sequences are ahead of the ids. */
export async function fillEveryTable(t: TestApp) {
  const project = await t.create<Project>("/api/v1/projects", { name: "Lab" });
  await t.create<Label>("/api/v1/labels", { name: "homelab" });
  await t.create<PersonTag>("/api/v1/person-tags", { name: "fast reply" });
  const anna = await t.create<Person>("/api/v1/people", {
    firstName: "Anna",
    lastName: "Müller",
    topics: ["dns"],
    tags: ["fast reply"],
    notesMd: "Prefers chat",
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
  const gone = await t.create<Todo>("/api/v1/todos", { title: "Deleted newest" });
  await t.call("DELETE", `/api/v1/todos/${gone.id}`);
  const goneFile = json(
    await t.call("POST", "/api/v1/attachments?name=x.bin", Buffer.from("x"), {
      "content-type": "application/octet-stream",
    }),
  );
  t.deps.db.$client.prepare("DELETE FROM attachments WHERE id = ?").run(goneFile.id);
  return { project, anna, todo, file };
}

const json = (res: { json: () => unknown }) => res.json() as { id: number };
