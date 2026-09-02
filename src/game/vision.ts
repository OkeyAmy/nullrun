import { BALANCE } from './config';
import { chebyshev, hasLineOfSight, inBounds, tileAt, tileIndex } from './grid';
import type { Camera, FloorState, Guard, Vec } from './types';

export interface Observer {
  x: number;
  y: number;
  facing: { dx: number; dy: number };
  visionRange: number;
  coneHalfAngleDeg: number;
  /** Thermal units keep their full range through a blackout. */
  seesInBlackout?: boolean;
}

export interface VisionContext {
  /** Turns of blackout remaining; shortens every cone. */
  powerOutTurns: number;
}

export function effectiveRange(
  base: number,
  ctx: VisionContext,
  seesInBlackout = false,
): number {
  if (ctx.powerOutTurns > 0 && !seesInBlackout) {
    return Math.max(1, Math.round(base * BALANCE.vision.powerOutRangeMultiplier));
  }
  return base;
}

/** Is `target` inside this observer's cone, ignoring cover rules? */
export function inVisionCone(
  floor: FloorState,
  observer: Observer,
  target: Vec,
  ctx: VisionContext,
): boolean {
  const range = effectiveRange(observer.visionRange, ctx, observer.seesInBlackout);
  const dx = target.x - observer.x;
  const dy = target.y - observer.y;
  const distance = Math.hypot(dx, dy);
  if (distance > range) return false;
  if (distance === 0) return true;

  // anything standing right next to an observer is noticed regardless of facing
  if (chebyshev({ x: observer.x, y: observer.y }, target) <= BALANCE.guard.adjacencyRange) {
    return hasLineOfSight(floor, { x: observer.x, y: observer.y }, target);
  }

  const facingLength = Math.hypot(observer.facing.dx, observer.facing.dy) || 1;
  const dot = (dx * observer.facing.dx + dy * observer.facing.dy) / (distance * facingLength);
  const angleDeg = (Math.acos(Math.max(-1, Math.min(1, dot))) * 180) / Math.PI;
  if (angleDeg > observer.coneHalfAngleDeg) return false;

  return hasLineOfSight(floor, { x: observer.x, y: observer.y }, target);
}

/** Cover only helps at a distance — you cannot hide behind a crate someone is standing on. */
export function coverProtects(floor: FloorState, observer: Observer, target: Vec): boolean {
  const tile = tileAt(floor, target.x, target.y);
  if (!tile || tile.kind !== 'cover') return false;
  const distance = chebyshev({ x: observer.x, y: observer.y }, target);
  return distance > BALANCE.vision.coverProtectionMinDistance;
}

export function observerSees(
  floor: FloorState,
  observer: Observer,
  target: Vec,
  ctx: VisionContext,
): boolean {
  if (!inVisionCone(floor, observer, target, ctx)) return false;
  if (coverProtects(floor, observer, target)) return false;
  return true;
}

export function guardSees(floor: FloorState, guard: Guard, target: Vec, ctx: VisionContext): boolean {
  if (guard.stunTurns > 0) return false;
  return observerSees(floor, guard, target, ctx);
}

export function cameraSees(
  floor: FloorState,
  camera: Camera,
  target: Vec,
  ctx: VisionContext,
): boolean {
  if (camera.disabledTurns > 0) return false;
  return observerSees(floor, camera, target, ctx);
}

/** Every tile an observer currently covers — used for rendering cones and scoring risk. */
export function coneTiles(floor: FloorState, observer: Observer, ctx: VisionContext): Vec[] {
  const range = effectiveRange(observer.visionRange, ctx, observer.seesInBlackout);
  const out: Vec[] = [];
  for (let y = observer.y - range; y <= observer.y + range; y++) {
    for (let x = observer.x - range; x <= observer.x + range; x++) {
      if (!inBounds(floor, x, y)) continue;
      const target = { x, y };
      if (inVisionCone(floor, observer, target, ctx)) out.push(target);
    }
  }
  return out;
}

/** Recompute what the operative can personally see, and fold it into fog of war. */
export function updateOperativeVisibility(floor: FloorState, player: Vec): void {
  const radius = BALANCE.operative.sightRadius;
  floor.visible.fill(false);
  for (let y = player.y - radius; y <= player.y + radius; y++) {
    for (let x = player.x - radius; x <= player.x + radius; x++) {
      if (!inBounds(floor, x, y)) continue;
      if (Math.hypot(x - player.x, y - player.y) > radius) continue;
      if (!hasLineOfSight(floor, player, { x, y })) continue;
      const i = tileIndex(floor, x, y);
      floor.visible[i] = true;
      floor.discovered[i] = true;
    }
  }
}

/**
 * How dangerous is a tile right now? Returns the observers covering it, so the
 * agent-facing tools can explain *why* a route is risky rather than just
 * returning a number.
 */
export interface TileThreat {
  watchedBy: string[];
  /** 0 = safe, higher = more eyes / closer eyes. */
  risk: number;
  inCover: boolean;
}

export function tileThreat(floor: FloorState, target: Vec, ctx: VisionContext): TileThreat {
  const watchedBy: string[] = [];
  let risk = 0;

  for (const guard of floor.guards) {
    if (guard.stunTurns > 0) continue;
    if (!inVisionCone(floor, guard, target, ctx)) continue;
    const protectedByCover = coverProtects(floor, guard, target);
    if (protectedByCover) continue;
    watchedBy.push(guard.id);
    const distance = Math.max(1, chebyshev(guard, target));
    risk += guard.state === 'patrol' ? 10 / distance + 4 : 16 / distance + 8;
  }

  for (const camera of floor.cameras) {
    if (camera.disabledTurns > 0) continue;
    if (!inVisionCone(floor, camera, target, ctx)) continue;
    if (coverProtects(floor, camera, target)) continue;
    watchedBy.push(camera.id);
    risk += 6;
  }

  const tile = tileAt(floor, target.x, target.y);
  return {
    watchedBy,
    risk: Math.round(risk),
    inCover: tile?.kind === 'cover',
  };
}
