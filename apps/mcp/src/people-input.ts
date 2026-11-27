import { type PersonRef, PersonRef as PersonRefSchema } from "@organizer/shared";
import { z } from "zod";
import { ToolError } from "./api.ts";

/** A person in a tool input: an id, "First Last" or the object form (used by the todo and meeting tools). */
export const PersonInput = z.union([
  z.number().int().positive().describe("Person id from list_people."),
  z
    .string()
    .trim()
    .min(3)
    .describe('"First Last". The last word is the last name; use the object form for multi-word last names.'),
  PersonRefSchema.options[1],
]);
export type PersonInput = z.infer<typeof PersonInput>;

export const People = (what: string) =>
  z
    .array(PersonInput)
    .max(50)
    .describe(
      `${what} By name, the person is found (case-insensitive) or created if missing. If several people share the name, pass the person id instead.`,
    );

export function toPersonRef(input: PersonInput): PersonRef {
  if (typeof input === "number") return { personId: input };
  if (typeof input === "object") return input;
  const words = input.split(/\s+/);
  if (words.length < 2) {
    throw new ToolError(`"${input}" needs a first and a last name, e.g. "Anna Meier", or pass a person id.`);
  }
  return { firstName: words.slice(0, -1).join(" "), lastName: words.at(-1) ?? "" };
}

export const toPeople = (list: readonly PersonInput[] | undefined) => list?.map(toPersonRef);
