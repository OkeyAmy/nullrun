import { BALANCE } from './config';
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
  FloorState,
  GameState,
  Guard,
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

export class Game {
  state!: GameState;
  private listeners = new Set<() => void>();
  private rng = new RNG(1);

  constructor() {
    this.newRun();
  }

  // -- lifecycle ---------------------------------------------------------

  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    for (const fn of this.listeners) fn();
  }

  newRun(seed = Math.floor(Math.random() * 1_000_000)): void {
    const meta = loadMeta();
    this.rng = new RNG(seed);
    const floor = this.buildFloor(seed, 0);
    const start = floorStart(floor);
    const previousMode = this.state?.mode ?? null;
    this.state = {
      phase: previousMode ? 'briefing' : 'mode_select',
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
      implants: [],
      implantChoices: [],
      intelThisRun: 0,
      bankedIntel: meta.bankedIntel,
      log: [],
      seed,
      endReason: '',
      reflexAvailable: false,
    };
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
    if (s.phase !== 'mode_select' && s.phase !== 'briefing') {
      return { ok: false, message: `Play mode cannot be changed during phase "${s.phase}".` };
    }
    s.mode = mode;
    if (s.phase === 'mode_select') s.phase = 'briefing';
    this.log(
      'system',
      mode === 'coop'
        ? 'Co-op: operative on the ground, agent handler on the network.'
        : 'Agent-run infiltration — the handler has the operative too.',
    );
    this.emit();
    return {
      ok: true,
      message: `Play mode set to "${mode}".`,
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
    this.refreshResources();
    updateOperativeVisibility(floor, s.player);
    this.log('system', `Floor ${index + 1} of ${BALANCE.run.floors}. Security posture increased.`);
    this.emit();
  }

  private bankIntel(): void {
    const meta = loadMeta();
    meta.bankedIntel += this.state.intelThisRun;
    saveMeta(meta);
    this.state.bankedIntel = meta.bankedIntel;
  }

  private failRun(reason: string): void {
    const s = this.state;
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
    updateOperativeVisibility(s.floor, s.player);
    this.afterOperativeAction();
    return { ok: true, message: `Moved to ${target.x},${target.y}.` };
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
      (g) => g.stunTurns === 0 && Math.hypot(g.x - x, g.y - y) <= radius,
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
      this.log('hostile', `Operative observed — alarm ${s.alarm}%.`);
      if (s.alarm >= BALANCE.alarm.max) {
        this.failRun('Alarm hit 100% — facility locked down with you inside.');
      }
    }
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

    // alarm cools once nobody has eyes on you
    this.checkSightings();
    if (s.phase !== 'playing') return { ok: true, message: 'Turn ended; run is over.' };
    s.turnsUnseen++;
    if (s.turnsUnseen > BALANCE.alarm.decayDelayTurns) {
      const multiplier = hasImplant(s.implants, 'staticveil')
        ? BALANCE.alarm.staticVeilMultiplier
        : 1;
      s.alarm = Math.max(0, s.alarm - BALANCE.alarm.decayPerTurn * multiplier);
    }

    s.turn++;
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

      // react to noise first — this is what makes agent distractions work
      const heard = s.floor.noises.find((n) => Math.hypot(guard.x - n.x, guard.y - n.y) <= n.radius);
      if (heard && guard.state !== 'hunting') {
        guard.state = 'suspicious';
        guard.investigating = { x: heard.x, y: heard.y };
        guard.patience = BALANCE.guard.patience;
      }

      if (guardSees(s.floor, guard, s.player, ctx)) {
        guard.state = 'hunting';
        guard.investigating = { ...s.player };
        guard.patience = BALANCE.guard.patience;
      }

      const speed = guard.state === 'hunting' ? BALANCE.guard.huntSpeed : BALANCE.guard.patrolSpeed;
      for (let step = 0; step < speed; step++) {
        this.stepGuard(guard);
        if (chebyshev(guard, s.player) === 0) break;
      }

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

  private stepGuard(guard: Guard): void {
    const s = this.state;
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
    return {
      id: guard.id,
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
