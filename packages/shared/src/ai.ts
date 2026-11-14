import { z } from "zod";

/**
 * The in-app AI assistant. Pluggable per account: the Claude API (the server calls it with the account's
 * key) or a local Ollama (the browser calls it). Both get the same prompts and must answer the same
 * schemas; everything a model proposes is checked again before it is shown.
 */

export const AI_PROVIDERS = ["none", "claude", "ollama"] as const;
export const AiProvider = z.enum(AI_PROVIDERS);
export type AiProvider = z.infer<typeof AiProvider>;

export const CLAUDE_MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] as const;
export const ClaudeModel = z.enum(CLAUDE_MODELS);
export type ClaudeModel = z.infer<typeof ClaudeModel>;

export const DEFAULT_OLLAMA_URL = "http://localhost:11434";
export const DEFAULT_OLLAMA_MODEL = "jaahas/qwen3.5-uncensored:9b";

const DayTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "Use HH:MM, 24 hours.");

export const AiSettings = z.strictObject({
  provider: AiProvider,
  claudeModel: ClaudeModel,
  /** Whether a Claude API key is stored (the key itself is never sent back). */
  claudeKeySet: z.boolean(),
  ollamaUrl: z.string(),
  ollamaModel: z.string(),
  /** The working day the planner fills. */
  dayStart: DayTime,
  dayEnd: DayTime,
});
export type AiSettings = z.infer<typeof AiSettings>;

export const UpdateAiSettings = z
  .strictObject({
    provider: AiProvider.optional(),
    claudeModel: ClaudeModel.optional(),
    /** A new key; "" removes the stored one. */
    claudeApiKey: z.string().trim().max(400).optional(),
    ollamaUrl: z
      .string()
      .trim()
      .max(300)
      .refine((v) => /^https?:\/\/[^\s/]+(:\d+)?\/?$/.test(v), "Enter a URL like http://localhost:11434.")
      .optional(),
    ollamaModel: z.string().trim().min(1).max(200).optional(),
    dayStart: DayTime.optional(),
    dayEnd: DayTime.optional(),
  })
  .refine((v) => !v.dayStart || !v.dayEnd || v.dayStart < v.dayEnd, {
    message: "The working day must end after it starts.",
    path: ["dayEnd"],
  });
export type UpdateAiSettings = z.infer<typeof UpdateAiSettings>;

// ---------- answers the models must give ----------

export const PlanAnswer = z.object({
  blocks: z
    .array(
      z.object({
        todoId: z.number().int().describe("Id of a todo from the candidate list."),
        start: z.string().describe("Local start time HH:MM."),
        end: z.string().describe("Local end time HH:MM."),
        why: z.string().describe("One short sentence: why this todo, why now."),
      }),
    )
    .describe("Time blocks for the day, in order, inside free time only."),
  note: z.string().describe("One or two sentences for the user about the plan (what was left out and why)."),
});
export type PlanAnswer = z.infer<typeof PlanAnswer>;

export const BreakdownAnswer = z.object({
  steps: z.array(z.string()).describe("3 to 8 concrete next actions, each a short todo title (imperative)."),
  note: z.string().describe("One sentence for the user, may be empty."),
});
export type BreakdownAnswer = z.infer<typeof BreakdownAnswer>;

// ---------- the API between the web app and the server ----------

export const AI_FEATURES = ["plan", "breakdown"] as const;
export const AiFeature = z.enum(AI_FEATURES);
export type AiFeature = z.infer<typeof AiFeature>;

export const AiPlanRequest = z.strictObject({ day: z.iso.date() });
export const AiBreakdownRequest = z.strictObject({ todoId: z.number().int().positive() });

/** The context a plan was made in, to check the answer against. */
export const PlanContext = z.strictObject({
  day: z.string(),
  dayStart: z.string(),
  dayEnd: z.string(),
  /** Minutes after midnight that are already taken, as [start, end) pairs. */
  busy: z.array(z.tuple([z.number(), z.number()])),
  candidates: z.array(z.strictObject({ id: z.number(), title: z.string() })),
  /** No block before this (now, on today). */
  notBefore: z.string().nullable(),
});
export type PlanContext = z.infer<typeof PlanContext>;

export const AiPrompt = z.strictObject({
  system: z.string(),
  user: z.string(),
  /** JSON schema of the answer (for Ollama's format). */
  schema: z.record(z.string(), z.unknown()),
});
export type AiPrompt = z.infer<typeof AiPrompt>;

/** The server's answer: the result (Claude ran on the server) or the prompt to run locally (Ollama). */
export const AiPlanResponse = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("result"), answer: PlanAnswer, context: PlanContext }),
  z.strictObject({ mode: z.literal("prompt"), prompt: AiPrompt, context: PlanContext }),
]);
export type AiPlanResponse = z.infer<typeof AiPlanResponse>;

export const AiBreakdownResponse = z.discriminatedUnion("mode", [
  z.strictObject({ mode: z.literal("result"), answer: BreakdownAnswer }),
  z.strictObject({ mode: z.literal("prompt"), prompt: AiPrompt }),
]);
export type AiBreakdownResponse = z.infer<typeof AiBreakdownResponse>;

// ---------- prompts ----------

export interface PlanCandidate {
  id: number;
  title: string;
  priority: string | null;
  dueOn: string | null;
  plannedOn: string | null;
  labels: string[];
  reasons: string[];
  status: string;
  notes: string;
}

