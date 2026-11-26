import type { Me, Space } from "@organizer/shared";
import { z } from "zod";
import { type Api, ApiError, ToolError } from "./api.ts";
import type { SharedRef } from "./format.ts";

/**
 * Shared projects in the tools. Each one is its own space with its own todo numbers, so a todo there is
 * written S<project id>#<todo id> ("S7#12"), and every call about it goes to that project (Api.inSpace).
 * The account's own todos stay #12. The server decides what the token may see: only projects the
 * account is a member of, with the token's scope.
 */

const SHARED_TODO = /^s(\d{1,10})#(\d{1,10})$/i;
const OWN_TODO = /^#?(\d{1,10})$/;
const SHARED_PROJECT = /^s(\d{1,10})$/i;

/** A todo: an own one by number, or one in a shared project as "S7#12". */
export const TodoRefInput = z
  .union([
    z.number().int().positive(),
    z
      .string()
      .trim()
      .regex(
        /^(#?\d{1,10}|[sS]\d{1,10}#\d{1,10})$/,
        'A todo is its number (142 or "#142"), or "S7#12" for todo 12 of shared project 7.',
      ),
  ])
  .describe(
    'Todo: its number (142 or "#142"), or "S7#12" for a todo in shared project 7 (as lists show it).',
  );
export type TodoRefInput = z.infer<typeof TodoRefInput>;

/** Who the todo is assigned to (shared projects only): "me", a username, or null to clear it. */
export const AssigneeInput = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .nullable()
  .describe(
    'Shared projects only: "me" or the username of a member (list_projects shows them); null unassigns it. ' +
      "Own todos have no assignee (they are always yours).",
  );

/** Assignee filter of the lists. */
export const AssigneeFilterInput = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .optional()
  .describe(
    'Todos in shared projects by assignee: "me", "none" (unassigned), "anyone" or a username. ' +
      'Your own todos count as yours: they are listed for "me" and "anyone" only.',
  );

/** Whose todos a list covers. */
export const ScopeInput = z
  .enum(["all", "own", "shared"])
  .default("all")
  .describe(
    "all (default): your own todos and those of the shared projects you are a member of; own; shared.",
  );

export function parseTodoRef(input: TodoRefInput): { spaceId: number | null; id: number } {
  if (typeof input === "number") return { spaceId: null, id: input };
  const shared = SHARED_TODO.exec(input);
  if (shared) return { spaceId: Number(shared[1]), id: Number(shared[2]) };
  const own = OWN_TODO.exec(input);
  if (own) return { spaceId: null, id: Number(own[1]) };
  throw new ToolError(`"${input}" is not a todo. Write 142, "#142", or "S7#12" for a shared project.`);
}

export const refOf = (space: Pick<Space, "id" | "name">): SharedRef => ({ id: space.id, name: space.name });

/**
 * The shared projects of the account. An older server that does not let tokens list them answers 403;
 * then there are none to add.
 */
export async function sharedProjects(api: Api): Promise<Space[]> {
  try {
    return await api.get<Space[]>("/spaces");
  } catch (error) {
    if (error instanceof ApiError && (error.status === 403 || error.status === 404)) return [];
    throw error;
  }
}

async function spaceById(api: Api, id: number): Promise<Space> {
  try {
    return await api.get<Space>(`/spaces/${id}`);
  } catch (error) {
    if (error instanceof ApiError && (error.status === 404 || error.status === 403)) {
      throw new ToolError(`There is no shared project S${id} you are a member of. list_projects shows them.`);
    }
    throw error;
  }
}

export interface TodoTarget {
  /** The API to call about this todo (inside its shared project, if it is in one). */
  api: Api;
  id: number;
  /** The shared project it is in, or undefined for an own todo. */
  space?: SharedRef;
}

/** The API of the account itself (null) or of one of its shared projects, checked to exist. */
export async function placeOf(api: Api, spaceId: number | null): Promise<Omit<TodoTarget, "id">> {
  if (spaceId === null) return { api };
  const space = await spaceById(api, spaceId);
  return { api: api.inSpace(space.id), space: refOf(space) };
}

/** Where a todo reference points: the account itself, or a shared project it is a member of. */
export async function todoTarget(api: Api, input: TodoRefInput): Promise<TodoTarget> {
  const { spaceId, id } = parseTodoRef(input);
  return { ...(await placeOf(api, spaceId)), id };
}

/** A shared project named by "S7", its name or its project's slug (case-insensitive), or null. */
export function findShared(spaces: readonly Space[], input: number | string): Space | null {
  if (typeof input === "number") return null;
  const key = input.trim().toLowerCase();
  const byId = SHARED_PROJECT.exec(key);
  if (byId) return spaces.find((s) => s.id === Number(byId[1])) ?? null;
  return spaces.find((s) => s.name.toLowerCase() === key || s.projectSlug === key) ?? null;
}

/** Whether the input names a shared project by id ("S7"). */
export const isSharedProjectId = (input: number | string | null | undefined): boolean =>
  typeof input === "string" && SHARED_PROJECT.test(input.trim());

/** The username for an assignee input: "me" is the token's own account. */
export async function assigneeName(
  api: Api,
  input: string | null | undefined,
): Promise<string | null | undefined> {
  if (input === undefined || input === null) return input;
  if (input.toLowerCase() !== "me") return input;
  return (await api.get<Me>("/me")).account.username;
}

/** The assignee query value for the API, or undefined for "anyone". */
export const assigneeQuery = (input: string | undefined): string | undefined =>
  input === undefined || input.toLowerCase() === "anyone" ? undefined : input.toLowerCase();

/** Own todos belong in a list with this assignee filter (they are always yours). */
export const ownMatches = (input: string | undefined): boolean =>
  input === undefined || ["me", "anyone"].includes(input.toLowerCase());
