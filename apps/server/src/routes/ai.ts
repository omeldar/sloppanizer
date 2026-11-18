import {
  AiBreakdownRequest,
  AiBreakdownResponse,
  AiPlanRequest,
  AiPlanResponse,
  AiStandupRequest,
  AiStandupResponse,
  AiSettings,
  API_PREFIX,
  BreakdownAnswer,
  checkSummary,
  PlanAnswer,
  StandupSummaryAnswer,
  UpdateAiSettings,
} from "@organizer/shared";
import { ApiError } from "../http/errors.ts";
import { enforce } from "../http/rate-limit.ts";
import {
  buildBreakdown,
  buildPlan,
  buildStandupSummary,
  type ClaudeRunner,
  claudeKey,
  getAiSettings,
  runClaude,
  updateAiSettings,
} from "../services/ai.ts";
import type { AuthServices } from "../services/auth/index.ts";
import { authOf, type App, ctxOf, type Deps } from "./types.ts";

/**
 * The in-app AI assistant. Settings belong to the browser session. Plan, breakdown and the standup summary answer with the
 * result when the account uses Claude (the server calls it), or with the prompt when it uses a local
 * Ollama (the browser runs it, the server cannot reach that machine).
 */
export function aiRoutes(app: App, deps: Deps, auth: AuthServices, claude: ClaudeRunner = runClaude): void {
  const tags = ["ai"];
  const { limiters, dataKey } = auth;

  app.get(
    `${API_PREFIX}/ai/settings`,
    {
      config: { access: "session" },
      schema: {
        tags,
        summary: "The AI assistant's settings (the key is never sent back)",
        response: { 200: AiSettings },
      },
    },
    async (request) => getAiSettings(deps.db, authOf(request).accountId),
  );

  app.patch(
    `${API_PREFIX}/ai/settings`,
    {
      config: { access: "session" },
      schema: {
        tags,
        summary: "Change the AI assistant's settings",
        body: UpdateAiSettings,
        response: { 200: AiSettings },
      },
    },
    async (request) =>
      updateAiSettings(deps.db, deps.clock, dataKey, authOf(request).accountId, request.body),
  );

  /** The account's settings when the assistant is on, else a 409 saying how to turn it on. */
  const ready = (accountId: number) => {
    const settings = getAiSettings(deps.db, accountId);
    if (settings.provider === "none") {
      throw new ApiError("conflict", "The AI assistant is off. Turn it on under Settings, AI assistant.");
    }
    enforce(limiters.aiByAccount.take(String(accountId)), "Too many AI requests this hour. Try again later.");
    return settings;
  };

  app.post(
    `${API_PREFIX}/ai/plan`,
    {
      schema: {
        tags,
        summary: "Propose time blocks for a day from Next up and the free time (not saved)",
        body: AiPlanRequest,
        response: { 200: AiPlanResponse },
      },
    },
    async (request) => {
      const { accountId } = authOf(request);
      const settings = ready(accountId);
      const { prompt, context } = buildPlan(ctxOf(request, deps), settings, request.body.day);
      if (settings.provider === "ollama") return { mode: "prompt" as const, prompt, context };
      const apiKey = claudeKey(deps.db, dataKey, accountId);
      if (!apiKey)
        throw new ApiError("conflict", "No Claude API key yet. Add one under Settings, AI assistant.");
      const answer = await claude({ apiKey, model: settings.claudeModel, prompt, schema: PlanAnswer });
      return { mode: "result" as const, answer, context };
    },
  );

  app.post(
    `${API_PREFIX}/ai/breakdown`,
    {
      schema: {
        tags,
        summary: "Propose subtasks for a todo (not saved)",
        body: AiBreakdownRequest,
        response: { 200: AiBreakdownResponse },
      },
    },
    async (request) => {
      const { accountId } = authOf(request);
      const settings = ready(accountId);
      const { prompt } = buildBreakdown(ctxOf(request, deps), request.body.todoId);
      if (settings.provider === "ollama") return { mode: "prompt" as const, prompt };
      const apiKey = claudeKey(deps.db, dataKey, accountId);
      if (!apiKey)
        throw new ApiError("conflict", "No Claude API key yet. Add one under Settings, AI assistant.");
      const answer = await claude({ apiKey, model: settings.claudeModel, prompt, schema: BreakdownAnswer });
      return { mode: "result" as const, answer };
    },
  );

  app.post(
    `${API_PREFIX}/ai/standup`,
    {
      schema: {
        tags,
        summary: "Sum up a standup's open list in a few lines to read out (not saved)",
        body: AiStandupRequest,
        response: { 200: AiStandupResponse },
      },
    },
    async (request) => {
      const { accountId } = authOf(request);
      const settings = ready(accountId);
      const prompt = buildStandupSummary(ctxOf(request, deps), request.body.meetingId, request.body.kinds);
      if (settings.provider === "ollama") return { mode: "prompt" as const, prompt };
      const apiKey = claudeKey(deps.db, dataKey, accountId);
      if (!apiKey)
        throw new ApiError("conflict", "No Claude API key yet. Add one under Settings, AI assistant.");
      const answer = await claude({
        apiKey,
        model: settings.claudeModel,
        prompt,
        schema: StandupSummaryAnswer,
      });
      return { mode: "result" as const, answer: checkSummary(answer) };
    },
  );
}
