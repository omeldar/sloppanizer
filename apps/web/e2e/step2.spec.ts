import { mkdirSync, readFileSync } from "node:fs";
import { type APIRequestContext, type BrowserContext, expect, type Page, test } from "@playwright/test";
import { formatDate } from "@organizer/shared";
import { strFromU8, unzipSync } from "fflate";
import {
  API,
  drag,
  focusPage as focusIn,
  getJson,
  localDate,
  pastePng,
  pngBytes,
  toast as toastIn,
  watchProblems,
} from "./support.ts";

// Step 2 flows in one browser session: the todo thread with a pasted image, notes, board, week planner,
// contacts, search and the format 2 export. Everything it creates is deleted again in afterAll (uploaded
// files stay: step 2 has no delete for them), so it can also run against a real instance (E2E_BASE_URL).
// E2E_SCREENS_DIR set: screenshots of every new page in both themes go there.

// The steps drive one browser page, so they run one after the other on purpose.
/* oxlint-disable no-await-in-loop */

test.describe.configure({ mode: "serial" });

const stamp = Date.now().toString(36);
// Unique words, so searches and filters only find what this run created.
const word = `zq${stamp}`;
const topic = `${word} firewall rules`;

let context: BrowserContext;
let page: Page;
let api: APIRequestContext;
const problems: string[] = [];
const made = { todos: [] as number[], notes: [] as number[], people: [] as number[], tags: [] as number[] };
let projectId = 0;
let projectSlug = "";

interface TodoJson {
  id: number;
  status: string;
  doneAt: string | null;
  plannedOn: string | null;
  contacts: Array<{ id: number; displayName: string }>;
}

const focusPage = () => focusIn(page);
const toast = (text: string | RegExp) => toastIn(page, text);

async function createTodo(title: string, extra: Record<string, unknown> = {}): Promise<number> {
  const res = await api.post(`${API}/todos`, { data: { title, ...extra } });
  expect(res.status()).toBe(201);
  const { id } = (await res.json()) as { id: number };
  made.todos.push(id);
  return id;
}

const getTodo = (id: number) => getJson<TodoJson>(api, `/todos/${id}`);

test.beforeAll(async ({ browser }) => {
  context = await browser.newContext();
  page = await context.newPage();
  api = context.request;
  watchProblems(page, problems);
  // Loading the app sets the session cookie that the API calls below share.
  await page.goto("/");
  const created = await api.post(`${API}/projects`, { data: { name: `E2E step 2 ${stamp}` } });
  expect(created.status()).toBe(201);
  const project = (await created.json()) as { id: number; slug: string };
  projectId = project.id;
  projectSlug = project.slug;
});

test.afterAll(async () => {
  for (const id of made.todos)
    expect([204, 404]).toContain((await api.delete(`${API}/todos/${id}`)).status());
  for (const id of made.notes)
    expect([204, 404]).toContain((await api.delete(`${API}/notes/${id}`)).status());
  for (const id of made.people)
    expect([204, 404]).toContain((await api.delete(`${API}/people/${id}`)).status());
  for (const id of made.tags) {
    expect([204, 404]).toContain((await api.delete(`${API}/person-tags/${id}`)).status());
  }
  if (projectId) expect((await api.delete(`${API}/projects/${projectId}`)).status()).toBe(204);
  await context.close();
});

test("a comment with a pasted image survives a reload, the thread shows the status change", async () => {
  const id = await createTodo(`Thread ${word}`, { projectId });
  await page.goto(`/todos/${id}`);
  const composer = page.getByRole("textbox", { name: "New comment" });
  await pastePng(composer, "screen.png");
  // The placeholder turns into a Markdown image link once the upload is stored.
  await expect(composer).toContainText("![screen.png](/api/v1/attachments/");
  await composer.press("End");
  await page.keyboard.type(" Looks like this.");
  await page.keyboard.press("Control+Enter");
  const thread = page.getByRole("region", { name: "Activity" });
  await expect(thread.getByRole("listitem").filter({ hasText: "Looks like this." })).toBeVisible();

  await page.getByRole("combobox", { name: "Status" }).selectOption("in_progress");
  await expect.poll(async () => (await getTodo(id)).status).toBe("in_progress");

  await page.reload();
  const image = thread.getByRole("img", { name: "screen.png" });
  await expect(image).toBeVisible();
  await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBeGreaterThan(0);
  await thread.getByRole("checkbox", { name: "Show changes" }).check();
  await expect(thread).toContainText("changed status from Open to In progress");
});

