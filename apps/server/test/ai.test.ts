import type { AiBreakdownResponse, AiPlanResponse, AiSettings, Todo } from "@organizer/shared";
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
