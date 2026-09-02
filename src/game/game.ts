import { BALANCE } from './config';
import { ARCHETYPES, BARKS, hearingMultiplier } from './archetypes';
import { hasImplant, ALL_IMPLANTS } from './implants';
import {
  chebyshev,
  findPath,
  inBounds,
  isWalkable,
  manhattan,
  samePos,
  tileAt,
} from './grid';
import { floorConfig, floorStart, generateFloor } from './mapgen';
import { RNG } from './rng';
import type {
  Camera,
  PlayMode,
  RunPhase,
  FloorState,
  GameState,
  Guard,
  GuardState,
  Implant,
  LogEntry,
  Terminal,
  Vec,
} from './types';
import {
  cameraSees,
  guardSees,
  tileThreat,
  updateOperativeVisibility,
  type VisionContext,
} from './vision';

export interface ActionResult {
  ok: boolean;
  message: string;
  /** Extra structured detail — surfaced verbatim to agents. */
  detail?: Record<string, unknown>;
}

const STORAGE_KEY = 'nullrun.meta.v1';

interface MetaProgress {
  bankedIntel: number;
  unlocked: string[];
}

function loadMeta(): MetaProgress {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { bankedIntel: 0, unlocked: [] };
    const parsed = JSON.parse(raw) as Partial<MetaProgress>;
    return {
      bankedIntel: typeof parsed.bankedIntel === 'number' ? parsed.bankedIntel : 0,
      unlocked: Array.isArray(parsed.unlocked) ? parsed.unlocked : [],
    };
  } catch {
    return { bankedIntel: 0, unlocked: [] };
  }
}

function saveMeta(meta: MetaProgress): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(meta));
  } catch {
    /* storage unavailable — meta progress is a bonus, never required */
  }
}

/**
 * Discrete things that happen, as opposed to "the state changed". The engine
 * already knew all of these; it just never said them out loud, which is why
 * being spotted felt like a number going up instead of a disaster.
 */
export type GameEvent =
  | 'step'
  | 'sprint'
  | 'hack'
  | 'grab'
  | 'door'
  | 'spotted'
  | 'near_miss'
  | 'takedown'
  | 'body_found'
  | 'escalate'
  | 'lockdown'
  | 'blackout'
  | 'floor_clear'
  | 'run_failed';

export class Game {
  state!: GameState;
  private listeners = new Set<() => void>();
  private eventListeners = new Set<(event: GameEvent) => void>();
  private rng = new RNG(1);

  constructor() {
    this.newRun();
  }

