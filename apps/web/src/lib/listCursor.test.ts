import { describe, expect, it } from "vitest";
import { stepCursor } from "./listCursor.ts";

describe("stepCursor", () => {
  it("starts at the first row going down and the last going up when nothing is selected", () => {
    expect(stepCursor([4, 5, 6], null, 1)).toBe(4);
    expect(stepCursor([4, 5, 6], null, -1)).toBe(6);
  });

  it("moves one step and stops at the ends", () => {
    expect(stepCursor([4, 5, 6], 5, 1)).toBe(6);
    expect(stepCursor([4, 5, 6], 6, 1)).toBe(6);
    expect(stepCursor([4, 5, 6], 4, -1)).toBe(4);
  });

  it("starts over when the selected row left the list, and gives null for an empty list", () => {
    expect(stepCursor([4, 5, 6], 9, 1)).toBe(4);
    expect(stepCursor([], 4, 1)).toBeNull();
  });
});