const minutes = (time: string): number => {
  const [h = "0", m = "0"] = time.split(":");
  return Number(h) * 60 + Number(m);
};
const hhmm = (value: number): string =>
  `${String(Math.floor(value / 60)).padStart(2, "0")}:${String(value % 60).padStart(2, "0")}`;

export function planPrompt(input: {
  day: string;
  weekday: string;
  dayStart: string;
  dayEnd: string;
  notBefore: string | null;
  busy: { start: string; end: string; title: string }[];
  candidates: PlanCandidate[];
}): { system: string; user: string } {
  const system = [
    "You plan one working day for the user of a todo app called Sloppanizer.",
    "You get the free time of the day and a ranked list of candidate todos (most important first).",
    "Propose time blocks: each block is for one candidate todo, inside the working hours, not overlapping busy time or each other, in 15 minute steps.",
    "Prefer overdue and due-soon todos and higher priority; give larger tasks 60 to 120 minutes and small ones 15 to 30; leave short breaks between long blocks; do not fill every minute.",
    "Only use todo ids from the candidate list. If nothing fits, return no blocks and say why in the note.",
    "Write the why and the note in the user's language as used in the todo titles, short and plain.",
  ].join("\n");
  const lines = [
    `Day: ${input.weekday} ${input.day}. Working hours ${input.dayStart} to ${input.dayEnd}.`,
    input.notBefore ? `It is ${input.notBefore} now: plan nothing before that.` : "",
    input.busy.length > 0
      ? `Busy:\n${input.busy.map((b) => `- ${b.start}-${b.end} ${b.title}`).join("\n")}`
      : "Busy: nothing yet.",
    "Candidates (ranked):",
    ...input.candidates.map((c) =>
      [
        `- id ${c.id}: ${c.title}`,
        c.priority ? `priority ${c.priority}` : "",
        c.dueOn ? `due ${c.dueOn}` : "",
        c.plannedOn ? `planned ${c.plannedOn}` : "",
        c.status !== "open" ? c.status.replace("_", " ") : "",
        c.labels.length > 0 ? `labels ${c.labels.join(", ")}` : "",
        c.reasons.length > 0 ? `(${c.reasons.join("; ")})` : "",
        c.notes ? `notes: ${c.notes}` : "",
      ]
        .filter(Boolean)
        .join(" | "),
    ),
  ];
  return { system, user: lines.filter(Boolean).join("\n") };
}

export function breakdownPrompt(input: { title: string; description: string; existing: string[] }): {
  system: string;
  user: string;
} {
  const system = [
    "You help the user of a todo app split one todo into subtasks.",
    "Give 3 to 8 concrete next actions, each a short imperative todo title (at most 80 characters), in the order they would be done.",
    "Skip steps the todo already has. Use the language of the todo.",
  ].join("\n");
  const user = [
    `Todo: ${input.title}`,
    input.description ? `Description:\n${input.description.slice(0, 4000)}` : "",
    input.existing.length > 0 ? `Already has:\n${input.existing.map((s) => `- ${s}`).join("\n")}` : "",
  ]
    .filter(Boolean)
    .join("\n\n");
  return { system, user };
}

// ---------- checking answers ----------

export interface CheckedBlock {
  todoId: number;
  title: string;
  start: string;
  end: string;
  why: string;
}

/**
 * The blocks of an answer that can be used: a candidate todo, valid times in 15 minute steps inside the
 * working hours (and not before now), free of busy time and of each other, each todo once.
 */
export function checkPlan(answer: PlanAnswer, context: PlanContext): CheckedBlock[] {
  const titles = new Map(context.candidates.map((c) => [c.id, c.title]));
  const lo = Math.max(minutes(context.dayStart), context.notBefore ? minutes(context.notBefore) : 0);
  const hi = minutes(context.dayEnd);
  const taken: [number, number][] = [...context.busy];
  const used = new Set<number>();
  const out: CheckedBlock[] = [];
  const valid = /^([01]\d|2[0-3]):[0-5]\d$/;
  for (const b of answer.blocks) {
    if (!titles.has(b.todoId) || used.has(b.todoId)) continue;
    if (!valid.test(b.start) || !valid.test(b.end)) continue;
    const s = Math.ceil(minutes(b.start) / 15) * 15;
    const e = Math.floor(minutes(b.end) / 15) * 15;
    if (e - s < 15 || s < lo || e > hi) continue;
    if (taken.some(([ts, te]) => s < te && e > ts)) continue;
    taken.push([s, e]);
    used.add(b.todoId);
    out.push({
      todoId: b.todoId,
      title: titles.get(b.todoId) ?? "",
      start: hhmm(s),
      end: hhmm(e),
      why: b.why.slice(0, 300),
    });
  }
  return out.toSorted((a, b) => a.start.localeCompare(b.start));
}

/** Usable steps: trimmed, 1 to 200 characters, no duplicates, at most 12. */
export function checkSteps(answer: BreakdownAnswer, existing: readonly string[] = []): string[] {
  const seen = new Set(existing.map((s) => s.trim().toLowerCase()));
  const out: string[] = [];
  for (const step of answer.steps) {
    const title = step
      .replace(/^[-*\d.)\s]+/, "")
      .trim()
      .slice(0, 200);
    if (!title || seen.has(title.toLowerCase())) continue;
    seen.add(title.toLowerCase());
    out.push(title);
    if (out.length === 12) break;
  }
  return out;
}
