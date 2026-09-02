import type { FloorState, Tile, Vec } from './types';

export function tileIndex(floor: FloorState, x: number, y: number): number {
  return y * floor.width + x;
}

export function inBounds(floor: FloorState, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < floor.width && y < floor.height;
}

export function tileAt(floor: FloorState, x: number, y: number): Tile | null {
  if (!inBounds(floor, x, y)) return null;
  return floor.tiles[tileIndex(floor, x, y)];
}

/** Walls and shut doors stop both movement and sight. */
export function blocksSight(tile: Tile | null): boolean {
  if (!tile) return true;
  if (tile.kind === 'wall' || tile.kind === 'void') return true;
  if (tile.kind === 'door' && !tile.open) return true;
  return false;
}

export function isWalkable(floor: FloorState, x: number, y: number): boolean {
  const tile = tileAt(floor, x, y);
  if (!tile) return false;
  if (tile.kind === 'wall' || tile.kind === 'void') return false;
  if (tile.kind === 'door' && !tile.open) return false;
  return true;
}

/**
 * Route planning is more permissive than stepping: a shut-but-unlocked door is
 * something both the operative and a guard can open on the way through, so it
 * must not make a region look unreachable. Only walls and *sealed* doors do.
 */
export function canPathThrough(floor: FloorState, x: number, y: number): boolean {
  const tile = tileAt(floor, x, y);
  if (!tile) return false;
  if (tile.kind === 'wall' || tile.kind === 'void') return false;
  if (tile.kind === 'door' && !tile.open && tile.lockedTurns > 0) return false;
  return true;
}

export function manhattan(a: Vec, b: Vec): number {
  return Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
}

export function chebyshev(a: Vec, b: Vec): number {
  return Math.max(Math.abs(a.x - b.x), Math.abs(a.y - b.y));
}

export function samePos(a: Vec, b: Vec): boolean {
  return a.x === b.x && a.y === b.y;
}

export const ORTHOGONAL: Vec[] = [
  { x: 0, y: -1 },
  { x: 1, y: 0 },
  { x: 0, y: 1 },
  { x: -1, y: 0 },
];

/** Bresenham line, used for line-of-sight checks. */
export function line(a: Vec, b: Vec): Vec[] {
  const points: Vec[] = [];
  let x0 = a.x;
  let y0 = a.y;
  const dx = Math.abs(b.x - x0);
  const dy = Math.abs(b.y - y0);
  const sx = x0 < b.x ? 1 : -1;
  const sy = y0 < b.y ? 1 : -1;
  let err = dx - dy;
  for (;;) {
    points.push({ x: x0, y: y0 });
    if (x0 === b.x && y0 === b.y) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x0 += sx;
    }
    if (e2 < dx) {
      err += dx;
      y0 += sy;
    }
  }
  return points;
}

/** True when nothing opaque sits strictly between `from` and `to`. */
export function hasLineOfSight(floor: FloorState, from: Vec, to: Vec): boolean {
  const path = line(from, to);
  for (let i = 1; i < path.length - 1; i++) {
    if (blocksSight(tileAt(floor, path[i].x, path[i].y))) return false;
  }
  return true;
}

/** Breadth-first path between two walkable tiles, excluding the start tile. */
export function findPath(floor: FloorState, from: Vec, to: Vec): Vec[] | null {
  if (!inBounds(floor, to.x, to.y)) return null;
  if (samePos(from, to)) return [];

  const start = tileIndex(floor, from.x, from.y);
  const goal = tileIndex(floor, to.x, to.y);
  const cameFrom = new Map<number, number>();
  const queue: number[] = [start];
  const seen = new Set<number>([start]);

  while (queue.length) {
    const current = queue.shift()!;
    if (current === goal) break;
    const cx = current % floor.width;
    const cy = Math.floor(current / floor.width);
    for (const dir of ORTHOGONAL) {
      const nx = cx + dir.x;
      const ny = cy + dir.y;
      if (!inBounds(floor, nx, ny)) continue;
      const ni = tileIndex(floor, nx, ny);
      if (seen.has(ni)) continue;
      // the goal itself may be a sealed door or terminal tile the caller wants to reach
      if (!canPathThrough(floor, nx, ny) && ni !== goal) continue;
      seen.add(ni);
      cameFrom.set(ni, current);
      queue.push(ni);
    }
  }

  if (!cameFrom.has(goal) && goal !== start) return null;

  const path: Vec[] = [];
  let node = goal;
  while (node !== start) {
    path.push({ x: node % floor.width, y: Math.floor(node / floor.width) });
    const prev = cameFrom.get(node);
    if (prev === undefined) return null;
    node = prev;
  }
  return path.reverse();
}
