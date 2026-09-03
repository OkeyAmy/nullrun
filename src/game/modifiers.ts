import { ARCHETYPES, archetypePool } from './archetypes';
import type { FloorState, GameState } from './types';

/**
 * Per-floor complications.
 *
 * Every floor used to be the same request — take the cores, walk to the exit —
 * with a slightly bigger map and one more guard. Knowing exactly what floor 4
 * would be after playing floor 1 is the opposite of a reason to keep going.
 *
 * A modifier is drawn and announced when the floor opens, so it is something
 * to plan around rather than a surprise that invalidates a plan. They change
 * the shape of the problem, not the size of it.
 */
export interface FloorModifier {
  id: string;
  name: string;
  /** Shown to the player and handed to the agent, so both can plan. */
  brief: string;
  apply(floor: FloorState, state: GameState): void;
}

export const MODIFIERS: FloorModifier[] = [
  {
    id: 'nominal',
    name: 'Nominal shift',
    brief: 'Nothing unusual on this floor. Standard rotation, standard posture.',
    apply: () => {},
  },
  {
    id: 'skeleton',
    name: 'Skeleton crew',
    brief:
      'Half the usual staff on shift, but the ones who are here are hunters. Fewer cones, far less forgiving when one finds you.',
    apply: (floor) => {
      if (floor.guards.length > 1) floor.guards.splice(0, 1);
      const hunter = ARCHETYPES.hunter;
      for (const guard of floor.guards) {
        guard.archetype = hunter.id;
        guard.visionRange = hunter.visionRange;
        guard.coneHalfAngleDeg = hunter.coneHalfAngleDeg;
        guard.patrolSpeed = hunter.patrolSpeed;
        guard.huntSpeed = hunter.huntSpeed;
      }
    },
  },
  {
    id: 'brownout',
    name: 'Rolling brownout',
    brief:
      'The grid on this floor is already failing. You arrive in the dark and every cone is short — but it will come back, so move.',
    apply: (_floor, state) => {
      state.powerOutTurns = 6;
    },
  },
  {
    id: 'hot',
    name: 'Hot floor',
    brief:
      'Word travelled ahead of you. This floor opens already tightened, and the clock is further along than usual.',
    apply: (_floor, state) => {
      state.escalation += 30;
    },
  },
  {
    id: 'vault',
    name: 'Vault rotation',
    brief:
      'Assets are being moved today: more intel lying loose than normal, and it is worth more. A greedy run pays here.',
    apply: (floor) => {
      for (const item of floor.loot) item.value = Math.round(item.value * 1.8);
    },
  },
  {
    id: 'drill',
    name: 'Lockdown drill',
    brief:
      'Every door on the floor starts shut. Expect to spend action points opening the building, or have the agent cycle them ahead of you.',
    apply: (floor) => {
      for (const tile of floor.tiles) {
        if (tile.kind === 'door') tile.open = false;
      }
    },
  },
  {
    id: 'unwatched',
    name: 'Ghost shift',
    brief:
      'The camera network on this floor is down for maintenance — and they put extra bodies on the ground to make up for it.',
    apply: (floor) => {
      floor.cameras.length = 0;
      const first = floor.guards[0];
      if (!first) return;
      // a straight clone would walk the original's route in lockstep, which is
      // the identical-guards problem the archetypes exist to avoid
      const pool = archetypePool(floor.index);
      const spec = ARCHETYPES[pool[floor.guards.length % pool.length]];
      floor.guards.push({
        ...first,
        id: `extra-${floor.guards.length}`,
        archetype: spec.id,
        route: [...first.route].reverse(),
        routeIdx: 0,
        visionRange: spec.visionRange,
        coneHalfAngleDeg: spec.coneHalfAngleDeg,
        patrolSpeed: spec.patrolSpeed,
        huntSpeed: spec.huntSpeed,
        stationary: spec.stationary,
        deafToNoise: spec.deafToNoise,
        seesInBlackout: spec.seesInBlackout,
      });
    },
  },
];

/**
 * Floor 1 is always nominal so the base rules can be learned before anything
 * starts bending them.
 */
export function pickModifier(floorIndex: number, roll: number): FloorModifier {
  if (floorIndex === 0) return MODIFIERS[0];
  const pool = MODIFIERS.slice(1);
  return pool[Math.abs(roll) % pool.length];
}
