import type { Implant } from './types';

export const ALL_IMPLANTS: Implant[] = [
  {
    id: 'ghostwire',
    name: 'Ghostwire Spine',
    description: 'Operative gains +1 action point each turn.',
  },
  {
    id: 'nullfield',
    name: 'Nullfield Soles',
    description: 'Sprinting no longer generates noise.',
  },
  {
    id: 'wideband',
    name: 'Wideband Uplink',
    description: 'Agent gains +2 bandwidth each turn.',
  },
  {
    id: 'deepscan',
    name: 'Deep Scan Array',
    description: 'Agent ping radius +4 and reveals guard patrol routes.',
  },
  {
    id: 'silenthack',
    name: 'Silent Splice',
    description: 'Hacking a terminal costs 1 AP instead of 2 and makes no noise.',
  },
  {
    id: 'coldboot',
    name: 'Cold Boot Cell',
    description: 'Power cuts cost 1 less bandwidth and last 2 turns longer.',
  },
  {
    id: 'reflex',
    name: 'Reflex Governor',
    description: 'Survive the first capture of each floor — you are thrown clear instead.',
  },
  {
    id: 'staticveil',
    name: 'Static Veil',
    description: 'Alarm decays twice as fast while you are unobserved.',
  },
  {
    id: 'deadbolt',
    name: 'Deadbolt Driver',
    description: 'Doors the agent seals stay locked 3 turns longer.',
  },

  // --- rule-breakers -----------------------------------------------------
  // The list above is all small percentages, which meant no run ever produced
  // a build worth cackling about. These change what is possible rather than
  // how much it costs, and they are written to combine: Deadman plus Chain
  // Breaker turns clearing a floor from a debt into a discount.
  {
    id: 'deadman',
    name: 'Deadman Protocol',
    description: 'Guards you take down leave no body behind. Nothing to find, nothing to report.',
  },
  {
    id: 'chainbreaker',
    name: 'Chain Breaker',
    description:
      'Every takedown LOWERS the facility alert instead of raising it. The building calms as its staff stop reporting in.',
  },
  {
    id: 'mirrordaemon',
    name: 'Mirror Daemon',
    description:
      'The first time you are spotted on each floor, the sighting is scrubbed — alarm and alert are rolled back as if it never happened.',
  },
  {
    id: 'overclock',
    name: 'Overclock Rig',
    description:
      'plus 2 action points every turn, but every sighting drives the alarm half again as hard. Speed, bought with margin.',
  },
  {
    id: 'phaselattice',
    name: 'Phase Lattice',
    description:
      'Walk straight through shut and sealed doors. Doors stop being walls and start being scenery.',
  },
];

export function hasImplant(implants: Implant[], id: string): boolean {
  return implants.some((i) => i.id === id);
}
