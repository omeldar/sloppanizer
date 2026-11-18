import Anthropic, { APIError, AuthenticationError, RateLimitError } from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import {
  type AiPrompt,
  type AiSettings,
  BreakdownAnswer,
  breakdownPrompt,
  checkPlan,
  type ClaudeModel,
  formatDateTime,
  PlanAnswer,
  type PlanContext,
  planPrompt,
  priorityOf,
  type StandupKind,
  StandupSummaryAnswer,
  standupPrompt,
  TodoListQuery,
  toLocalDate,
  toLocalTime,
  type UpdateAiSettings,
} from "@organizer/shared";
import { eq } from "drizzle-orm";
import { z } from "zod";
import type { Clock } from "../clock.ts";
import { aiSettings } from "../db/auth-schema.ts";
import type { Db } from "../db/index.ts";
import { ApiError } from "../http/errors.ts";
import { decryptSecret, encryptSecret } from "./auth/crypto.ts";
import { listBlocks } from "./blocks.ts";
import type { Ctx } from "./context.ts";
import { meetingRow } from "./meeting-data.ts";
import { listOccurrences } from "./meetings.ts";
import { getStandup } from "./standup.ts";
import { getTodo, listTodos, nextUp } from "./todos.ts";

const KEY_PURPOSE = "ai-claude-key";
const CANDIDATES = 15;

type Row = typeof aiSettings.$inferSelect;

const row = (db: Db, accountId: number): Row | undefined =>
  db.select().from(aiSettings).where(eq(aiSettings.accountId, accountId)).get();

export function getAiSettings(db: Db, accountId: number): AiSettings {
  const r = row(db, accountId);
  return {
    provider: r?.provider ?? "none",
    claudeModel: (r?.claudeModel as ClaudeModel | undefined) ?? "claude-opus-5-5",
    claudeKeySet: Boolean(r?.claudeKeyEnc),
    ollamaUrl: r?.ollamaUrl ?? "http://localhost:11434",
    ollamaModel: r?.ollamaModel ?? "jaahas/qwen3.5-uncensored:9b",
    dayStart: r?.dayStart ?? "09:00",
    dayEnd: r?.dayEnd ?? "18:00",
  };
}

export function updateAiSettings(
  db: Db,
  clock: Clock,
  dataKey: Buffer,
  accountId: number,
  input: UpdateAiSettings,
): AiSettings {
  const current = getAiSettings(db, accountId);
  const next = {
    provider: input.provider ?? current.provider,
    claudeModel: input.claudeModel ?? current.claudeModel,
    ollamaUrl: (input.ollamaUrl ?? current.ollamaUrl).replace(/\/+$/, ""),
    ollamaModel: input.ollamaModel ?? current.ollamaModel,
    dayStart: input.dayStart ?? current.dayStart,
    dayEnd: input.dayEnd ?? current.dayEnd,
  };
  if (next.dayStart >= next.dayEnd)
    throw new ApiError("validation_failed", "The working day must end after it starts.");
  const key =
    input.claudeApiKey === undefined
      ? {}
      : {
          claudeKeyEnc:
            input.claudeApiKey === "" ? null : encryptSecret(dataKey, input.claudeApiKey, KEY_PURPOSE),
        };
  const values = { ...next, ...key, updatedAt: clock().toISOString() };
  db.insert(aiSettings)
    .values({ accountId, ...values })
    .onConflictDoUpdate({ target: aiSettings.accountId, set: values })
    .run();
  return getAiSettings(db, accountId);
}

/** The account's Claude API key, or null. */
export function claudeKey(db: Db, dataKey: Buffer, accountId: number): string | null {
  const enc = row(db, accountId)?.claudeKeyEnc;
  return enc ? decryptSecret(dataKey, enc, KEY_PURPOSE) : null;
}

// ---------- context and prompts ----------

const minutesOf = (time: string): number => {
  const [h = "0", m = "0"] = time.split(":");
  return Number(h) * 60 + Number(m);
};