  // -- lifecycle ---------------------------------------------------------

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Subscribe to discrete events — used for sound and screen feedback. */
  onEvent(fn: (event: GameEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  /** Announce something that happened. Never throws into the game loop. */
  fire(event: GameEvent): void {
    for (const fn of this.eventListeners) {
      try {
        fn(event);
      } catch {
        // presentation must never be able to break the simulation
      }
    }
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  newRun(seed = Math.floor(Math.random() * 1_000_000)): void {
    const meta = loadMeta();
    this.rng = new RNG(seed);
    const floor = this.buildFloor(seed, 0);
    const start = floorStart(floor);
    // a repeat run keeps the previous answer, and must honour it the same way
    // setMode does: agent runs never stop at the human briefing
    const previousMode = this.state?.mode ?? null;
    const openingPhase: RunPhase =
      previousMode === 'agent' ? 'playing' : previousMode ? 'briefing' : 'mode_select';
    const owned = ALL_IMPLANTS.filter((i) => meta.unlocked.includes(i.id));
    this.state = {
      phase: openingPhase,
      mode: previousMode,
      floor,
      player: start,
      playerFacing: { dx: 0, dy: 1 },
      turn: 1,
      ap: BALANCE.operative.baseAp,
      maxAp: BALANCE.operative.baseAp,
      bandwidth: BALANCE.agent.baseBandwidth,
      maxBandwidth: BALANCE.agent.baseBandwidth,
      alarm: 0,
      turnsUnseen: 0,
      powerOutTurns: 0,
      implants: owned,
      implantChoices: [],
      intelThisRun: 0,
      bankedIntel: meta.bankedIntel,
      unlockedIds: meta.unlocked,
      escalation: 0,
      alertStage: 0,
      nearMiss: false,
      log: [],
      seed,
      endReason: '',
      reflexAvailable: false,
    };
    this.refreshResources();
    updateOperativeVisibility(floor, start);
    this.log('system', `Facility seed ${seed}. Floor 1 of ${BALANCE.run.floors}. Go dark.`);
    this.emit();
  }

  private buildFloor(seed: number, index: number): FloorState {
    return generateFloor(seed, floorConfig(index));
  }

  /** Answer the opening screen: who is at the controls for this run. */
  setMode(mode: PlayMode): ActionResult {
    const s = this.state;
    if (s.phase === 'run_failed' || s.phase === 'run_complete') {
      return { ok: false, message: 'The run is over — start a new one first.' };
    }
    const previous = s.mode;
    s.mode = mode;
    // The briefing exists so a human can read the objective before moving. A
    // spectator has no reason to click through it, and the agent cannot see it
    // at all, so picking AI drops straight into the floor.
    if (mode === 'agent') {
      if (s.phase === 'mode_select' || s.phase === 'briefing') s.phase = 'playing';
    } else if (s.phase === 'mode_select') {
      s.phase = 'briefing';
    }
    const handover = previous && previous !== mode;
    this.log(
      'system',
      mode === 'coop'
        ? handover
          ? 'Control handed back — the human has the operative, the agent keeps the network.'
          : 'Co-op: operative on the ground, agent handler on the network.'
        : handover
          ? 'Control handed to the agent — it has the operative and the network.'
          : 'Agent-run infiltration — the handler has the operative too.',
    );
    this.emit();
    return {
      ok: true,
      message:
        s.phase === 'playing'
          ? `Play mode set to "${mode}". The floor is already live — start acting.`
          : `Play mode set to "${mode}".`,
      detail: { mode, phase: s.phase },
    };
  }

  beginInfiltration(): void {
    if (this.state.phase !== 'briefing') return;
    this.state.phase = 'playing';
    this.emit();
  }

  private nextFloor(): void {
    const s = this.state;
    const index = s.floor.index + 1;
    if (index >= BALANCE.run.floors) {
      s.phase = 'run_complete';
      s.endReason = 'Full facility stack breached. Extraction confirmed.';
      this.bankIntel();
      this.log('system', 'RUN COMPLETE — all floors breached.');
      this.emit();
      return;
    }
    const floor = this.buildFloor(s.seed, index);
    s.floor = floor;
    s.player = floorStart(floor);
    s.playerFacing = { dx: 0, dy: 1 };
    s.turn = 1;
    s.alarm = 0;
    s.turnsUnseen = 0;
    s.powerOutTurns = 0;
    s.phase = 'playing';
    // a fresh floor, but the building already knows someone is inside
    s.escalation = index * BALANCE.alert.perFloorCleared;
    s.alertStage = this.stageFor(s.escalation);
    s.nearMiss = false;
    this.refreshResources();
    updateOperativeVisibility(floor, s.player);
    this.log('system', `Floor ${index + 1} of ${BALANCE.run.floors}. Security posture increased.`);
    this.emit();
  }

  /** Stage a given escalation has reached: 0 quiet, 3 locked down. */
  private stageFor(escalation: number): number {
    return BALANCE.alert.stageAt.filter((threshold) => escalation >= threshold).length;
  }

  /**
   * Push the facility's escalation up. Nothing brings it back down inside a
   * floor, which is the whole point — the alarm decays to nothing if you sit
   * still, so without this the best way to play was to wait, and waiting is
   * not a game.
   */
  raiseAlert(amount: number, reason: string): void {
    const s = this.state;
    if (s.escalation >= BALANCE.alert.max) return;
    s.escalation = Math.min(BALANCE.alert.max, s.escalation + amount);
    const stage = this.stageFor(s.escalation);
    if (stage > s.alertStage) {
      s.alertStage = stage;
      this.applyAlertStage(stage, reason);
    }
  }

  /** Each stage makes the floor materially harder, and says so out loud. */
  private applyAlertStage(stage: number, reason: string): void {
    const s = this.state;
    if (stage === 1) {
      for (const guard of s.floor.guards) guard.visionRange += 1;
      this.log('hostile', `${reason} Security widens its sweeps — every guard sees further.`);
      this.fire('escalate');
      return;
    }
    if (stage === 2) {
      const entry = floorStart(s.floor);
      const spec = ARCHETYPES.hunter;
      s.floor.guards.push({
        id: `reinforcement-${s.floor.guards.length}`,
        archetype: spec.id,
        x: entry.x,
        y: entry.y,
        facing: { dx: 0, dy: 1 },
        route: [{ ...s.player }],
        routeIdx: 0,
        state: 'suspicious',
        investigating: { ...s.player },
        patience: spec.patience,
        visionRange: spec.visionRange,
        coneHalfAngleDeg: spec.coneHalfAngleDeg,
        stunTurns: 0,
        patrolSpeed: spec.patrolSpeed,
        huntSpeed: spec.huntSpeed,
        stationary: spec.stationary,
        deafToNoise: spec.deafToNoise,
        seesInBlackout: spec.seesInBlackout,
      });
      this.log('hostile', `${reason} A hunter has been sent in after you.`);
      this.fire('escalate');
      return;
    }
    this.log('hostile', `${reason} FACILITY LOCKDOWN — the alarm will not cool down again.`);
    this.fire('lockdown');
  }

  private bankIntel(): void {
    const meta = loadMeta();
    meta.bankedIntel += this.state.intelThisRun;
    saveMeta(meta);
    this.state.bankedIntel = meta.bankedIntel;
  }

  /** Price of the next permanent implant, rising with how many you own. */
  upgradeCost(): number {
    return (
      BALANCE.run.upgradeBaseCost +
      BALANCE.run.upgradeCostPerOwned * this.state.unlockedIds.length
    );
  }

  /** Implants that can still be bought, with the price of the next one. */
  availableUpgrades(): Array<Implant & { cost: number; affordable: boolean }> {
    const cost = this.upgradeCost();
    return ALL_IMPLANTS.filter((i) => !this.state.unlockedIds.includes(i.id)).map((i) => ({
      ...i,
      cost,
      affordable: this.state.bankedIntel >= cost,
    }));
  }

  /**
   * Spend banked intel on a permanent implant. This is the only thing intel is
   * for — without it a finished run leaves nothing behind and there is no
   * reason to start another.
   */
  purchaseUpgrade(id: string): ActionResult {
    const s = this.state;
    if (s.phase === 'playing') {
      return { ok: false, message: 'The blackmarket is only open between runs.' };
    }
    const implant = ALL_IMPLANTS.find((i) => i.id === id);
    if (!implant) return { ok: false, message: `No implant with id "${id}".` };
    if (s.unlockedIds.includes(id)) {
      return { ok: false, message: `${implant.name} is already permanently installed.` };
    }
    const cost = this.upgradeCost();
    if (s.bankedIntel < cost) {
      return {
        ok: false,
        message: `${implant.name} costs ${cost} intel; you have banked ${s.bankedIntel}.`,
      };
    }

    // the live state is the authority here — upgradeCost() and
    // availableUpgrades() both price off it, so debiting the stored copy
    // instead would let the two drift apart and charge the wrong amount
    s.bankedIntel -= cost;
    s.unlockedIds = [...s.unlockedIds, id];
    const meta = loadMeta();
    meta.bankedIntel = s.bankedIntel;
    meta.unlocked = s.unlockedIds;
    saveMeta(meta);
    this.log('system', `Blackmarket: ${implant.name} permanently installed.`);
    this.emit();
    return {
      ok: true,
      message: `Bought ${implant.name} for ${cost} intel. It is installed at the start of every future run. ${implant.description}`,
      detail: { bankedIntel: s.bankedIntel, nextCost: this.upgradeCost() },
    };
  }

  private failRun(reason: string): void {
    const s = this.state;
    this.fire('run_failed');
    s.phase = 'run_failed';
    s.endReason = reason;
    this.bankIntel();
    this.log('system', `RUN FAILED — ${reason}`);
    this.emit();
  }

  // -- helpers -----------------------------------------------------------

  private get visionCtx(): VisionContext {
    return { powerOutTurns: this.state.powerOutTurns };
  }

  log(actor: LogEntry['actor'], text: string): void {
    this.state.log.push({ turn: this.state.turn, actor, text });
    if (this.state.log.length > 200) this.state.log.shift();
  }

  private refreshResources(): void {
    const s = this.state;
    s.maxAp = BALANCE.operative.baseAp + (hasImplant(s.implants, 'ghostwire') ? 1 : 0);
    s.maxBandwidth =
      BALANCE.agent.baseBandwidth +
      (hasImplant(s.implants, 'wideband') ? BALANCE.agent.bandwidthPerWideband : 0);
    s.ap = s.maxAp;
    s.bandwidth = s.maxBandwidth;
    s.reflexAvailable = hasImplant(s.implants, 'reflex');
  }

  private requirePlaying(): ActionResult | null {
    if (this.state.phase !== 'playing') {
      return { ok: false, message: `No action possible while phase is "${this.state.phase}".` };
    }
    return null;
  }

  private spendAp(cost: number): boolean {
    if (this.state.ap < cost) return false;
    this.state.ap -= cost;
    return true;
  }

  private spendBandwidth(cost: number): boolean {
    if (this.state.bandwidth < cost) return false;
    this.state.bandwidth -= cost;
    return true;
  }

  private hackCost(): number {
    return hasImplant(this.state.implants, 'silenthack')
      ? BALANCE.apCost.hackSilent
      : BALANCE.apCost.hack;
  }

  private hackNoise(): number {
    return hasImplant(this.state.implants, 'silenthack')
      ? BALANCE.noise.hackSilent
      : BALANCE.noise.hack;
  }

  /** Register a noise event that guards will investigate on their turn. */
  emitNoise(x: number, y: number, radius: number): void {
    if (radius <= 0) return;
    this.state.floor.noises.push({ x, y, radius, ttl: 2 });
  }

  terminalAt(x: number, y: number): Terminal | undefined {
    return this.state.floor.terminals.find((t) => t.x === x && t.y === y);
  }

  dataCoresRemaining(): number {
    return this.state.floor.terminals.filter((t) => t.kind === 'data' && !t.hacked).length;
  }

  objectiveComplete(): boolean {
    return this.dataCoresRemaining() === 0;
  }

  // -- operative actions --------------------------------------------------

  move(dx: number, dy: number): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    const target = { x: s.player.x + dx, y: s.player.y + dy };
    if (!inBounds(s.floor, target.x, target.y)) {
      return { ok: false, message: 'That is the facility perimeter.' };
    }
    const tile = tileAt(s.floor, target.x, target.y);
    if (tile?.kind === 'door' && !tile.open) {
      return { ok: false, message: 'Door is shut. Open it, or have the agent cycle it.' };
    }
    if (!isWalkable(s.floor, target.x, target.y)) {
      return { ok: false, message: 'Solid wall.' };
    }
    if (!this.spendAp(BALANCE.apCost.move)) {
      return { ok: false, message: 'Out of action points. End the turn.' };
    }
    s.playerFacing = { dx: Math.sign(dx), dy: Math.sign(dy) };
    s.player = target;
    this.fire('step');
    updateOperativeVisibility(s.floor, s.player);
    this.afterOperativeAction();
    return { ok: true, message: `Moved to ${target.x},${target.y}.` };
  }

  /**
   * Put a guard down.
   *
   * Guards used to be pure terrain — the only verb available against them was
   * "avoid". This is the one offensive option, and it is deliberately a trade
   * rather than an answer: it costs most of a turn, and it leaves a body that
   * another guard can find, which raises the alert permanently. Taking someone
   * head-on is louder than coming up behind them.
   */
  takedown(guardId?: string): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;

    const reachable = s.floor.guards.filter((g) => chebyshev(s.player, g) <= 1);
    if (!reachable.length) {
      return { ok: false, message: 'Nobody within reach — you have to be standing next to them.' };
    }
    const guard = guardId ? reachable.find((g) => g.id === guardId) : reachable[0];
    if (!guard) {
      return {
        ok: false,
        message: `${guardId} is not within reach. In range: ${reachable.map((g) => g.id).join(', ')}.`,
      };
    }
    if (!this.spendAp(BALANCE.apCost.takedown)) {
      return {
        ok: false,
        message: `A takedown costs ${BALANCE.apCost.takedown} AP; you have ${s.ap}.`,
      };
    }

    // coming at someone who is already looking your way is a struggle, not a
    // takedown: it works, but the whole floor gets a hint
    const facingYou =
      guard.state === 'hunting' ||
      (Math.sign(s.player.x - guard.x) === Math.sign(guard.facing.dx) &&
        Math.sign(s.player.y - guard.y) === Math.sign(guard.facing.dy));

    s.floor.guards = s.floor.guards.filter((g) => g.id !== guard.id);
    s.floor.bodies.push({ id: `body-${guard.id}`, x: guard.x, y: guard.y, found: false });
    this.fire('takedown');

    const noise = facingYou ? BALANCE.noise.takedownSeen : BALANCE.noise.takedown;
    if (noise > 0) this.emitNoise(guard.x, guard.y, noise);

    this.log(
      'operative',
      facingYou
        ? `${guard.id} put down the hard way — that was heard.`
        : `${guard.id} taken down clean.`,
    );
    this.afterOperativeAction();
    return {
      ok: true,
      message: facingYou
        ? `${guard.id} is down, but it saw you coming and the struggle made noise (radius ${noise}). The body is at ${guard.x},${guard.y} — move it out of the patrol path or another guard will find it.`
        : `${guard.id} is down, quietly. The body is lying at ${guard.x},${guard.y}; if another guard sees it the facility escalates permanently.`,
      detail: {
        guard: guard.id,
        clean: !facingYou,
        body: { x: guard.x, y: guard.y },
        noiseRadius: noise,
      },
    };
  }

  /**
   * Guards notice their colleagues lying on the floor. This is what makes a
   * takedown a decision instead of a free removal.
   */
  private checkBodyDiscovery(): void {
    const s = this.state;
    if (!s.floor.bodies.length) return;
    const ctx = this.visionCtx;

    for (const body of s.floor.bodies) {
      if (body.found) continue;
      const finder = s.floor.guards.find(
        (guard) => guard.stunTurns === 0 && guardSees(s.floor, guard, body, ctx),
      );
      if (!finder) continue;

      body.found = true;
      finder.state = 'hunting';
      finder.investigating = { x: body.x, y: body.y };
      finder.patience = BALANCE.guard.patience;
      this.fire('body_found');
      this.raiseAlert(BALANCE.alert.perBodyFound, `${finder.id} found a body.`);
      this.log('hostile', `${finder.id} has found ${body.id}. They know someone is inside.`);
    }
  }

  /** Walk a BFS path toward a tile, spending AP per step. Stops when AP runs out. */
  moveTo(x: number, y: number, sprint = false): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    if (!inBounds(s.floor, x, y)) return { ok: false, message: 'Target is off-map.' };

    const path = findPath(s.floor, s.player, { x, y });
    if (!path) return { ok: false, message: 'No route to that tile — check for shut doors.' };
    if (!path.length) return { ok: false, message: 'Already standing there.' };

    const stepBudget = sprint ? BALANCE.operative.sprintDistance : path.length;
    const apCost = sprint ? BALANCE.apCost.sprint : BALANCE.apCost.move;

    const stepsTaken: Vec[] = [];
    let doorsOpened = 0;
    for (const step of path.slice(0, stepBudget)) {
      // a shut door on the route is opened in passing, for an extra AP and noise
      const stepTile = tileAt(s.floor, step.x, step.y);
      if (stepTile?.kind === 'door' && !stepTile.open) {
        if (stepTile.lockedTurns > 0) break;
        if (!this.spendAp(BALANCE.apCost.toggleDoor)) break;
        stepTile.open = true;
        this.emitNoise(step.x, step.y, BALANCE.noise.toggleDoor);
        doorsOpened++;
      }
      if (!isWalkable(s.floor, step.x, step.y)) break;
      if (sprint) {
        // sprint pays once for the whole dash
        if (stepsTaken.length === 0 && !this.spendAp(apCost)) {
          return { ok: false, message: 'Not enough AP to sprint.' };
        }
      } else if (!this.spendAp(apCost)) {
        break;
      }
      s.playerFacing = {
        dx: Math.sign(step.x - s.player.x),
        dy: Math.sign(step.y - s.player.y),
      };
      s.player = step;
      stepsTaken.push(step);
    }

    if (!stepsTaken.length) {
      return { ok: false, message: 'Not enough action points to move.' };
    }

    this.fire(sprint ? 'sprint' : 'step');
    if (sprint) {
      const noise = hasImplant(s.implants, 'nullfield') ? 0 : BALANCE.noise.sprint;
      if (noise > 0) {
        this.emitNoise(s.player.x, s.player.y, noise);
        this.log('operative', `Sprint noise at ${s.player.x},${s.player.y} (radius ${noise}).`);
      }
    }

    updateOperativeVisibility(s.floor, s.player);
    this.afterOperativeAction();
    const arrived = samePos(s.player, { x, y });
    return {
      ok: true,
      message: arrived
        ? `Reached ${x},${y} in ${stepsTaken.length} step(s).`
        : `Moved ${stepsTaken.length} step(s) toward ${x},${y}; stopped at ${s.player.x},${s.player.y}.`,
      detail: { arrived, steps: stepsTaken.length, doorsOpened, position: { ...s.player } },
    };
  }

