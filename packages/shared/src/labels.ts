import { z } from "zod";

export const SCOPE_SEPARATOR = "::";

export interface ParsedLabelName {
  /** Everything before the last "::", or null for a plain label. */
  scope: string | null;
  value: string;
}

/**
 * Splits a label name GitLab style: the scope is everything before the LAST "::".
 * "priority::high" -> priority / high, "env::prod::eu" -> env::prod / eu, "homelab" -> null / homelab.
 */
export function parseLabelName(name: string): ParsedLabelName {
  const index = name.lastIndexOf(SCOPE_SEPARATOR);
  if (index === -1) return { scope: null, value: name };
  return { scope: name.slice(0, index), value: name.slice(index + SCOPE_SEPARATOR.length) };
}

/** Why a label name is not usable, or null when it is fine. */
export function labelNameProblem(name: string): string | null {
  if (name.trim() !== name) return "Remove spaces at the start and end of the label name.";
  if (name.length === 0) return "Give the label a name.";
  if (name.length > 100) return "Keep the label name at 100 characters or fewer.";
  if (name.includes(",")) return "Label names cannot contain commas (lists use them as separators).";
  const { scope, value } = parseLabelName(name);
  if (scope !== null) {
    if (scope.trim().length === 0) return 'Put a scope before "::", e.g. priority::high.';
    if (value.trim().length === 0) return 'Put a value after the last "::", e.g. priority::high.';
    if (scope.endsWith(":") || value.startsWith(":"))
      return "Use exactly two colons between scope and value.";
  }
  return null;
}

export const LabelName = z.string().superRefine((name, ctx) => {
  const problem = labelNameProblem(name);
  if (problem) ctx.addIssue({ code: "custom", message: problem });
});

/** Scopes compare case-insensitively, like label names. */
export function scopeKey(scope: string): string {
  return scope.toLowerCase();
}

/** Scopes that appear more than once in the given names (a request may set only one label per scope). */
export function findScopeConflicts(names: readonly string[]): string[] {
  const seen = new Map<string, { scope: string; names: Set<string> }>();
  for (const name of names) {
    const { scope } = parseLabelName(name);
    if (scope === null) continue;
    const key = scopeKey(scope);
    const entry = seen.get(key) ?? { scope, names: new Set<string>() };
    entry.names.add(name.toLowerCase());
    seen.set(key, entry);
  }
  return [...seen.values()].filter((entry) => entry.names.size > 1).map((entry) => entry.scope);
}

export interface LabelChange {
  /** Replaces the whole set when given. */
  set?: readonly string[] | undefined;
  add?: readonly string[] | undefined;
  remove?: readonly string[] | undefined;
}

/**
 * Applies a label change to the current names. Adding a scoped label removes the other labels of
 * its scope (exclusivity). Matching is case-insensitive; the spelling of the added name wins.
 * Callers reject conflicting requests first (findScopeConflicts).
 */
export function applyLabelChange(current: readonly string[], change: LabelChange): string[] {
  let result = change.set ? dedupe(change.set) : dedupe(current);
  for (const name of change.add ?? []) {
    const lower = name.toLowerCase();
    const { scope } = parseLabelName(name);
    result = result.filter((existing) => {
      if (existing.toLowerCase() === lower) return false;
      const other = parseLabelName(existing).scope;
      return scope === null || other === null || scopeKey(other) !== scopeKey(scope);
    });
    result.push(name);
  }
  const removed = new Set((change.remove ?? []).map((name) => name.toLowerCase()));
  return result.filter((name) => !removed.has(name.toLowerCase()));
}

function dedupe(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const name of names) {
    const lower = name.toLowerCase();
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(name);
  }
  return out;
}

export interface SortableLabel {
  name: string;
  scope: string | null;
  value: string;
  rank: number | null;
}

/** Scoped labels first (by scope, then rank with nulls last, then value), then plain labels by name. */
export function compareLabels(a: SortableLabel, b: SortableLabel): number {
  if (a.scope !== null && b.scope === null) return -1;
  if (a.scope === null && b.scope !== null) return 1;
  if (a.scope !== null && b.scope !== null) {
    const byScope = compareText(a.scope, b.scope);
    if (byScope !== 0) return byScope;
    if (a.rank !== b.rank) {
      if (a.rank === null) return 1;
      if (b.rank === null) return -1;
      return a.rank - b.rank;
    }
    return compareText(a.value, b.value);
  }
  return compareText(a.name, b.name);
}

export function sortLabels<T extends SortableLabel>(labels: readonly T[]): T[] {
  return labels.toSorted(compareLabels);
}

function compareText(a: string, b: string): number {
  const lower = a.toLowerCase().localeCompare(b.toLowerCase(), "en");
  return lower !== 0 ? lower : a.localeCompare(b, "en");
}

export const PRIORITY_SCOPE = "priority";
export const PRIORITIES = ["critical", "high", "medium", "low"] as const;
export type Priority = (typeof PRIORITIES)[number];

/** Seed labels of the priority scope. */
export const PRIORITY_LABELS = [
  { name: "priority::critical", color: "#F2555A", rank: 0 },
  { name: "priority::high", color: "#FFB224", rank: 1 },
  { name: "priority::medium", color: "#9AA4B2", rank: 2 },
  { name: "priority::low", color: "#5B6573", rank: 3 },
] as const;

/** The todo's priority from its priority:: label, or null when it has none (or an unknown value). */
export function priorityOf(labels: readonly { name: string }[]): Priority | null {
  for (const label of labels) {
    const { scope, value } = parseLabelName(label.name);
    if (scope === null || scopeKey(scope) !== PRIORITY_SCOPE) continue;
    const priority = PRIORITIES.find((p) => p === value.toLowerCase());
    if (priority) return priority;
  }
  return null;
}
