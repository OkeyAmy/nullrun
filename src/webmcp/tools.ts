import { BALANCE } from '../game/config';
import type { Game, ActionResult } from '../game/game';
import { isWalkable, tileAt, tileIndex } from '../game/grid';
import { ALL_IMPLANTS } from '../game/implants';
import type { RunPhase } from '../game/types';
import {
  connectBridge,
  errorResponse,
  textResponse,
  type Bridge,
  type ToolDescriptor,
  type ToolResponse,
} from './bridge';

type Args = Record<string, unknown>;

function isAbortError(error: unknown): boolean {
  return (
    error instanceof Error && (error.name === 'AbortError' || /abort/i.test(error.message))
  );
}

function num(args: Args, key: string): number | null {
  const value = args[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function str(args: Args, key: string): string | null {
  const value = args[key];
  return typeof value === 'string' && value.length ? value : null;
}

const XY_SCHEMA = {
  type: 'object',
  properties: {
    x: { type: 'number', description: 'Tile column, 0-indexed from the left edge.' },
    y: { type: 'number', description: 'Tile row, 0-indexed from the top edge.' },
  },
  required: ['x', 'y'],
} as const;

/**
 * The agent-facing surface of NULLRUN.
 *
 * These are not wrappers around clicks. The agent is the operative's remote
 * handler: it has its own resource (bandwidth), its own abilities the human
 * physically cannot perform (cutting power, looping cameras, spoofing patrol
 * routes), and read tools that return *reasoning material* — who watches a
 * tile and why a route is dangerous — rather than raw pixels.
 */
export class ToolSurface {
  readonly bridge: Bridge;
  private registration = new AbortController();
  private phaseRegistration: AbortController | null = null;
  private lastPhase: RunPhase | null = null;
  private syncQueue: Promise<void> = Promise.resolve();
  /** Names of every tool currently registered, for the in-game HUD. */
  registered: string[] = [];

  constructor(private game: Game) {
    this.bridge = connectBridge();
  }

  get available(): boolean {
    return this.bridge.context !== null;
  }

  async install(): Promise<void> {
    const context = this.bridge.context;
    if (!context) return;
    for (const tool of this.coreTools()) {
      await context.registerTool(tool, { signal: this.registration.signal });
      this.registered.push(tool.name);
    }
    await this.syncPhaseTools();
  }

  /**
   * Phase-scoped tools appear only when they are actually usable.
   *
   * Syncs are serialised: a phase change can land while a previous sync is
   * still awaiting registration, and aborting that registration mid-flight
   * would otherwise surface as an unhandled AbortError.
   */
  syncPhaseTools(): Promise<void> {
    this.syncQueue = this.syncQueue
      // Yield a full task first. A phase change is usually triggered from
      // inside a tool's own execute(); aborting the registration synchronously
      // would cancel the very call that caused it, and the caller would see
      // "Tool unregistered" instead of its result.
      .then(() => new Promise<void>((resolve) => setTimeout(resolve, 0)))
      .then(() => this.runPhaseSync())
      .catch((error) => {
        if (!isAbortError(error)) console.warn('[nullrun] phase tool sync failed', error);
      });
    return this.syncQueue;
  }

  private async runPhaseSync(): Promise<void> {
    const context = this.bridge.context;
    if (!context) return;
    const phase = this.game.state.phase;
    if (phase === this.lastPhase) return;
    this.lastPhase = phase;

    this.phaseRegistration?.abort();
    const controller = new AbortController();
    this.phaseRegistration = controller;

    const tools = this.phaseTools(phase);
    for (const tool of tools) {
      if (controller.signal.aborted) return;
      try {
        await context.registerTool(tool, { signal: controller.signal });
      } catch (error) {
        if (isAbortError(error)) return;
        throw error;
      }
    }
    this.registered = [
      ...this.coreTools().map((t) => t.name),
      ...tools.map((t) => t.name),
    ];
  }

  dispose(): void {
    this.registration.abort();
    this.phaseRegistration?.abort();
    this.registered = [];
  }

  /**
   * An agent arriving cold should be able to just act. The opening screen and
   * the briefing are human affordances; if a handler calls a gameplay tool
   * before they have been answered, start the run for it rather than making it
   * click through a UI it cannot see.
   */
  private autostart(): void {
    const phase = this.game.state.phase;
    if (phase !== 'mode_select' && phase !== 'briefing') return;
    if (!this.game.state.mode) this.game.setMode('agent');
    this.game.beginInfiltration();
  }

  /**
   * What the handler should consider doing next.
   *
   * A tool result that only reports what happened leaves an agent with no
   * reason to take another turn, so it stalls after one call. Every action
   * answers with concrete follow-up calls derived from live state — the budget
   * left, the threat standing on the operative, the objective still open.
   */
  private nextSteps(): Array<{ tool: string; why: string; args?: Record<string, unknown> }> {
    const s = this.game.state;
    const steps: Array<{ tool: string; why: string; args?: Record<string, unknown> }> = [];

    if (s.phase === 'mode_select') {
      steps.push({
        tool: 'set_play_mode',
        why: 'Choose who plays. Or just call any gameplay tool — the run starts itself.',
        args: { mode: 'agent' },
      });
      return steps;
    }
    if (s.phase === 'briefing') {
      steps.push({ tool: 'begin_infiltration', why: 'Start the floor.' });
      return steps;
    }
    if (s.phase === 'choosing_implant') {
      steps.push({
        tool: 'choose_implant',
        why: `Pick one of: ${s.implantChoices.map((i) => i.id).join(', ')}. The next floor starts immediately after.`,
      });
      return steps;
    }
    if (s.phase === 'run_failed' || s.phase === 'run_complete') {
      steps.push({ tool: 'start_new_run', why: 'The run is over. Banked intel carries across.' });
      return steps;
    }

    const floor = s.floor;
    const known = (x: number, y: number) => floor.discovered[tileIndex(floor, x, y)];
    const here = this.game.threatAt(s.player.x, s.player.y);
    const adjacentTerminal = floor.terminals.find(
      (t) => !t.hacked && Math.max(Math.abs(t.x - s.player.x), Math.abs(t.y - s.player.y)) <= 1,
    );
    const onLoot = floor.loot.find((l) => !l.taken && l.x === s.player.x && l.y === s.player.y);
    const onPad = s.player.x === floor.extraction.x && s.player.y === floor.extraction.y;
    const hunters = floor.guards.filter((g) => g.state === 'hunting' && g.stunTurns === 0);
    const knownCores = floor.terminals.filter((t) => t.kind === 'data' && !t.hacked && known(t.x, t.y));

    // urgent first: being seen or chased outranks the objective
    if (hunters.length) {
      steps.push({
        tool: 'cycle_door',
        why: `${hunters.map((g) => g.id).join(', ')} hunting. Sealing a door between you stops it pathing through for 3 turns.`,
        args: { seal: true },
      });
    }
    if (here.watchedBy.length) {
      steps.push({
        tool: 'assess_tile',
        why: `You are watched by ${here.watchedBy.join(', ')} right now. Find an unwatched neighbouring tile before ending the turn — alarm rises every turn you are seen.`,
      });
      if (s.bandwidth >= BALANCE.agent.cost.cutPower) {
        steps.push({ tool: 'cut_power', why: 'Shortens every cone to 40% for 3 turns.' });
      }
    }

    if (adjacentTerminal) {
      steps.push({
        tool: 'hack_terminal',
        why: `${adjacentTerminal.id} is within reach (${adjacentTerminal.kind === 'data' ? 'objective' : 'reveals the map and cuts the alarm'}).`,
      });
    }
    if (onLoot) steps.push({ tool: 'grab_intel', why: 'An intel cache is on this tile.' });
    if (onPad && this.game.objectiveComplete()) {
      steps.push({ tool: 'extract', why: 'All cores siphoned and you are on the pad. This clears the floor.' });
    }

    if (this.game.dataCoresRemaining() > 0) {
      if (!knownCores.length) {
        steps.push({
          tool: 'ping_scan',
          why: 'No data core discovered yet. Sweep unexplored areas to find one before moving blind.',
        });
      } else {
        const core = knownCores[0];
        steps.push({
          tool: 'plan_route',
          why: `Route to core ${core.id} and read the per-step risk before walking it.`,
          args: { x: core.x, y: core.y },
        });
      }
    } else if (!onPad) {
      steps.push({
        tool: 'plan_route',
        why: 'Cores are done. Route to the extraction pad.',
        args: { x: floor.extraction.x, y: floor.extraction.y },
      });
    }

    if (s.ap <= 0) {
      steps.push({
        tool: 'end_turn',
        why: 'No action points left. Guards move, then AP and bandwidth refill.',
      });
    } else {
      steps.push({
        tool: 'move_operative',
        why: `${s.ap} AP left. Prefer a destination whose risk is 0 — ending a turn inside a cone is how runs end.`,
      });
    }

    return steps;
  }

  /** Attach the continuation signal to an action result. */
  private respond(result: ActionResult): ToolResponse {
    if (!result.ok) {
      const recovery = this.nextSteps();
      return errorResponse(
        `${result.message}\n\nStill to do: ${recovery.map((s) => s.tool).join(', ') || 'none'}`,
      );
    }
    const s = this.game.state;
    const steps = this.nextSteps();
    return textResponse(result.message, {
      ...(result.detail ?? {}),
      turn: s.turn,
      actionPoints: s.ap,
      bandwidth: s.bandwidth,
      alarm: s.alarm,
      phase: s.phase,
      nextSteps: steps,
      continue:
        steps.length > 0
          ? `The run is still live — keep going by calling ${steps[0].tool}.`
          : 'Nothing further to do.',
    });
  }

  // -- tool definitions ---------------------------------------------------

  private coreTools(): ToolDescriptor[] {
    const game = this.game;

    return [
      {
        name: 'set_play_mode',
        description:
          'Set or change who is at the controls, and hand control over mid-run. "coop" means a human moves the operative while you work the facility network — scanning, looping cameras, sealing doors, cutting power. "agent" means you take both roles and play the whole run yourself. Callable at any point during a run.',
        inputSchema: {
          type: 'object',
          properties: {
            mode: {
              type: 'string',
              enum: ['coop', 'agent'],
              description:
                'coop = human operative + agent handler; agent = you play both roles.',
            },
          },
          required: ['mode'],
        },
        execute: (args: Args) => {
          const mode = str(args, 'mode');
          if (mode !== 'coop' && mode !== 'agent') {
            return errorResponse('mode must be either "coop" or "agent".');
          }
          const result = game.setMode(mode);
          void this.syncPhaseTools();
          return result.ok
            ? textResponse(result.message, {
                ...(result.detail ?? {}),
                nextStep: 'Call begin_infiltration to start the floor.',
              })
            : errorResponse(result.message);
        },
      },
      {
        name: 'get_situation',
        description:
          'Read the complete tactical picture of the current floor: operative position and resources, alarm level, every discovered guard with facing and alert state, cameras, objectives, and the threat on the tile the operative is standing on. Call this before deciding anything. The response ends with a nextSteps list telling you which tools are worth calling right now and why — keep acting on it until the floor is cleared or the run ends.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => textResponse('Tactical snapshot.', this.situation()),
      },
      {
        name: 'assess_tile',
        description:
          'Explain a single tile: what terrain it is, whether it is walkable, whether it gives cover, and exactly which guards or cameras currently have eyes on it. Use to sanity-check a hiding spot before committing the operative to it.',
        inputSchema: XY_SCHEMA as unknown as Record<string, unknown>,
        execute: (args: Args) => {
          const x = num(args, 'x');
          const y = num(args, 'y');
          if (x === null || y === null) return errorResponse('x and y are required numbers.');
          const floor = game.state.floor;
          const tile = tileAt(floor, x, y);
          if (!tile) return errorResponse(`Tile ${x},${y} is outside the facility.`);
          const threat = game.threatAt(x, y);
          return textResponse(
            threat.watchedBy.length
              ? `Tile ${x},${y} is watched by ${threat.watchedBy.join(', ')}.`
              : `Tile ${x},${y} is currently unobserved.`,
            {
              terrain: tile.kind,
              doorOpen: tile.kind === 'door' ? tile.open : undefined,
              doorSealedTurns: tile.lockedTurns || undefined,
              walkable: isWalkable(floor, x, y),
              givesCover: threat.inCover,
              risk: threat.risk,
              watchedBy: threat.watchedBy,
              discovered: floor.discovered[tileIndex(floor, x, y)],
            },
          );
        },
      },
      {
        name: 'plan_route',
        description:
          'Compute the walking route from the operative to a target tile and return a per-step risk breakdown — which step is exposed, to whom, and where cover exists. Returns the AP cost so you can tell whether the move fits in this turn. This does not move anyone.',
        inputSchema: XY_SCHEMA as unknown as Record<string, unknown>,
        execute: (args: Args) => {
          const x = num(args, 'x');
          const y = num(args, 'y');
          if (x === null || y === null) return errorResponse('x and y are required numbers.');
          const plan = game.planRoute(x, y);
          if (!plan) {
            return errorResponse(
              `No walkable route to ${x},${y}. A sealed door may be in the way — try cycle_door.`,
            );
          }
          const summary = plan.mostDangerousStep
            ? `Route is ${plan.length} steps, ${plan.apRequired} AP, ${plan.exposedSteps} exposed step(s). Worst point is ${plan.mostDangerousStep.x},${plan.mostDangerousStep.y} watched by ${plan.mostDangerousStep.watchedBy.join(', ')}.`
            : `Route is ${plan.length} steps, ${plan.apRequired} AP, and currently unobserved the whole way.`;
          return textResponse(summary, plan);
        },
      },
      {
        name: 'list_abilities',
        description:
          'List every operative action and agent ability with its live cost, whether you can currently afford it, and what it does. Use this to plan a turn against the real AP and bandwidth economy instead of guessing.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => textResponse('Ability economy.', this.abilities()),
      },
      {
        name: 'get_run_status',
        description:
          'Report roguelite run progress: current floor, installed implants, intel gathered this run, banked intel across runs, and how the run ended if it is over.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => {
          const s = game.state;
          return textResponse(`Floor ${s.floor.index + 1} of ${BALANCE.run.floors}.`, {
            phase: s.phase,
            floor: s.floor.index + 1,
            totalFloors: BALANCE.run.floors,
            turn: s.turn,
            implants: s.implants.map((i) => ({ id: i.id, name: i.name, effect: i.description })),
            intelThisRun: s.intelThisRun,
            bankedIntel: s.bankedIntel,
            endReason: s.endReason || undefined,
            seed: s.seed,
          });
        },
      },

      // --- operative commands (spend action points) ----------------------
      {
        name: 'move_operative',
        description:
          'Order the operative to walk to a tile, spending 1 AP per step. Set sprint=true to dash up to 3 tiles for 2 AP total — fast but it makes noise that pulls guards. Movement stops early if AP runs out.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Destination column.' },
            y: { type: 'number', description: 'Destination row.' },
            sprint: {
              type: 'boolean',
              description: 'Dash instead of sneaking. Faster, but generates a noise event.',
            },
          },
          required: ['x', 'y'],
        },
        execute: (args: Args) => {
          const x = num(args, 'x');
          const y = num(args, 'y');
          if (x === null || y === null) return errorResponse('x and y are required numbers.');
          this.autostart();
          return this.respond(game.moveTo(x, y, args.sprint === true));
        },
      },
      {
        name: 'hack_terminal',
        description:
          'Hack a terminal the operative is standing next to. Data cores are the floor objective; security nodes reveal the whole floor map and cut the alarm by 30. Costs AP.',
        inputSchema: {
          type: 'object',
          properties: {
            terminal_id: {
              type: 'string',
              description: 'Optional terminal id; defaults to whichever is adjacent.',
            },
          },
        },
        execute: (args: Args) => {
          this.autostart();
          return this.respond(game.hack(str(args, 'terminal_id') ?? undefined));
        },
      },
      {
        name: 'grab_intel',
        description:
          'Pick up the intel cache on the operative\'s current tile. Intel is banked between runs and unlocks progression.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => {
          this.autostart();
          return this.respond(game.grab());
        },
      },
      {
        name: 'operate_door',
        description:
          'Have the operative physically open or shut an adjacent door. Costs AP and makes noise — the agent ability cycle_door is quieter and works at range.',
        inputSchema: XY_SCHEMA as unknown as Record<string, unknown>,
        execute: (args: Args) => {
          const x = num(args, 'x');
          const y = num(args, 'y');
          if (x === null || y === null) return errorResponse('x and y are required numbers.');
          this.autostart();
          return this.respond(game.toggleDoor(x, y));
        },
      },
      {
        name: 'extract',
        description:
          'Extract from the floor. Only works when the operative is standing on the extraction pad and every data core has been siphoned. Clearing a floor offers an implant choice.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => {
          this.autostart();
          return this.respond(game.extract());
        },
      },
      {
        name: 'end_turn',
        description:
          'End the operative\'s turn. Guards then move, cameras sweep, timers tick down, and AP and bandwidth refill. Ending a turn while standing in a vision cone is how runs die.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => {
          this.autostart();
          return this.respond(game.endTurn());
        },
      },

      // --- agent abilities (spend bandwidth) ------------------------------
      {
        name: 'ping_scan',
        description:
          'Sweep an area of the facility from the network side, revealing terrain, guards and cameras around a point even where the operative cannot see. Guards inside the sweep notice the probe and the alarm ticks up slightly, so do not spam it.',
        inputSchema: XY_SCHEMA as unknown as Record<string, unknown>,
        execute: (args: Args) => {
          const x = num(args, 'x');
          const y = num(args, 'y');
          if (x === null || y === null) return errorResponse('x and y are required numbers.');
          this.autostart();
          return this.respond(game.ping(x, y));
        },
      },
      {
        name: 'cycle_door',
        description:
          'Remotely open a door, or seal it shut so guards physically cannot path through it for several turns. Sealing a door mid-chase is the strongest escape tool the agent has.',
        inputSchema: {
          type: 'object',
          properties: {
            x: { type: 'number', description: 'Door column.' },
            y: { type: 'number', description: 'Door row.' },
            seal: {
              type: 'boolean',
              description: 'true locks the door against guards; false opens it.',
            },
          },
          required: ['x', 'y'],
        },
        execute: (args: Args) => {
          const x = num(args, 'x');
          const y = num(args, 'y');
          if (x === null || y === null) return errorResponse('x and y are required numbers.');
          this.autostart();
          return this.respond(game.agentToggleDoor(x, y, args.seal === true));
        },
      },
      {
        name: 'loop_camera',
        description:
          'Loop a camera feed so it stops seeing anything for several turns. Use get_situation to read camera ids.',
        inputSchema: {
          type: 'object',
          properties: { camera_id: { type: 'string', description: 'Camera id, e.g. "cam-0".' } },
          required: ['camera_id'],
        },
        execute: (args: Args) => {
          const id = str(args, 'camera_id');
          if (!id) return errorResponse('camera_id is required.');
          this.autostart();
          return this.respond(game.loopCamera(id));
        },
      },
      {
        name: 'trigger_distraction',
        description:
          'Blow a speaker somewhere in the facility to create a loud noise. Every guard in range abandons what they are doing and investigates that spot — the core tool for opening a path for the operative.',
        inputSchema: XY_SCHEMA as unknown as Record<string, unknown>,
        execute: (args: Args) => {
          const x = num(args, 'x');
          const y = num(args, 'y');
          if (x === null || y === null) return errorResponse('x and y are required numbers.');
          this.autostart();
          return this.respond(game.distraction(x, y));
        },
      },
      {
        name: 'cut_power',
        description:
          'Kill the facility grid for several turns, shortening every guard and camera vision cone to 40% of its range. Expensive in bandwidth; best saved for crossing a wide open room.',
        inputSchema: { type: 'object', properties: {} },
        execute: () => {
          this.autostart();
          return this.respond(game.cutPower());
        },
      },
      {
        name: 'reroute_patrol',
        description:
          'Spoof a guard\'s patrol orders so it walks to a waypoint you choose. Only works on guards that are not already hunting the operative.',
        inputSchema: {
          type: 'object',
          properties: {
            guard_id: { type: 'string', description: 'Guard id, e.g. "guard-2".' },
            x: { type: 'number', description: 'Waypoint column.' },
            y: { type: 'number', description: 'Waypoint row.' },
          },
          required: ['guard_id', 'x', 'y'],
        },
        execute: (args: Args) => {
          const id = str(args, 'guard_id');
          const x = num(args, 'x');
          const y = num(args, 'y');
          if (!id || x === null || y === null) {
            return errorResponse('guard_id, x and y are all required.');
          }
          this.autostart();
          return this.respond(game.reroutePatrol(id, x, y));
        },
      },
    ];
  }

  /** Tools that only exist while they are meaningful. */
  private phaseTools(phase: RunPhase): ToolDescriptor[] {
    const game = this.game;

    if (phase === 'briefing') {
      return [
        {
          name: 'begin_infiltration',
          description:
            'Start the floor. Call this once the briefing has been read; no other action is possible until it is called.',
          inputSchema: { type: 'object', properties: {} },
          execute: () => {
            game.beginInfiltration();
            void this.syncPhaseTools();
            return textResponse('Infiltration started.', this.situation());
          },
        },
      ];
    }

    if (phase === 'choosing_implant') {
      return [
        {
          name: 'choose_implant',
          description:
            'Pick one of the three implants offered after clearing a floor, then descend. Read get_situation first — the offered ids are listed there.',
          inputSchema: {
            type: 'object',
            properties: {
              implant_id: {
                type: 'string',
                description: 'Id of the offered implant.',
                enum: ALL_IMPLANTS.map((i) => i.id),
              },
            },
            required: ['implant_id'],
          },
          execute: (args: Args) => {
            const id = str(args, 'implant_id');
            if (!id) return errorResponse('implant_id is required.');
            const result = game.chooseImplant(id);
            void this.syncPhaseTools();
            return this.respond(result);
          },
        },
      ];
    }

    if (phase === 'run_failed' || phase === 'run_complete') {
      return [
        {
          name: 'start_new_run',
          description:
            'Begin a fresh run. Banked intel carries over. Optionally pass a seed to replay the same facility layout.',
          inputSchema: {
            type: 'object',
            properties: {
              seed: { type: 'number', description: 'Optional facility seed for a repeatable run.' },
            },
          },
          execute: (args: Args) => {
            const seed = num(args, 'seed');
            game.newRun(seed ?? undefined);
            void this.syncPhaseTools();
            return textResponse('New run generated.', this.situation());
          },
        },
      ];
    }

    return [];
  }

  // -- structured views ----------------------------------------------------

  /** The snapshot several tools return. Only reports what has been discovered. */
  situation(): Record<string, unknown> {
    const game = this.game;
    const s = game.state;
    const floor = s.floor;
    const known = (x: number, y: number) => floor.discovered[tileIndex(floor, x, y)];
    const here = game.threatAt(s.player.x, s.player.y);

    return {
      phase: s.phase,
      playMode: s.mode,
      yourRole:
        s.mode === 'agent'
          ? 'You control both the operative and the facility network.'
          : s.mode === 'coop'
            ? 'A human moves the operative. You run the facility network: scan, loop cameras, seal doors, cut power, reroute patrols.'
            : 'Not chosen yet — call set_play_mode.',
      floor: floor.index + 1,
      totalFloors: BALANCE.run.floors,
      turn: s.turn,
      mapSize: { width: floor.width, height: floor.height },
      operative: {
        position: { ...s.player },
        actionPoints: s.ap,
        maxActionPoints: s.maxAp,
        standingOn: tileAt(floor, s.player.x, s.player.y)?.kind,
        currentlyWatchedBy: here.watchedBy,
        inCover: here.inCover,
      },
      agent: {
        bandwidth: s.bandwidth,
        maxBandwidth: s.maxBandwidth,
      },
      alarm: {
        level: s.alarm,
        max: BALANCE.alarm.max,
        turnsUnobserved: s.turnsUnseen,
        note: 'At 100 the facility locks down and the run ends.',
      },
      powerOutTurnsRemaining: s.powerOutTurns,
      objective: {
        dataCoresRemaining: game.dataCoresRemaining(),
        extractionUnlocked: game.objectiveComplete(),
        extractionAt: { ...floor.extraction },
      },
      guards: floor.guards.filter((g) => known(g.x, g.y)).map((g) => game.describeGuard(g)),
      cameras: floor.cameras.filter((c) => known(c.x, c.y)).map((c) => game.describeCamera(c)),
      terminals: floor.terminals
        .filter((t) => known(t.x, t.y))
        .map((t) => ({
          id: t.id,
          kind: t.kind,
          position: { x: t.x, y: t.y },
          hacked: t.hacked,
        })),
      intelCaches: floor.loot
        .filter((l) => !l.taken && known(l.x, l.y))
        .map((l) => ({ id: l.id, position: { x: l.x, y: l.y }, value: l.value })),
      implantChoices:
        s.phase === 'choosing_implant'
          ? s.implantChoices.map((i) => ({ id: i.id, name: i.name, effect: i.description }))
          : undefined,
      recentEvents: s.log.slice(-8).map((entry) => `[T${entry.turn}] ${entry.actor}: ${entry.text}`),
      nextSteps: this.nextSteps(),
      continue:
        s.phase === 'run_failed' || s.phase === 'run_complete'
          ? 'The run is over — call start_new_run to play again.'
          : 'The run is live. Pick a tool from nextSteps and keep going until the floor is cleared or the run ends.',
    };
  }

  abilities(): Record<string, unknown> {
    const s = this.game.state;
    const hackCost = s.implants.some((i) => i.id === 'silenthack')
      ? BALANCE.apCost.hackSilent
      : BALANCE.apCost.hack;
    const cutPowerCost = s.implants.some((i) => i.id === 'coldboot')
      ? Math.max(1, BALANCE.agent.cost.cutPower - 1)
      : BALANCE.agent.cost.cutPower;

    return {
      actionPoints: { current: s.ap, max: s.maxAp },
      bandwidth: { current: s.bandwidth, max: s.maxBandwidth },
      operative: [
        { tool: 'move_operative', cost: `${BALANCE.apCost.move} AP per tile`, affordable: s.ap >= BALANCE.apCost.move },
        {
          tool: 'move_operative (sprint)',
          cost: `${BALANCE.apCost.sprint} AP for up to ${BALANCE.operative.sprintDistance} tiles`,
          affordable: s.ap >= BALANCE.apCost.sprint,
          warning: `Generates noise radius ${BALANCE.noise.sprint} unless Nullfield Soles are installed.`,
        },
        { tool: 'hack_terminal', cost: `${hackCost} AP`, affordable: s.ap >= hackCost },
        { tool: 'grab_intel', cost: `${BALANCE.apCost.grab} AP`, affordable: s.ap >= BALANCE.apCost.grab },
        { tool: 'operate_door', cost: `${BALANCE.apCost.toggleDoor} AP`, affordable: s.ap >= BALANCE.apCost.toggleDoor },
        { tool: 'extract', cost: 'free', affordable: true },
        { tool: 'end_turn', cost: 'free', affordable: true },
      ],
      agent: [
        { tool: 'ping_scan', cost: `${BALANCE.agent.cost.ping} bandwidth`, affordable: s.bandwidth >= BALANCE.agent.cost.ping },
        { tool: 'cycle_door', cost: `${BALANCE.agent.cost.toggleDoor} bandwidth`, affordable: s.bandwidth >= BALANCE.agent.cost.toggleDoor },
        { tool: 'loop_camera', cost: `${BALANCE.agent.cost.loopCamera} bandwidth`, affordable: s.bandwidth >= BALANCE.agent.cost.loopCamera },
        { tool: 'trigger_distraction', cost: `${BALANCE.agent.cost.distraction} bandwidth`, affordable: s.bandwidth >= BALANCE.agent.cost.distraction },
        { tool: 'cut_power', cost: `${cutPowerCost} bandwidth`, affordable: s.bandwidth >= cutPowerCost },
        { tool: 'reroute_patrol', cost: `${BALANCE.agent.cost.reroutePatrol} bandwidth`, affordable: s.bandwidth >= BALANCE.agent.cost.reroutePatrol },
      ],
    };
  }
}
