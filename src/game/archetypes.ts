import type { GuardArchetype } from './types';

/**
 * Guard archetypes.
 *
 * Every guard used to share one stat line, so floor 5 was floor 1 with more
 * copies of the same unit. These give each floor a different shape of problem
 * and — more importantly — make the handler's tools situational: a blackout
 * does nothing to a thermal drone, a distraction does nothing to a bolted-down
 * sentry, and a bloodhound punishes noise instead of sight.
 */
export interface ArchetypeSpec {
  id: GuardArchetype;
  name: string;
  /** Shown to agents so they can plan a counter. */
  threat: string;
  visionRange: number;
  coneHalfAngleDeg: number;
  patrolSpeed: number;
  huntSpeed: number;
  /** Bolted to the floor: patrols nowhere, but sweeps a wide arc. */
  stationary: boolean;
  /** Distractions and noise do not pull it. */
  deafToNoise: boolean;
  /** Cutting the grid does not shorten its cone. */
  seesInBlackout: boolean;
  /** Turns spent stunned when it loses the operative. */
  patience: number;
}

export const ARCHETYPES: Record<GuardArchetype, ArchetypeSpec> = {
  patrol: {
    id: 'patrol',
    name: 'Patrol',
    threat: 'Standard rotation. Hears noise, blinded by a blackout, walks its route.',
    visionRange: 7,
    coneHalfAngleDeg: 45,
    patrolSpeed: 1,
    huntSpeed: 2,
    stationary: false,
    deafToNoise: false,
    seesInBlackout: false,
    patience: 4,
  },
  sentry: {
    id: 'sentry',
    name: 'Sentry',
    threat:
      'Bolted down and never moves, but sweeps a wide arc at long range. Cannot be lured by a distraction — route around it, or cut the power.',
    visionRange: 9,
    coneHalfAngleDeg: 70,
    patrolSpeed: 0,
    huntSpeed: 0,
    stationary: true,
    deafToNoise: true,
    seesInBlackout: false,
    patience: 2,
  },
  hunter: {
    id: 'hunter',
    name: 'Hunter',
    threat:
      'Fast and stubborn. Narrow cone, so it is easy to slip behind, but once it has you it closes quickly and searches for a long time.',
    visionRange: 8,
    coneHalfAngleDeg: 30,
    patrolSpeed: 2,
    huntSpeed: 3,
    stationary: false,
    deafToNoise: false,
    seesInBlackout: false,
    patience: 7,
  },
  drone: {
    id: 'drone',
    name: 'Thermal drone',
    threat:
      'Short-ranged but sees straight through a blackout. Cutting the power will not hide you from it — loop it out with doors and distance instead.',
    visionRange: 5,
    coneHalfAngleDeg: 55,
    patrolSpeed: 2,
    huntSpeed: 2,
    stationary: false,
    deafToNoise: false,
    seesInBlackout: true,
    patience: 3,
  },
  bloodhound: {
    id: 'bloodhound',
    name: 'Bloodhound',
    threat:
      'Poor eyesight, excellent hearing: it investigates noise from twice the usual distance. Sprint near it and it will find you.',
    visionRange: 4,
    coneHalfAngleDeg: 40,
    patrolSpeed: 1,
    huntSpeed: 3,
    stationary: false,
    deafToNoise: false,
    seesInBlackout: false,
    patience: 6,
  },
};

/** Hearing multiplier — the bloodhound is the only unit that beats the default. */
export function hearingMultiplier(archetype: GuardArchetype): number {
  return archetype === 'bloodhound' ? 2 : 1;
}

/**
 * Which archetypes a floor may spawn. Floor 1 is all standard patrols so the
 * rules can be learned; each floor after introduces exactly one new problem.
 */
export function archetypePool(floorIndex: number): GuardArchetype[] {
  const pools: GuardArchetype[][] = [
    ['patrol'],
    ['patrol', 'patrol', 'sentry'],
    ['patrol', 'sentry', 'hunter'],
    ['patrol', 'hunter', 'drone'],
    ['patrol', 'sentry', 'hunter', 'drone', 'bloodhound'],
  ];
  return pools[Math.min(floorIndex, pools.length - 1)];
}
