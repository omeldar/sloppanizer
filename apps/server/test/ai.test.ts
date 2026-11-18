import type {
  AiBreakdownResponse,
  AiPlanResponse,
  AiSettings,
  AiStandupResponse,
  Todo,
} from "@organizer/shared";
import { describe, expect, it } from "vitest";
import { aiSettings } from "../src/db/auth-schema.ts";
import type { ClaudeRunner } from "../src/services/ai.ts";
import { json, makeApp } from "./helpers.ts";

interface Call {
  apiKey: string;
  model: string;
  system: string;
  user: string;
}

/** A Claude stand-in that records each call and answers with `answer`. */
function fakeClaude(answer: unknown): { runner: ClaudeRunner; calls: Call[] } {
  const calls: Call[] = [];
  const runner: ClaudeRunner = async ({ apiKey, model, prompt }) => {
    calls.push({ apiKey, model, system: prompt.system, user: prompt.user });
    return answer as never;
  };
  return { runner, calls };
}

const KEY = "sk-ant-test-0000000000000000";

describe("AI assistant settings", () => {
  it("starts off, keeps the Claude key encrypted and never sends it back", async () => {
    const t = await makeApp();
    expect(json<AiSettings>(await t.call("GET", "/api/v1/ai/settings"))).toMatchObject({
      provider: "none",
      claudeKeySet: false,
      dayStart: "09:00",
    });
    const res = await t.call("PATCH", "/api/v1/ai/settings", {
      provider: "claude",
      claudeApiKey: KEY,
      claudeModel: "claude-sonnet-5-5",
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).not.toContain(KEY);
    expect(json<AiSettings>(res)).toMatchObject({
      provider: "claude",
      claudeKeySet: true,
      claudeModel: "claude-sonnet-5-5",
    });
    const stored = t.deps.db.select().from(aiSettings).get();
    expect(stored?.claudeKeyEnc).toBeTruthy();
    expect(stored?.claudeKeyEnc).not.toContain(KEY);
    // "" removes the key.
    expect(
      json<AiSettings>(await t.call("PATCH", "/api/v1/ai/settings", { claudeApiKey: "" })).claudeKeySet,
    ).toBe(false);
  });

  it("refuses a working day that ends before it starts and settings from tokens", async () => {
    const t = await makeApp();
    expect(
      (await t.call("PATCH", "/api/v1/ai/settings", { dayStart: "18:00", dayEnd: "09:00" })).statusCode,
    ).toBe(422);
    const raw = t.token("script", "write");
    expect((await t.withToken(raw, "PATCH", "/api/v1/ai/settings", { provider: "claude" })).statusCode).toBe(
      403,
    );
  });
});

describe("Plan my day", () => {
  it("says how to turn the assistant on while it is off", async () => {
    const t = await makeApp();
    const res = await t.call("POST", "/api/v1/ai/plan", { day: "2026-11-12" });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("Settings, AI assistant");
  });

  it("asks Claude with the ranked todos and free time and returns the answer with its context", async () => {
    const answer = {
      blocks: [{ todoId: 1, start: "14:00", end: "15:00", why: "due soon" }],
      note: "Short day.",
    };
    const claude = fakeClaude(answer);
    // 10:00 in Zurich on 2026-11-11.
    const t = await makeApp({ claude: claude.runner });
    const todo = await t.create<Todo>("/api/v1/todos", { title: "Renew certs", dueOn: "2026-11-12" });
    await t.create("/api/v1/blocks", {
      title: "Lunch",
      startAt: "2026-11-12T11:00:00.000Z",
      endAt: "2026-11-12T12:00:00.000Z",
    });
    await t.call("PATCH", "/api/v1/ai/settings", { provider: "claude", claudeApiKey: KEY });
    const res = await t.call("POST", "/api/v1/ai/plan", { day: "2026-11-12" });
    expect(res.statusCode).toBe(200);
    const plan = json<AiPlanResponse>(res);
    expect(plan.mode).toBe("result");
    expect(plan.context).toMatchObject({ day: "2026-11-12", busy: [[720, 780]], notBefore: null });
    expect(plan.context.candidates).toEqual([{ id: todo.id, title: "Renew certs" }]);
    expect(claude.calls).toHaveLength(1);
    expect(claude.calls[0]).toMatchObject({ apiKey: KEY, model: "claude-opus-5-5" });
    expect(claude.calls[0]?.user).toContain(`id ${todo.id}: Renew certs`);
    expect(claude.calls[0]?.user).toContain("- 12:00-13:00 Lunch");
  });

  it("hands the prompt to the browser for a local Ollama and plans nothing before now today", async () => {
    const t = await makeApp();
    await t.create("/api/v1/todos", { title: "Something" });
    await t.call("PATCH", "/api/v1/ai/settings", { provider: "ollama" });
    const plan = json<AiPlanResponse>(await t.call("POST", "/api/v1/ai/plan", { day: "2026-11-11" }));
    expect(plan.mode).toBe("prompt");
    if (plan.mode !== "prompt") return;
    expect(plan.context.notBefore).toBe("11:00");
    expect(plan.prompt.schema).toMatchObject({ type: "object" });
    expect(plan.prompt.user).toContain("plan nothing before that");
    expect((await t.call("POST", "/api/v1/ai/plan", { day: "2026-11-01" })).statusCode).toBe(422);
  });

  it("counts the day's meetings as busy, but not a cancelled date", async () => {
    const claude = fakeClaude({ blocks: [], note: "" });
    const t = await makeApp({ claude: claude.runner });
    const schedule = {
      rule: { every: "week" },
      startsOn: "2026-11-12",
      startTime: "09:00",
      durationMinutes: 15,
    };
    await t.create("/api/v1/meetings", { name: "Weekly Standup", schedule });
    const retro = await t.create<{ id: number }>("/api/v1/meetings", {
      name: "Retro",
      schedule: { ...schedule, startTime: "15:00", durationMinutes: 60 },
    });
    await t.call("PATCH", `/api/v1/meetings/${retro.id}/occurrences/2026-11-12`, {
      scope: "this",
      cancelled: true,
    });
    await t.call("PATCH", "/api/v1/ai/settings", { provider: "claude", claudeApiKey: KEY });
    const plan = json<AiPlanResponse>(await t.call("POST", "/api/v1/ai/plan", { day: "2026-11-12" }));
    expect(plan.context.busy).toEqual([[540, 555]]);
    expect(claude.calls[0]?.user).toContain("- 09:00-09:15 Weekly Standup");
    expect(claude.calls[0]?.user).not.toContain("Retro");
  });

  it("needs a key for Claude", async () => {
    const t = await makeApp();
    await t.call("PATCH", "/api/v1/ai/settings", { provider: "claude" });
    expect((await t.call("POST", "/api/v1/ai/plan", { day: "2026-11-12" })).statusCode).toBe(409);
  });
});

describe("Break it down", () => {
  it("sends the todo and its subtasks and returns the steps", async () => {
    const claude = fakeClaude({ steps: ["Buy cables", "Mount rack"], note: "" });
    const t = await makeApp({ claude: claude.runner });
    const todo = await t.create<Todo>("/api/v1/todos", {
      title: "Set up the rack",
      descriptionMd: "In the basement",
    });
    await t.call("POST", `/api/v1/todos/${todo.id}/subtasks`, { titles: ["Measure the room"] });
    await t.call("PATCH", "/api/v1/ai/settings", { provider: "claude", claudeApiKey: KEY });
    const res = json<AiBreakdownResponse>(await t.call("POST", "/api/v1/ai/breakdown", { todoId: todo.id }));
    expect(res).toEqual({ mode: "result", answer: { steps: ["Buy cables", "Mount rack"], note: "" } });
    expect(claude.calls[0]?.user).toContain("Todo: Set up the rack");
    expect(claude.calls[0]?.user).toContain("- Measure the room");
  });
});

/** A standup with one done and one blocked todo. */
async function standupWithItems(t: Awaited<ReturnType<typeof makeApp>>) {
  const meeting = await t.create<{ id: number }>("/api/v1/meetings", {
    name: "Weekly Standup",
    schedule: { rule: { every: "week" }, startsOn: "2026-11-12", startTime: "09:00", durationMinutes: 15 },
  });
  const done = await t.create<Todo>("/api/v1/todos", { title: "Renew certs" });
  await t.call("PATCH", `/api/v1/todos/${done.id}`, { status: "done" });
  const blocked = await t.create<Todo>("/api/v1/todos", { title: "Order disks" });
  await t.call("PATCH", `/api/v1/todos/${blocked.id}`, { status: "blocked" });
  await t.call("POST", `/api/v1/todos/${blocked.id}/comments`, { bodyMd: "Vendor is **late**" });
  return meeting;
}

describe("Sum up the standup", () => {
  it("asks Claude with the open items and returns clean lines", async () => {
    const claude = fakeClaude({
      lines: ["- Renewed the certs.", "", "2) Disks are blocked by the vendor."],
      note: "ok",
    });
    const t = await makeApp({ claude: claude.runner });
    const meeting = await standupWithItems(t);
    await t.call("PATCH", "/api/v1/ai/settings", { provider: "claude", claudeApiKey: KEY });
    const res = await t.call("POST", "/api/v1/ai/standup", { meetingId: meeting.id });
    expect(json<AiStandupResponse>(res)).toEqual({
      mode: "result",
      answer: { lines: ["Renewed the certs.", "Disks are blocked by the vendor."], note: "ok" },
    });
    const user = claude.calls[0]?.user ?? "";
    expect(user).toContain("Meeting: Weekly Standup. Things since 05.11.2026 09:00:");
    expect(user).toContain("- done: Renew certs changes: changed status from Open to Done");
    expect(user).toContain("- blocked: Order disks");
    expect(user).toContain("last comment: Vendor is late");
    expect(user).not.toMatch(/#\d/);
    // Only the kinds asked for.
    await t.call("POST", "/api/v1/ai/standup", { meetingId: meeting.id, kinds: ["blocked"] });
    expect(claude.calls[1]?.user).not.toContain("Renew certs");
  });

  it("hands the prompt to a local Ollama and refuses meetings without a list", async () => {
    const t = await makeApp();
    const meeting = await standupWithItems(t);
    const res = await t.call("POST", "/api/v1/ai/standup", { meetingId: meeting.id });
    expect(res.statusCode).toBe(409);
    expect(res.body).toContain("Settings, AI assistant");
    await t.call("PATCH", "/api/v1/ai/settings", { provider: "ollama" });
    const prompt = json<AiStandupResponse>(
      await t.call("POST", "/api/v1/ai/standup", { meetingId: meeting.id }),
    );
    expect(prompt.mode).toBe("prompt");
    if (prompt.mode !== "prompt") return;
    expect(prompt.prompt.user).toContain("Order disks");
    expect(prompt.prompt.schema).toMatchObject({ type: "object" });
    const retro = await t.create<{ id: number }>("/api/v1/meetings", {
      name: "Retro",
      schedule: { rule: { every: "week" }, startsOn: "2026-11-12", startTime: "15:00", durationMinutes: 60 },
    });
    expect((await t.call("POST", "/api/v1/ai/standup", { meetingId: retro.id })).statusCode).toBe(409);
    const bobby = await t.asAccount({ username: "bobby" });
    await bobby.call("PATCH", "/api/v1/ai/settings", { provider: "ollama" });
    const foreign = await bobby.call("POST", "/api/v1/ai/standup", { meetingId: meeting.id });
    expect(foreign.statusCode).toBe(404);
    expect(foreign.body).not.toContain("Order disks");
  });
});
