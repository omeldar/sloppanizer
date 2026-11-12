import { describe, expect, it } from "vitest";
import { type Placed, planMove, type PositionPatch } from "./positions.ts";

/** The order the server returns after the patches (position, then id). */
function orderAfter(column: readonly Placed[], movedId: number, patches: readonly PositionPatch[]): number[] {
  const byId = new Map(patches.map((p) => [p.id, p.position]));
  const items = column.some((c) => c.id === movedId) ? column : [...column, { id: movedId, position: 0 }];
  return items
    .map((item) => ({ id: item.id, position: byId.get(item.id) ?? item.position }))
    .toSorted((a, b) => a.position - b.position || a.id - b.id)
    .map((item) => item.id);
}

const col = (...pairs: [number, number][]): Placed[] => pairs.map(([id, position]) => ({ id, position }));

describe("planMove", () => {
  it("puts the todo at the midpoint between its new neighbours", () => {
    const column = col([1, 0], [2, 10], [3, 20]);
    expect(planMove(column, 9, 2)).toEqual([{ id: 9, position: 15 }]);
  });

  it("goes below the first or above the last one at the ends", () => {
    const column = col([1, 4], [2, 8]);
    expect(planMove(column, 9, 0)).toEqual([{ id: 9, position: 3 }]);
    expect(planMove(column, 9, 2)).toEqual([{ id: 9, position: 9 }]);
  });

  it("takes any position in an empty column", () => {
    expect(planMove([], 9, 0)).toEqual([{ id: 9, position: 0 }]);
  });

  it("moves inside the same column, ignoring its own old slot", () => {
    const column = col([1, 0], [2, 10], [3, 20], [4, 30]);
    const patches = planMove(column, 1, 2);
    expect(patches).toEqual([{ id: 1, position: 25 }]);
    expect(orderAfter(column, 1, patches)).toEqual([2, 3, 1, 4]);
  });

  it("spreads out neighbours that share a position (every todo starts at 0)", () => {
    const column = col([3, 0], [5, 0], [8, 0], [9, 0]);
    const patches = planMove(column, 9, 1);
    expect(orderAfter(column, 9, patches)).toEqual([3, 9, 5, 8]);
    // The shorter side moves: only #3 changes besides the moved todo.
    expect(patches.map((p) => p.id).toSorted()).toEqual([3, 9]);
  });

  it("spreads the side after the slot when that side is shorter", () => {
    const column = col([1, 0], [2, 0], [3, 0], [4, 0], [5, 0]);
    const patches = planMove(column, 7, 4);
    expect(orderAfter(column, 7, patches)).toEqual([1, 2, 3, 4, 7, 5]);
    expect(patches.map((p) => p.id).toSorted()).toEqual([5, 7]);
  });

  it("stops spreading at the first neighbour that already has room", () => {
    const column = col([1, -5], [2, 0], [3, 0], [4, 7]);
    const patches = planMove(column, 9, 2);
    expect(orderAfter(column, 9, patches)).toEqual([1, 2, 9, 3, 4]);
    expect(patches).toHaveLength(2);
  });

  it("clamps an index past the end", () => {
    expect(planMove(col([1, 2]), 9, 99)).toEqual([{ id: 9, position: 3 }]);
  });
});
