import { describe, expect, it } from "vitest";
import { ApiError } from "../../lib/api.ts";
import { deleteProblem } from "./PersonPage.tsx";

const conflict = (n: number) => new ApiError(409, "conflict", "Still linked.", { linkedTodos: n });

describe("deleting a linked person", () => {
  it("says how many todos still hold the person and what to do", () => {
    expect(deleteProblem(conflict(3))).toBe("Linked to 3 todos. Remove them from those todos first.");
    expect(deleteProblem(conflict(1))).toBe("Linked to 1 todo. Remove them from that todo first.");
  });

  it("passes other errors through", () => {
    expect(deleteProblem(new ApiError(0, "network", "organizer is not reachable."))).toBe(
      "organizer is not reachable.",
    );
  });
});
