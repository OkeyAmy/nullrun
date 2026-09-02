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
];

export function hasImplant(implants: Implant[], id: string): boolean {
  return implants.some((i) => i.id === id);
}
