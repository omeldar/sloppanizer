import {
  AiBreakdownResponse,
  AiPlanResponse,
  type AiPrompt,
  AiSettings,
  BreakdownAnswer,
  type CheckedBlock,
  checkPlan,
  checkSteps,
  checkSummary,
  PlanAnswer,
  AiStandupResponse,
  StandupSummaryAnswer,
  type StandupKind,
  type UpdateAiSettings,
} from "@organizer/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { z } from "zod";
import { api, ApiError } from "./api.ts";

const KEY = ["aiSettings"] as const;

export const useAiSettings = (enabled = true) =>
  useQuery({ queryKey: KEY, queryFn: () => api(AiSettings, "/ai/settings"), enabled, staleTime: 60_000 });

export function useUpdateAiSettings() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (patch: UpdateAiSettings) =>
      api(AiSettings, "/ai/settings", { method: "PATCH", body: patch }),
    onSuccess: (settings) => client.setQueryData(KEY, settings),
  });
}

const ollamaHelp = (url: string) =>
  `Ollama is not reachable at ${url}. Start Ollama and let it accept this site: set the environment variable ` +
  `OLLAMA_ORIGINS=${window.location.origin} and restart Ollama.`;

/** Runs a prompt on the local Ollama of this machine and returns the answer checked against `schema`. */
export async function runOllama<T>(settings: AiSettings, prompt: AiPrompt, schema: z.ZodType<T>): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${settings.ollamaUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        model: settings.ollamaModel,
        stream: false,
        format: prompt.schema,
        options: { temperature: 0.2 },
        messages: [
          { role: "system", content: prompt.system },
          { role: "user", content: `${prompt.user}\n\nAnswer with JSON only.` },
        ],
      }),
    });
  } catch {
    throw new ApiError(0, "network", ollamaHelp(settings.ollamaUrl));
  }
  if (response.status === 404) {
    throw new ApiError(
      404,
      "not_found",
      `Ollama has no model ${settings.ollamaModel}. Pull it: ollama pull ${settings.ollamaModel}`,
    );
  }
  if (!response.ok) throw new ApiError(response.status, "internal", `Ollama answered ${response.status}.`);
  const body = (await response.json()) as { message?: { content?: string } };
  try {
    return schema.parse(JSON.parse(body.message?.content ?? ""));
  } catch {
    throw new ApiError(
      200,
      "bad_response",
      "The local model's answer could not be read. Try again or use a larger model.",
    );
  }
}

/** Plan my day: proposed blocks, already checked against the day's free time. */
export async function planDay(
  day: string,
  settings: AiSettings,
): Promise<{ blocks: CheckedBlock[]; note: string }> {
  const response = await api(AiPlanResponse, "/ai/plan", { method: "POST", body: { day } });
  const answer =
    response.mode === "result" ? response.answer : await runOllama(settings, response.prompt, PlanAnswer);
  return { blocks: checkPlan(answer, response.context), note: answer.note };
}

/** Break it down: proposed subtask titles, without ones the todo has. */
export async function breakDown(
  todoId: number,
  existing: readonly string[],
  settings: AiSettings,
): Promise<{ steps: string[]; note: string }> {
  const response = await api(AiBreakdownResponse, "/ai/breakdown", { method: "POST", body: { todoId } });
  const answer =
    response.mode === "result"
      ? response.answer
      : await runOllama(settings, response.prompt, BreakdownAnswer);
  return { steps: checkSteps(answer, existing), note: answer.note };
}

/**
 * Sum up: a few lines to read out at a standup, from its open list (only the given kinds). Runs only
 * when the user asks; nothing is saved.
 */
export async function summarizeStandup(
  meetingId: number,
  kinds: readonly StandupKind[] | undefined,
  settings: AiSettings,
): Promise<StandupSummaryAnswer> {
  const response = await api(AiStandupResponse, "/ai/standup", {
    method: "POST",
    body: { meetingId, ...(kinds && kinds.length > 0 && { kinds }) },
  });
  const answer =
    response.mode === "result"
      ? response.answer
      : await runOllama(settings, response.prompt, StandupSummaryAnswer);
  return checkSummary(answer);
}

/** Whether this machine's Ollama answers and has the model (for the settings page). */
export async function testOllama(url: string, model: string): Promise<string> {
  try {
    const response = await fetch(`${url.replace(/\/+$/, "")}/api/tags`);
    const body = (await response.json()) as { models?: { name: string }[] };
    const names = (body.models ?? []).map((m) => m.name);
    return names.includes(model) || names.includes(`${model}:latest`)
      ? `Ollama answers and has ${model}.`
      : `Ollama answers, but ${model} is not pulled yet (it has ${names.length} model${names.length === 1 ? "" : "s"}).`;
  } catch {
    return ollamaHelp(url);
  }
}