test("a person with team, email, topic and tag becomes a contact and is found by topic", async () => {
  await page.goto("/people");
  await page.getByRole("button", { name: "New person" }).click();
  const dialog = page.getByRole("dialog", { name: "New person" });
  await dialog.getByLabel("First name").fill("Mira");
  await dialog.getByLabel("Last name").fill(`Contact${stamp}`);
  await dialog.getByRole("button", { name: "Add person" }).click();
  await expect(page).toHaveURL(/\/people\/\d+$/);
  const personId = Number(/\/people\/(\d+)$/.exec(page.url())?.[1]);
  made.people.push(personId);
  const name = `Mira Contact${stamp}`;
  const email = `mira.${stamp}@example.com`;

  // Every field is edited inline on the person page.
  const details = page.getByRole("complementary", { name: "Details" });
  await details.getByRole("button", { name: /^Team: not set/ }).click();
  await details.getByRole("combobox", { name: "Team" }).fill("Network team");
  await details.getByRole("combobox", { name: "Team" }).press("Enter");
  await details.getByRole("button", { name: /^Email: not set/ }).click();
  await details.getByRole("textbox", { name: "Email" }).fill(email);
  await details.getByRole("textbox", { name: "Email" }).press("Enter");
  await details.getByRole("combobox", { name: "Add a topic" }).fill(topic);
  await details.getByRole("combobox", { name: "Add a topic" }).press("Enter");
  await details.getByRole("button", { name: "Tags" }).click();
  await page.keyboard.type(`fast reply ${stamp}`);
  await page.getByRole("option", { name: `Create tag fast reply ${stamp}` }).click();
  await page.keyboard.press("Escape");

  await expect
    .poll(async () => {
      const p = await getJson<{
        team: string;
        email: string;
        topics: string[];
        tags: Array<{ id: number; name: string }>;
      }>(api, `/people/${personId}`);
      return { team: p.team, email: p.email, topics: p.topics, tags: p.tags.map((t) => t.name) };
    })
    .toEqual({ team: "Network team", email, topics: [topic], tags: [`fast reply ${stamp}`] });
  const tags = await getJson<Array<{ id: number; name: string }>>(api, "/person-tags");
  made.tags.push(...tags.filter((t) => t.name === `fast reply ${stamp}`).map((t) => t.id));

  // Mail and Teams links carry the address.
  await expect(details.getByRole("link", { name: "Mail" })).toHaveAttribute("href", `mailto:${email}`);
  await expect(details.getByRole("link", { name: "Teams chat" })).toHaveAttribute(
    "href",
    `https://teams.microsoft.com/l/chat/0/0?users=${encodeURIComponent(email)}`,
  );

  // Add as a contact on a todo.
  const id = await createTodo(`Open port 443 ${word}`, { projectId });
  await page.goto(`/todos/${id}`);
  await page.getByRole("button", { name: "Contacts: add or remove people" }).click();
  await page.keyboard.type(name);
  await page
    .getByRole("option", { name: new RegExp(name) })
    .first()
    .click();
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await getTodo(id)).contacts.map((p) => p.id)).toEqual([personId]);

  // The People filter by topic shows only them.
  await page.goto(`/people?topic=${encodeURIComponent(topic)}`);
  const rows = page.getByRole("list", { name: "People" }).getByRole("listitem");
  await expect(rows.filter({ hasText: name })).toHaveCount(1);
  await expect(rows).toHaveCount(1);
  // The palette finds them by topic.
  await focusPage();
  await page.keyboard.press("Control+k");
  await page.keyboard.type(topic);
  await expect(page.getByRole("option", { name: new RegExp(name) })).toBeVisible();
  await page.keyboard.press("Escape");

  // The person page lists the todo under "Contact for".
  await page.goto(`/people/${personId}`);
  await expect(page.getByRole("region", { name: "Contact for" })).toContainText(`Open port 443 ${word}`);
});

