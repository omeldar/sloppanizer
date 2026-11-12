/** A todo in a board column, ordered by position, then id (the server's order for sort=position). */
export interface Placed {
  id: number;
  position: number;
}

export interface PositionPatch {
  id: number;
  position: number;
}

/**
 * Positions that put `movedId` at `index` of `column` (the column without the moved todo).
 * Usually one patch: the midpoint between the new neighbours. When the neighbours share a position (every
 * todo starts at 0) there is no room between them, so the shorter side is spread out as well, touching as
 * few other todos as possible.
 */
export function planMove(column: readonly Placed[], movedId: number, index: number): PositionPatch[] {
  const others = column.filter((item) => item.id !== movedId);
  const at = Math.max(0, Math.min(index, others.length));
  const prev = others[at - 1];
  const next = others[at];

  if (!prev && !next) return [{ id: movedId, position: 0 }];
  if (!prev && next) return [{ id: movedId, position: next.position - 1 }];
  if (prev && !next) return [{ id: movedId, position: prev.position + 1 }];
  if (!prev || !next) return [];

  const mid = (prev.position + next.position) / 2;
  if (mid > prev.position && mid < next.position) return [{ id: movedId, position: mid }];

  const down = spreadBefore(others.slice(0, at).toReversed(), next.position);
  const up = spreadAfter(others.slice(at), prev.position);
  if (down.length <= up.length) {
    const newPrev = down.find((p) => p.id === prev.id)?.position ?? prev.position;
    return [...down.toReversed(), { id: movedId, position: (newPrev + next.position) / 2 }];
  }
  const newNext = up.find((p) => p.id === next.id)?.position ?? next.position;
  return [{ id: movedId, position: (prev.position + newNext) / 2 }, ...up];
}

/** Walks up from the new slot and lowers each item until it sits clearly below the one after it. */
function spreadBefore(nearestFirst: readonly Placed[], ceiling: number): PositionPatch[] {
  const patches: PositionPatch[] = [];
  let limit = ceiling;
  for (const item of nearestFirst) {
    if (item.position < limit) break;
    limit -= 1;
    patches.push({ id: item.id, position: limit });
  }
  return patches;
}

/** Walks down from the new slot and raises each item until it sits clearly above the one before it. */
function spreadAfter(nearestFirst: readonly Placed[], floor: number): PositionPatch[] {
  const patches: PositionPatch[] = [];
  let limit = floor;
  for (const item of nearestFirst) {
    if (item.position > limit) break;
    limit += 1;
    patches.push({ id: item.id, position: limit });
  }
  return patches;
}