export function buildPlan(
  ctx: Ctx,
  settings: AiSettings,
  day: string,
): { prompt: AiPrompt; context: PlanContext } {
  const now = ctx.clock();
  const today = toLocalDate(now, ctx.timeZone);
  if (day < today) throw new ApiError("validation_failed", "Plan today or a later day.");
  // Time blocks and the day's meetings (not the cancelled ones) are taken.
  const taken = [
    ...listBlocks(ctx, { from: day, to: day }).map((b) => ({
      startAt: b.startAt,
      endAt: b.endAt,
      title: b.todo?.title ?? b.title,
      todoId: b.todoId,
    })),
    ...listOccurrences(ctx, { from: day, to: day }).map((o) => ({
      startAt: o.startAt,
      endAt: o.endAt,
      title: o.name,
      todoId: null,
    })),
  ].toSorted((a, b) => a.startAt.localeCompare(b.startAt));
  const busy = taken.map((b) => {
    const startDay = toLocalDate(b.startAt, ctx.timeZone);
    const endDay = toLocalDate(b.endAt, ctx.timeZone);
    const start = startDay < day ? "00:00" : toLocalTime(b.startAt, ctx.timeZone);
    const end = endDay > day ? "24:00" : toLocalTime(b.endAt, ctx.timeZone);
    return { start, end, title: b.title, todoId: b.todoId };
  });
  const planned = new Set(busy.flatMap((b) => (b.todoId === null ? [] : [b.todoId])));
  const ranked = nextUp(ctx, { mode: "smart", limit: CANDIDATES + planned.size })
    .items.filter((item) => !planned.has(item.todo.id))
    .slice(0, CANDIDATES);
  const notBefore = day === today ? toLocalTime(now, ctx.timeZone) : null;
  const weekday = new Intl.DateTimeFormat("en-GB", { weekday: "long", timeZone: "UTC" }).format(
    new Date(`${day}T12:00:00Z`),
  );
  const prompt = planPrompt({
    day,
    weekday,
    dayStart: settings.dayStart,
    dayEnd: settings.dayEnd,
    notBefore,
    busy: busy.map(({ start, end, title }) => ({ start, end, title })),
    candidates: ranked.map(({ todo, reasons }) => ({
      id: todo.id,
      title: todo.title,
      priority: priorityOf(todo.labels),
      dueOn: todo.dueOn,
      plannedOn: todo.plannedOn,
      labels: todo.labels.map((l) => l.name).filter((n) => !n.startsWith("priority::")),
      reasons: reasons.map((r) => r.label),
      status: todo.status,
      notes: todo.descriptionMd.replace(/\s+/g, " ").slice(0, 200),
    })),
  });
  return {
    prompt: { ...prompt, schema: z.toJSONSchema(PlanAnswer) as Record<string, unknown> },
    context: {
      day,
      dayStart: settings.dayStart,
      dayEnd: settings.dayEnd,
      busy: busy.map((b) => [minutesOf(b.start), minutesOf(b.end)] as [number, number]),
      candidates: ranked.map(({ todo }) => ({ id: todo.id, title: todo.title })),
      notBefore,
    },
  };
}

export function buildBreakdown(ctx: Ctx, todoId: number): { prompt: AiPrompt; existing: string[] } {
  const todo = getTodo(ctx, todoId);
  const existing = listTodos(
    ctx,
    TodoListQuery.parse({ parentId: String(todoId), status: "all", limit: 200 }),
  ).items.map((t) => t.title);
  const prompt = breakdownPrompt({ title: todo.title, description: todo.descriptionMd, existing });
  return {
    prompt: { ...prompt, schema: z.toJSONSchema(BreakdownAnswer) as Record<string, unknown> },
    existing,
  };
}

/** The prompt that sums up a standup's open list (only the given kinds, default all). */
export function buildStandupSummary(ctx: Ctx, meetingId: number, kinds?: readonly StandupKind[]): AiPrompt {
  const standup = getStandup(ctx, meetingId, kinds ? { kind: [...kinds] } : {});
  const prompt = standupPrompt({
    meetingName: meetingRow(ctx, meetingId).name,
    since: formatDateTime(standup.since, ctx.timeZone),
    items: standup.items.map((item) => ({
      kind: item.kind,
      title: item.todo.title,
      project: item.project?.name ?? null,
      parent: item.parent?.title ?? null,
      changes: item.changes,
      comment: item.lastComment?.excerpt ?? null,
    })),
  });
  return { ...prompt, schema: z.toJSONSchema(StandupSummaryAnswer) as Record<string, unknown> };
}

// ---------- Claude ----------

/** Runs a prompt on Claude and returns the parsed answer. Injected, so tests never call the API. */
export type ClaudeRunner = <T>(input: {
  apiKey: string;
  model: ClaudeModel;
  prompt: { system: string; user: string };
  schema: z.ZodType<T>;
}) => Promise<T>;

export const runClaude: ClaudeRunner = async ({ apiKey, model, prompt, schema }) => {
  const client = new Anthropic({ apiKey, maxRetries: 1, timeout: 120_000 });
  try {
    const response = await client.beta.messages.parse({
      model,
      max_tokens: 16000,
      // On a safety decline the API retries on the model it picks for that case.
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      output_config: { effort: "medium", format: zodOutputFormat(schema) },
      system: prompt.system,
      messages: [{ role: "user", content: prompt.user }],
    });
    if (response.stop_reason === "refusal") {
      throw new ApiError("conflict", "Claude declined this request. Try again with other wording.");
    }
    if (response.parsed_output === null || response.parsed_output === undefined) {
      throw new ApiError("conflict", "Claude's answer could not be read. Try again.");
    }
    return response.parsed_output as never;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof AuthenticationError) {
      throw new ApiError(
        "validation_failed",
        "The Claude API key was not accepted. Check it under Settings, AI assistant.",
      );
    }
    if (error instanceof RateLimitError) {
      throw new ApiError(
        "too_many_requests",
        "Claude is busy or the account's limit is reached. Try again in a minute.",
      );
    }
    if (error instanceof APIError) {
      throw new ApiError(
        "conflict",
        `Claude answered with an error (${error.status ?? "no status"}). Try again.`,
      );
    }
    throw new ApiError("conflict", "Claude could not be reached. Try again.");
  }
};

export { checkPlan };