test("a note: created in a project, pinned, with a pasted image, filtered by project, found by search", async () => {
  const title = `Router notes ${word}`;
  // With the project filter set, "New note" starts the note in that project.
  await page.goto(`/notes?project=${projectSlug}`);
  await page.getByRole("button", { name: /^New note/ }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByLabel("Title").fill(title);
  await dialog.getByRole("button", { name: "Create note" }).click();
  await expect(page).toHaveURL(/\/notes\/\d+/);
  const noteId = Number(/\/notes\/(\d+)/.exec(page.url())?.[1]);
  made.notes.push(noteId);

  const text = page.getByRole("textbox", { name: "Text" });
  await text.click();
  await page.keyboard.type("VLAN plan ");
  await pastePng(text, "vlans.png");
  await expect(text).toContainText("![vlans.png](/api/v1/attachments/");
  await page.getByRole("button", { name: "Pin", exact: true }).click();
  await expect(page.getByRole("button", { name: "Pinned", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect
    .poll(async () => {
      const note = await getJson<{ bodyMd: string; pinnedAt: string | null; projectId: number | null }>(
        api,
        `/notes/${noteId}`,
      );
      return {
        image: /!\[vlans\.png\]\(\/api\/v1\/attachments\/\d+\/vlans\.png\)/.test(note.bodyMd),
        pinned: note.pinnedAt !== null,
        projectId: note.projectId,
      };
    })
    .toEqual({ image: true, pinned: true, projectId });

  // The project filter shows it; "No project" does not.
  const list = page.getByRole("region", { name: "Notes" });
  await expect(list.getByRole("link", { name: new RegExp(title) })).toBeVisible();
  await list.getByRole("combobox", { name: "Project" }).selectOption("none");
  await expect(list.getByRole("link", { name: new RegExp(title) })).toHaveCount(0);

  // Found by search, and the hit opens the note.
  await page.goto(`/search?q=${encodeURIComponent(`router ${word}`)}`);
  const hit = page.getByRole("list", { name: "Results" }).getByRole("listitem").filter({ hasText: title });
  await expect(hit).toBeVisible();
  await hit.getByRole("link").first().click();
  await expect(page).toHaveURL(new RegExp(`/notes/${noteId}`));
});

test("search page: tabs with counts and highlighted matches", async () => {
  await page.goto(`/search?q=${word}`);
  const results = page.getByRole("list", { name: "Results" });
  // This run made todos, a note, a comment-free person and notes that all carry the word.
  await expect(results.getByRole("listitem").first()).toBeVisible();
  const marks = results.locator("mark");
  await expect(marks.first()).toBeVisible();
  for (const mark of await marks.all()) expect((await mark.textContent())?.toLowerCase()).toBe(word);
  const tabs = page.getByRole("tablist", { name: "Kinds" });
  await tabs.getByRole("tab", { name: /Notes/ }).click();
  await expect(tabs.getByRole("tab", { name: /Notes/ })).toHaveAttribute("aria-selected", "true");
  await expect(results.getByRole("listitem").filter({ hasText: `Router notes ${word}` })).toBeVisible();
  await expect(results.getByRole("listitem").filter({ hasText: `Board ${word}` })).toHaveCount(0);
});

test("board: drag from Open to Done sets done, undo reopens, shift+l moves a column", async () => {
  const id = await createTodo(`Board ${word}`, { projectId });
  await page.goto(`/board?project=${projectSlug}`);
  const column = (name: string) => page.getByRole("region", { name, exact: true });
  const card = (name: string) =>
    column(name)
      .getByRole("listitem")
      .filter({ hasText: `#${id}` });
  await expect(card("Open")).toBeVisible();

  await drag(page, card("Open"), column("Done"));
  await expect(card("Done")).toBeVisible();
  await expect
    .poll(async () => {
      const todo = await getTodo(id);
      return { status: todo.status, done: todo.doneAt !== null };
    })
    .toEqual({ status: "done", done: true });

  await toast(`Moved #${id} to Done`).getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => (await getTodo(id)).status).toBe("open");
  await expect(card("Open")).toBeVisible();

  // The same move with the keyboard: select the card, shift+l moves it one column right.
  // Click the band at the left edge: the title in the middle is a link that opens the todo.
  await card("Open").click({ position: { x: 4, y: 8 } });
  await page.keyboard.press("Shift+L");
  await expect.poll(async () => (await getTodo(id)).status).toBe("in_progress");
  await expect(card("In progress")).toBeVisible();
});

test("week: drag onto Wednesday plans it, back to Unplanned clears it, shift+l moves it a day", async () => {
  const id = await createTodo(`Week ${word}`, { projectId });
  // Monday of this week, then Wednesday and Thursday (the week starts on Monday).
  const today = new Date();
  const monday = localDate(-((today.getDay() + 6) % 7));
  const wednesday = localDate(2, new Date(`${monday}T12:00:00`));
  const thursday = localDate(3, new Date(`${monday}T12:00:00`));
  await page.goto("/week");
  const day = (date: string) =>
    page.getByRole("region", { name: new RegExp(`${formatDate(date).replaceAll(".", "\\.")}$`) });
  const unplanned = page.getByRole("region", { name: "Unplanned", exact: true });
  const card = (zone: ReturnType<typeof day>) => zone.getByRole("listitem").filter({ hasText: `#${id}` });
  await expect(card(unplanned)).toBeVisible();

  await drag(page, card(unplanned), day(wednesday));
  await expect.poll(async () => (await getTodo(id)).plannedOn).toBe(wednesday);
  await expect(card(day(wednesday))).toBeVisible();

  await drag(page, card(day(wednesday)), unplanned);
  await expect.poll(async () => (await getTodo(id)).plannedOn).toBeNull();
  await expect(card(unplanned)).toBeVisible();

  // Plan it for Wednesday again, then shift+l moves it to Thursday.
  expect((await api.patch(`${API}/todos/${id}`, { data: { plannedOn: wednesday } })).status()).toBe(200);
  await page.reload();
  await card(day(wednesday)).click({ position: { x: 4, y: 8 } });
  await page.keyboard.press("Shift+L");
  await expect.poll(async () => (await getTodo(id)).plannedOn).toBe(thursday);
  await expect(card(day(thursday))).toBeVisible();
});

test("the export zip (format 3) has the uploaded file, notes and people Markdown", async () => {
  const upload = await api.post(`${API}/attachments?name=e2e-${stamp}.png`, {
    data: pngBytes(),
    headers: { "content-type": "application/octet-stream" },
  });
  expect(upload.status()).toBe(201);
  const attachment = (await upload.json()) as { id: number; url: string; name: string };
  const note = await api.post(`${API}/notes`, {
    data: { title: `Export note ${word}`, bodyMd: `![shot](${attachment.url})`, projectId },
  });
  expect(note.status()).toBe(201);
  const noteId = ((await note.json()) as { id: number }).id;
  made.notes.push(noteId);

  await page.goto("/settings");
  const [download] = await Promise.all([
    page.waitForEvent("download"),
    page.getByRole("button", { name: "Download export" }).click(),
  ]);
  const files = unzipSync(readFileSync(await download.path()));
  const text = (name: string) => strFromU8(files[name] as Uint8Array);
  const manifest = JSON.parse(text("manifest.json")) as {
    format: number;
    attachments: { count: number; missing: number[] };
  };
  expect(manifest.format).toBe(3);
  expect(manifest.attachments.missing).toEqual([]);

  const zipName = `attachments/${attachment.id}-${attachment.name}`;
  expect(Buffer.from(files[zipName] as Uint8Array).equals(pngBytes())).toBe(true);
  const noteFile = Object.keys(files).find((n) => n.startsWith(`notes/${String(noteId).padStart(4, "0")}-`));
  expect(noteFile).toBeDefined();
  expect(text(noteFile as string)).toContain(`![shot](../attachments/${attachment.id}-${attachment.name})`);
  const personFile = Object.keys(files).find(
    (n) => n.startsWith("people/") && n.endsWith(`contact${stamp}.md`),
  );
  expect(personFile).toBeDefined();
  expect(text(personFile as string)).toContain(topic);

  const data = JSON.parse(text("data.json")) as Record<string, Array<Record<string, unknown>>>;
  for (const table of [
    "topics",
    "person_tags",
    "person_topics",
    "person_tag_links",
    "notes",
    "comments",
    "attachments",
  ]) {
    expect(data[table], table).toBeDefined();
  }
  expect(data.notes?.find((row) => row.id === noteId)?.body_md).toBe(`![shot](${attachment.url})`);
  expect(data.comments?.some((row) => String(row.body_md).includes("Looks like this."))).toBe(true);
  expect(data.search_fts).toBeUndefined();
});

test("every new page renders in dark and light", async () => {
  const dir = process.env.E2E_SCREENS_DIR;
  if (dir) mkdirSync(dir, { recursive: true });
  const person = made.people[0];
  const note = made.notes[0];
  const pages: Array<[string, string]> = [
    ["board", "/board"],
    ["board-project", `/projects/${projectSlug}?view=board`],
    ["week", "/week"],
    ["notes", "/notes"],
    ["note", `/notes/${note}`],
    ["search", `/search?q=${word}`],
    ["people-step2", "/people"],
    ["person", `/people/${person}`],
    ["todo-thread", `/todos/${made.todos[0]}`],
  ];
  for (const theme of ["dark", "light"] as const) {
    await page.evaluate((t) => localStorage.setItem("organizer.theme", t), theme);
    for (const [name, path] of pages) {
      await page.goto(path);
      await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
      await expect(page.getByRole("heading", { level: 1 }).first()).toBeVisible();
      await page.waitForLoadState("networkidle");
      if (dir) await page.screenshot({ path: `${dir}/${name}-${theme}.png`, fullPage: true });
    }
  }
  await page.evaluate(() => localStorage.setItem("organizer.theme", "dark"));
});

test("no console errors on the way", () => {
  expect(problems).toEqual([]);
});
