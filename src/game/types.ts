export interface Vec {
  x: number;
  y: number;
}

export type TileKind = 'void' | 'wall' | 'floor' | 'door' | 'cover' | 'vent';

export interface Tile {
  kind: TileKind;
  /** Doors only. */
  open: boolean;
  /** Doors only — sealed doors cannot be opened by guards for `lockedTurns`. */
  lockedTurns: number;
  roomId: number;
}

/** Facing as a unit-ish direction. Guards turn in 45° steps. */
export type Facing = { dx: number; dy: number };

export type GuardState = 'patrol' | 'suspicious' | 'hunting';

/** Behavioural family a guard belongs to. See game/archetypes.ts. */
export type GuardArchetype = 'patrol' | 'sentry' | 'hunter' | 'drone' | 'bloodhound';

export interface Guard {
  id: string;
  archetype: GuardArchetype;
  x: number;
  y: number;
  facing: Facing;
  route: Vec[];
  routeIdx: number;
  state: GuardState;
  /** Where the guard is heading when suspicious/hunting. */
  investigating: Vec | null;
  /** Turns left before a suspicious guard gives up and returns to patrol. */
  patience: number;
  visionRange: number;
  coneHalfAngleDeg: number;
  stunTurns: number;
  patrolSpeed: number;
  huntSpeed: number;
  stationary: boolean;
  deafToNoise: boolean;
  seesInBlackout: boolean;
}

export interface Camera {
  id: string;
  x: number;
  y: number;
  facing: Facing;
  visionRange: number;
  coneHalfAngleDeg: number;
  /** > 0 means looped/disabled by the agent. */
  disabledTurns: number;
}

export type TerminalKind = 'data' | 'security';

export interface Terminal {
  id: string;
  x: number;
  y: number;
  kind: TerminalKind;
  hacked: boolean;
}

export interface Loot {
  id: string;
  x: number;
  y: number;
  value: number;
  taken: boolean;
}

export interface NoiseEvent {
  x: number;
  y: number;
  radius: number;
  /** Turns remaining that this noise is rendered for. */
  ttl: number;
}

export interface Implant {
  id: string;
  name: string;
  description: string;
}

/**
 * Who is at the controls. Chosen before a run and readable by the agent, so a
 * connected handler knows whether it is advising a human or playing solo.
 */
export type PlayMode = 'coop' | 'agent';

export type RunPhase =
  | 'mode_select'
  | 'menu'
  | 'briefing'
  | 'playing'
  | 'floor_clear'
  | 'choosing_implant'
  | 'run_failed'
  | 'run_complete';

export interface FloorState {
  index: number;
  width: number;
  height: number;
  tiles: Tile[];
  guards: Guard[];
  cameras: Camera[];
  terminals: Terminal[];
  loot: Loot[];
  extraction: Vec;
  /** Fog of war: tiles the operative or the agent has ever seen. */
  discovered: boolean[];
  /** Currently within the operative's line of sight. */
  visible: boolean[];
  /** Tiles revealed by an agent ping this turn (rendered differently). */
  scanned: boolean[];
  noises: NoiseEvent[];
}

export interface LogEntry {
  turn: number;
  actor: 'operative' | 'agent' | 'system' | 'hostile';
  text: string;
}

export interface GameState {
  phase: RunPhase;
  /** Null until the opening screen has been answered. */
  mode: PlayMode | null;
  floor: FloorState;
  player: Vec;
  /** Direction the operative is facing, for rendering. */
  playerFacing: Facing;
  turn: number;
  ap: number;
  maxAp: number;
  bandwidth: number;
  maxBandwidth: number;
  alarm: number;
  /** Turns since the operative was last observed — drives alarm decay. */
  turnsUnseen: number;
  /** Global vision multiplier — dropped by cut_power. */
  powerOutTurns: number;
  implants: Implant[];
  implantChoices: Implant[];
  intelThisRun: number;
  bankedIntel: number;
  /** Implant ids permanently bought with banked intel; installed on every run. */
  unlockedIds: string[];
  log: LogEntry[];
  seed: number;
  /** Set when the run ends, for the summary screen. */
  endReason: string;
  /** Reflex implant: one free escape from capture. */
  reflexAvailable: boolean;
}