  toggleDoor(x: number, y: number): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    const tile = tileAt(s.floor, x, y);
    if (!tile || tile.kind !== 'door') return { ok: false, message: 'No door there.' };
    if (chebyshev(s.player, { x, y }) > 1) {
      return { ok: false, message: 'Door is out of reach — stand next to it.' };
    }
    if (!this.spendAp(BALANCE.apCost.toggleDoor)) {
      return { ok: false, message: 'Out of action points.' };
    }
    tile.open = !tile.open;
    this.fire('door');
    this.emitNoise(x, y, BALANCE.noise.toggleDoor);
    updateOperativeVisibility(s.floor, s.player);
    this.afterOperativeAction();
    return { ok: true, message: `Door at ${x},${y} is now ${tile.open ? 'open' : 'shut'}.` };
  }

  hack(terminalId?: string): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    const candidates = s.floor.terminals.filter(
      (t) => !t.hacked && chebyshev(s.player, t) <= 1,
    );
    const terminal = terminalId
      ? candidates.find((t) => t.id === terminalId)
      : candidates[0];
    if (!terminal) {
      return {
        ok: false,
        message: terminalId
          ? `Terminal ${terminalId} is not adjacent (or already hacked).`
          : 'No un-hacked terminal within reach.',
      };
    }
    const cost = this.hackCost();
    if (!this.spendAp(cost)) {
      return { ok: false, message: `Hacking needs ${cost} AP; you have ${s.ap}.` };
    }
    terminal.hacked = true;
    this.emitNoise(terminal.x, terminal.y, this.hackNoise());

    this.fire('hack');
    if (terminal.kind === 'data') {
      this.log('operative', `Data core ${terminal.id} siphoned.`);
      const remaining = this.dataCoresRemaining();
      this.afterOperativeAction();
      return {
        ok: true,
        message:
          remaining === 0
            ? 'Last data core siphoned. Extraction point is now hot — get there.'
            : `Data core siphoned. ${remaining} core(s) remaining.`,
        detail: { coresRemaining: remaining },
      };
    }

    // security terminal: reveals the floor and knocks the alarm down
    s.floor.discovered.fill(true);
    s.alarm = Math.max(0, s.alarm - 30);
    this.log('operative', `Security node ${terminal.id} spliced — floor map pulled, alarm dropped.`);
    this.afterOperativeAction();
    return {
      ok: true,
      message: 'Security node spliced: full floor map acquired and alarm reduced by 30.',
      detail: { alarm: s.alarm },
    };
  }

  grab(): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    const item = s.floor.loot.find((l) => !l.taken && samePos(l, s.player));
    if (!item) return { ok: false, message: 'Nothing to lift on this tile.' };
    if (!this.spendAp(BALANCE.apCost.grab)) {
      return { ok: false, message: 'Out of action points.' };
    }
    item.taken = true;
    s.intelThisRun += item.value;
    this.fire('grab');
    this.afterOperativeAction();
    return {
      ok: true,
      message: `Lifted ${item.value} intel. Run total ${s.intelThisRun}.`,
      detail: { intelThisRun: s.intelThisRun },
    };
  }

  extract(): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    if (!samePos(s.player, s.floor.extraction)) {
      return { ok: false, message: 'You are not on the extraction pad.' };
    }
    if (!this.objectiveComplete()) {
      return {
        ok: false,
        message: `Extraction locked — ${this.dataCoresRemaining()} data core(s) still un-siphoned.`,
      };
    }
    s.intelThisRun += BALANCE.run.intelPerFloorClear;
    this.log('operative', `Extracted from floor ${s.floor.index + 1}.`);

    if (s.floor.index + 1 >= BALANCE.run.floors) {
      s.phase = 'run_complete';
      s.endReason = 'Full facility stack breached. Extraction confirmed.';
      this.bankIntel();
      this.emit();
      return { ok: true, message: 'Final floor cleared. Run complete.' };
    }

    this.fire('floor_clear');
    s.phase = 'choosing_implant';
    s.implantChoices = this.rollImplantChoices();
    this.emit();
    return {
      ok: true,
      message: 'Floor cleared. Choose an implant before the next descent.',
      detail: { choices: s.implantChoices.map((i) => ({ id: i.id, name: i.name })) },
    };
  }

  private rollImplantChoices(): Implant[] {
    const owned = new Set(this.state.implants.map((i) => i.id));
    const pool = ALL_IMPLANTS.filter((i) => !owned.has(i.id));
    return this.rng.shuffle(pool).slice(0, 3);
  }

  chooseImplant(id: string): ActionResult {
    const s = this.state;
    if (s.phase !== 'choosing_implant') {
      return { ok: false, message: 'No implant choice is pending.' };
    }
    const pick = s.implantChoices.find((i) => i.id === id);
    if (!pick) return { ok: false, message: `"${id}" is not one of the offered implants.` };
    s.implants.push(pick);
    s.implantChoices = [];
    this.log('system', `Implant installed: ${pick.name}.`);
    this.nextFloor();
    return { ok: true, message: `Installed ${pick.name}. ${pick.description}` };
  }

  // -- agent actions ------------------------------------------------------

  ping(x: number, y: number): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    if (!inBounds(s.floor, x, y)) return { ok: false, message: 'Ping target is off-map.' };
    const cost = BALANCE.agent.cost.ping;
    if (!this.spendBandwidth(cost)) {
      return { ok: false, message: `Ping needs ${cost} bandwidth; you have ${s.bandwidth}.` };
    }
    const radius =
      BALANCE.agent.pingRadius +
      (hasImplant(s.implants, 'deepscan') ? BALANCE.agent.deepScanBonusRadius : 0);

    s.floor.scanned.fill(false);
    const revealed: Vec[] = [];
    for (let ty = y - radius; ty <= y + radius; ty++) {
      for (let tx = x - radius; tx <= x + radius; tx++) {
        if (!inBounds(s.floor, tx, ty)) continue;
        if (Math.hypot(tx - x, ty - y) > radius) continue;
        const i = ty * s.floor.width + tx;
        s.floor.discovered[i] = true;
        s.floor.scanned[i] = true;
        revealed.push({ x: tx, y: ty });
      }
    }

    const guards = s.floor.guards.filter((g) => Math.hypot(g.x - x, g.y - y) <= radius);
    const cameras = s.floor.cameras.filter((c) => Math.hypot(c.x - x, c.y - y) <= radius);

    // an active ping is not free — nearby guards register the sweep
    if (guards.length) {
      s.alarm = Math.min(BALANCE.alarm.max, s.alarm + BALANCE.alarm.pingSuspicion);
    }

    this.log('agent', `Ping at ${x},${y} — ${guards.length} guard(s), ${cameras.length} camera(s).`);
    this.emit();
    return {
      ok: true,
      message: `Swept ${revealed.length} tiles around ${x},${y}.`,
      detail: {
        guards: guards.map((g) => this.describeGuard(g)),
        cameras: cameras.map((c) => this.describeCamera(c)),
        alarm: s.alarm,
      },
    };
  }

  agentToggleDoor(x: number, y: number, seal: boolean): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    const tile = tileAt(s.floor, x, y);
    if (!tile || tile.kind !== 'door') return { ok: false, message: 'No door at that tile.' };
    const cost = BALANCE.agent.cost.toggleDoor;
    if (!this.spendBandwidth(cost)) {
      return { ok: false, message: `Needs ${cost} bandwidth; you have ${s.bandwidth}.` };
    }
    if (seal) {
      tile.open = false;
      tile.lockedTurns =
        BALANCE.agent.sealTurns +
        (hasImplant(s.implants, 'deadbolt') ? BALANCE.agent.deadboltBonusTurns : 0);
      this.log('agent', `Door ${x},${y} sealed for ${tile.lockedTurns} turns.`);
    } else {
      tile.open = true;
      tile.lockedTurns = 0;
      this.log('agent', `Door ${x},${y} cycled open.`);
    }
    updateOperativeVisibility(s.floor, s.player);
    this.emit();
    return {
      ok: true,
      message: seal
        ? `Door ${x},${y} sealed for ${tile.lockedTurns} turns.`
        : `Door ${x},${y} opened.`,
    };
  }

  loopCamera(cameraId: string): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    const camera = s.floor.cameras.find((c) => c.id === cameraId);
    if (!camera) return { ok: false, message: `No camera "${cameraId}" on this floor.` };
    const cost = BALANCE.agent.cost.loopCamera;
    if (!this.spendBandwidth(cost)) {
      return { ok: false, message: `Needs ${cost} bandwidth; you have ${s.bandwidth}.` };
    }
    camera.disabledTurns = BALANCE.agent.cameraLoopTurns;
    this.log('agent', `${cameraId} feed looped for ${camera.disabledTurns} turns.`);
    this.emit();
    return { ok: true, message: `${cameraId} is blind for ${camera.disabledTurns} turns.` };
  }

  distraction(x: number, y: number): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    if (!inBounds(s.floor, x, y)) return { ok: false, message: 'Target is off-map.' };
    const cost = BALANCE.agent.cost.distraction;
    if (!this.spendBandwidth(cost)) {
      return { ok: false, message: `Needs ${cost} bandwidth; you have ${s.bandwidth}.` };
    }
    const radius = BALANCE.agent.distractionNoiseRadius;
    this.emitNoise(x, y, radius);
    const pulled = s.floor.guards.filter(
      (g) =>
        g.stunTurns === 0 &&
        !g.deafToNoise &&
        Math.hypot(g.x - x, g.y - y) <= radius * hearingMultiplier(g.archetype),
    );
    for (const guard of pulled) {
      guard.state = 'suspicious';
      guard.investigating = { x, y };
      guard.patience = BALANCE.guard.patience;
    }
    this.log('agent', `Speaker blown at ${x},${y} — ${pulled.length} guard(s) redirected.`);
    this.emit();
    return {
      ok: true,
      message: `Distraction fired at ${x},${y}; ${pulled.length} guard(s) are investigating it.`,
      detail: { pulled: pulled.map((g) => g.id) },
    };
  }

  cutPower(): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    const discount = hasImplant(s.implants, 'coldboot') ? 1 : 0;
    const cost = Math.max(1, BALANCE.agent.cost.cutPower - discount);
    if (!this.spendBandwidth(cost)) {
      return { ok: false, message: `Needs ${cost} bandwidth; you have ${s.bandwidth}.` };
    }
    const turns =
      BALANCE.agent.powerOutTurns +
      (hasImplant(s.implants, 'coldboot') ? BALANCE.agent.coldBootBonusTurns : 0);
    s.powerOutTurns = turns;
    this.fire('blackout');
    // the facility notices the grid dropping even though it cannot see you;
    // this is comment, not a penalty — cutting power must stay worth doing
    const witness = s.floor.guards.find((g) => g.stunTurns === 0);
    if (witness) {
      this.log(
        'hostile',
        `${witness.id}: "${
          witness.seesInBlackout
            ? 'Grid is down. Thermal is unaffected — keep sweeping.'
            : 'Lights just went. Switching to hand-lamps.'
        }"`,
      );
    }
    this.log('agent', `Grid cut for ${turns} turns — every cone shortened.`);
    this.emit();
    return {
      ok: true,
      message: `Power cut for ${turns} turns. All vision ranges drop to ${Math.round(
        BALANCE.vision.powerOutRangeMultiplier * 100,
      )}%.`,
    };
  }

  reroutePatrol(guardId: string, x: number, y: number): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;
    const guard = s.floor.guards.find((g) => g.id === guardId);
    if (!guard) return { ok: false, message: `No guard "${guardId}" on this floor.` };
    if (guard.state === 'hunting') {
      return { ok: false, message: `${guardId} is actively hunting — patrol orders are ignored.` };
    }
    if (guard.stationary) {
      return {
        ok: false,
        message: `${guardId} is a fixed ${ARCHETYPES[guard.archetype].name} and cannot be moved. Route around it, or blind it another way.`,
      };
    }
    if (!isWalkable(s.floor, x, y)) return { ok: false, message: 'That waypoint is not walkable.' };
    const cost = BALANCE.agent.cost.reroutePatrol;
    if (!this.spendBandwidth(cost)) {
      return { ok: false, message: `Needs ${cost} bandwidth; you have ${s.bandwidth}.` };
    }
    guard.route = [{ x, y }, ...guard.route];
    guard.routeIdx = 0;
    guard.state = 'patrol';
    guard.investigating = null;
    this.log('agent', `${guardId} patrol spoofed toward ${x},${y}.`);
    this.emit();
    return { ok: true, message: `${guardId} is now walking to ${x},${y}.` };
  }

  // -- turn resolution ----------------------------------------------------

  private afterOperativeAction(): void {
    const s = this.state;
    if (s.phase !== 'playing') return;
    this.checkSightings();
    if (s.phase === 'playing' && s.ap <= 0) {
      // auto-end when the operative is spent, so turns cannot stall
      this.endTurn();
    } else {
      this.emit();
    }
  }

  /** Alarm accounting — run every time the operative's position may have changed. */
  private checkSightings(): void {
    const s = this.state;
    const ctx = this.visionCtx;
    let spotted = false;
    let increase = 0;

    for (const guard of s.floor.guards) {
      if (guardSees(s.floor, guard, s.player, ctx)) {
        spotted = true;
        increase += BALANCE.alarm.perGuardSighting;
        guard.state = 'hunting';
        guard.investigating = { ...s.player };
        guard.patience = BALANCE.guard.patience;
      }
    }
    for (const camera of s.floor.cameras) {
      if (cameraSees(s.floor, camera, s.player, ctx)) {
        spotted = true;
        increase += BALANCE.alarm.perCameraSighting;
      }
    }

    if (spotted) {
      s.turnsUnseen = 0;
      s.alarm = Math.min(BALANCE.alarm.max, s.alarm + increase);
      this.raiseAlert(BALANCE.alert.perSighting, 'You were seen.');
      this.fire('spotted');
      this.log('hostile', `Operative observed — alarm ${s.alarm}%.`);
      if (s.alarm >= BALANCE.alarm.max) {
        this.failRun('Alarm hit 100% — facility locked down with you inside.');
      }
    }
  }

  /**
   * A guard standing close enough to touch that still has not seen you. The
   * data was always there — it is the difference between "nothing happened"
   * and the whole reason to play a stealth game.
   */
  private checkNearMiss(): void {
    const s = this.state;
    const close = s.floor.guards.some(
      (guard) => guard.stunTurns === 0 && chebyshev(guard, s.player) <= BALANCE.alarm.nearMissRange,
    );
    if (!close) {
      s.nearMiss = false;
      return;
    }
    // only announce the moment it becomes true, or it drones every turn
    if (!s.nearMiss) this.fire('near_miss');
    s.nearMiss = true;
  }

  endTurn(): ActionResult {
    const blocked = this.requirePlaying();
    if (blocked) return blocked;
    const s = this.state;

    this.resolveHostileTurn();
    if (s.phase !== 'playing') return { ok: true, message: 'Turn ended; run is over.' };

    // decay timers
    if (s.powerOutTurns > 0) s.powerOutTurns--;
    for (const camera of s.floor.cameras) {
      if (camera.disabledTurns > 0) camera.disabledTurns--;
    }
    for (const tile of s.floor.tiles) {
      if (tile.lockedTurns > 0) tile.lockedTurns--;
    }
    s.floor.noises = s.floor.noises
      .map((n) => ({ ...n, ttl: n.ttl - 1 }))
      .filter((n) => n.ttl > 0);
    s.floor.scanned.fill(false);

    this.checkBodyDiscovery();
    if (s.phase !== 'playing') return { ok: true, message: 'Turn ended; run is over.' };

    // alarm cools once nobody has eyes on you
    const seenBefore = s.turnsUnseen;
    this.checkSightings();
    if (s.phase !== 'playing') return { ok: true, message: 'Turn ended; run is over.' };
    // a guard that walked right past without seeing you is the best moment the
    // engine produces, and it used to pass in complete silence
    if (s.turnsUnseen >= seenBefore) this.checkNearMiss();
    s.turnsUnseen++;
    // under full lockdown the alarm never cools again, so hiding stops being an
    // escape and the only way out is out
    const lockedDown = s.alertStage >= BALANCE.alert.stageAt.length;
    if (s.turnsUnseen > BALANCE.alarm.decayDelayTurns && !lockedDown) {
      const multiplier = hasImplant(s.implants, 'staticveil')
        ? BALANCE.alarm.staticVeilMultiplier
        : 1;
      s.alarm = Math.max(0, s.alarm - BALANCE.alarm.decayPerTurn * multiplier);
    }

    s.turn++;
    // the clock: security tightens on its own schedule whether or not you move
    if (s.turn % BALANCE.alert.turnsPerTick === 0) {
      this.raiseAlert(BALANCE.alert.perTick, 'Another sweep cycle has passed.');
    }
    s.ap = s.maxAp;
    s.bandwidth = s.maxBandwidth;
    updateOperativeVisibility(s.floor, s.player);
    this.emit();
    return {
      ok: true,
      message: `Turn ${s.turn} begins. AP ${s.ap}/${s.maxAp}, bandwidth ${s.bandwidth}/${s.maxBandwidth}, alarm ${s.alarm}%.`,
      detail: { turn: s.turn, alarm: s.alarm },
    };
  }

  private resolveHostileTurn(): void {
    const s = this.state;
    const ctx = this.visionCtx;

    for (const guard of s.floor.guards) {
      if (s.phase !== 'playing') return;

      if (guard.stunTurns > 0) {
        guard.stunTurns--;
        continue;
      }

      const wasState = guard.state;

      // react to noise first — this is what makes agent distractions work
      const hearing = hearingMultiplier(guard.archetype);
      const heard = guard.deafToNoise
        ? undefined
        : s.floor.noises.find(
            (n) => Math.hypot(guard.x - n.x, guard.y - n.y) <= n.radius * hearing,
          );
      if (heard && guard.state !== 'hunting') {
        guard.state = 'suspicious';
        guard.investigating = { x: heard.x, y: heard.y };
        guard.patience = BALANCE.guard.patience;
      }

      if (guardSees(s.floor, guard, s.player, ctx)) {
        // a guard catching sight of you during its own turn counts every bit as
        // much as the sweep at the end of yours — escalate here too, or being
        // run down is the one sighting the facility never learns from
        if (guard.state !== 'hunting') {
          this.raiseAlert(BALANCE.alert.perSighting, `${guard.id} has eyes on you.`);
          this.fire('spotted');
        }
        guard.state = 'hunting';
        guard.investigating = { ...s.player };
        guard.patience = BALANCE.guard.patience;
      }

      const speed = guard.state === 'hunting' ? guard.huntSpeed : guard.patrolSpeed;
      for (let step = 0; step < speed; step++) {
        this.stepGuard(guard);
        if (chebyshev(guard, s.player) === 0) break;
      }

      this.barkOnChange(guard, wasState);

      // capture check — a hunting guard that reaches you ends the run
      if (guard.state === 'hunting' && chebyshev(guard, s.player) <= 1) {
        if (s.reflexAvailable) {
          s.reflexAvailable = false;
          const escape = this.findEscapeTile(guard);
          if (escape) {
            s.player = escape;
            guard.state = 'suspicious';
            guard.investigating = { x: guard.x, y: guard.y };
            guard.patience = BALANCE.guard.patience;
            this.log('system', 'Reflex Governor fired — you were thrown clear of the grab.');
            updateOperativeVisibility(s.floor, s.player);
            continue;
          }
        }
        this.failRun(`${guard.id} got hands on you.`);
        return;
      }
    }

    if (s.phase === 'playing') this.checkSightings();
  }

  /**
   * Say something when a guard's state changes. Guards used to switch between
   * patrolling and hunting you in total silence, which is what made them read
   * as furniture instead of staff.
   */
  private barkOnChange(guard: Guard, wasState: GuardState): void {
    if (guard.state === wasState) return;
    const lines = BARKS[guard.archetype];
    if (guard.state === 'hunting') {
      this.log('hostile', `${guard.id}: "${this.rng.pick(lines.hunting)}"`);
    } else if (guard.state === 'suspicious') {
      this.log('hostile', `${guard.id}: "${this.rng.pick(lines.suspicious)}"`);
    } else if (wasState !== 'patrol') {
      this.log('hostile', `${guard.id}: "${this.rng.pick(lines.lost)}"`);
    }
  }

  private stepGuard(guard: Guard): void {
    const s = this.state;
    if (guard.stationary) {
      // bolted down: it can only sweep its arc
      guard.facing = this.rotate(guard.facing);
      if (guard.state !== 'patrol') {
        guard.patience--;
        if (guard.patience <= 0) {
          guard.state = 'patrol';
          guard.investigating = null;
        }
      }
      return;
    }
    let target: Vec | null = null;

    if (guard.state === 'hunting' || guard.state === 'suspicious') {
      target = guard.investigating;
      if (target && samePos(guard, target)) {
        if (guard.state === 'hunting') {
          guard.state = 'suspicious';
          guard.patience = BALANCE.guard.patience;
        }
        guard.patience--;
        if (guard.patience <= 0) {
          guard.state = 'patrol';
          guard.investigating = null;
        }
        // sweep the area by turning in place
        guard.facing = this.rotate(guard.facing);
        return;
      }
    }

    if (!target) {
      if (!guard.route.length) return;
      target = guard.route[guard.routeIdx % guard.route.length];
      if (samePos(guard, target)) {
        guard.routeIdx = (guard.routeIdx + 1) % guard.route.length;
        guard.facing = this.rotate(guard.facing);
        return;
      }
    }

    const path = findPath(s.floor, guard, target);
    if (!path || !path.length) {
      // blocked (often by a door the agent sealed) — give up and re-plan next turn
      if (guard.state === 'patrol') guard.routeIdx = (guard.routeIdx + 1) % guard.route.length;
      else guard.patience--;
      if (guard.patience <= 0 && guard.state !== 'patrol') {
        guard.state = 'patrol';
        guard.investigating = null;
      }
      return;
    }

    const next = path[0];
    const tile = tileAt(s.floor, next.x, next.y);
    if (tile?.kind === 'door' && !tile.open) {
      if (tile.lockedTurns > 0) {
        // sealed doors genuinely stop guards — the agent bought real time
        if (guard.state === 'patrol') guard.routeIdx = (guard.routeIdx + 1) % guard.route.length;
        return;
      }
      tile.open = true;
      return;
    }
    if (!isWalkable(s.floor, next.x, next.y)) return;

    guard.facing = { dx: Math.sign(next.x - guard.x), dy: Math.sign(next.y - guard.y) };
    guard.x = next.x;
    guard.y = next.y;
  }

  private rotate(facing: { dx: number; dy: number }): { dx: number; dy: number } {
    // 90° clockwise so idle guards sweep their surroundings
    return { dx: -facing.dy, dy: facing.dx };
  }

  private findEscapeTile(from: Vec): Vec | null {
    const s = this.state;
    let best: Vec | null = null;
    let bestScore = -Infinity;
    for (let y = 0; y < s.floor.height; y++) {
      for (let x = 0; x < s.floor.width; x++) {
        if (!isWalkable(s.floor, x, y)) continue;
        const d = manhattan({ x, y }, from);
        if (d < 3 || d > 7) continue;
        const threat = tileThreat(s.floor, { x, y }, this.visionCtx);
        const score = d - threat.risk * 2;
        if (score > bestScore) {
          bestScore = score;
          best = { x, y };
        }
      }
    }
    return best;
  }

  // -- descriptions used by the agent-facing tools -------------------------

  describeGuard(guard: Guard): Record<string, unknown> {
    const spec = ARCHETYPES[guard.archetype];
    return {
      id: guard.id,
      archetype: guard.archetype,
      unit: spec.name,
      threat: spec.threat,
      position: { x: guard.x, y: guard.y },
      facing: this.facingName(guard.facing),
      state: guard.state,
      visionRange: guard.visionRange,
      coneHalfAngleDeg: guard.coneHalfAngleDeg,
      stunned: guard.stunTurns > 0,
      investigating: guard.investigating,
    };
  }

  describeCamera(camera: Camera): Record<string, unknown> {
    return {
      id: camera.id,
      position: { x: camera.x, y: camera.y },
      facing: this.facingName(camera.facing),
      visionRange: camera.visionRange,
      disabled: camera.disabledTurns > 0,
      disabledTurns: camera.disabledTurns,
    };
  }

  facingName(facing: { dx: number; dy: number }): string {
    if (facing.dy < 0 && facing.dx === 0) return 'north';
    if (facing.dy > 0 && facing.dx === 0) return 'south';
    if (facing.dx > 0 && facing.dy === 0) return 'east';
    if (facing.dx < 0 && facing.dy === 0) return 'west';
    const vertical = facing.dy < 0 ? 'north' : 'south';
    const horizontal = facing.dx > 0 ? 'east' : 'west';
    return `${vertical}-${horizontal}`;
  }

  /** Threat lookup used by both the renderer and `plan_route`. */
  threatAt(x: number, y: number) {
    return tileThreat(this.state.floor, { x, y }, this.visionCtx);
  }

  /** A route plus a per-step explanation of what makes it dangerous. */
  planRoute(x: number, y: number) {
    const s = this.state;
    const path = findPath(s.floor, s.player, { x, y });
    if (!path) return null;
    const steps = path.map((step, i) => {
      const threat = this.threatAt(step.x, step.y);
      return {
        order: i + 1,
        x: step.x,
        y: step.y,
        risk: threat.risk,
        watchedBy: threat.watchedBy,
        cover: threat.inCover,
      };
    });
    const totalRisk = steps.reduce((sum, step) => sum + step.risk, 0);
    const worst = steps.reduce(
      (acc, step) => (step.risk > (acc?.risk ?? -1) ? step : acc),
      null as (typeof steps)[number] | null,
    );
    return {
      length: steps.length,
      apRequired: steps.length * BALANCE.apCost.move,
      totalRisk,
      exposedSteps: steps.filter((step) => step.risk > 0).length,
      mostDangerousStep: worst && worst.risk > 0 ? worst : null,
      steps,
    };
  }
}
