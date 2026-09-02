import assert from 'node:assert/strict';
import { beforeEach, test } from 'vitest';

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

/**
 * A stand-in for the browser's WebMCP implementation. It records what the page
 * registers and lets the test call tools exactly the way a connected agent
 * would — through `execute`, never through the UI.
 */
interface RecordedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute: (args: Record<string, unknown>) => Promise<ToolResult> | ToolResult;
  signal?: AbortSignal;
}

interface ToolResult {
  content: { type: string; text: string }[];
  isError?: boolean;
}

class FakeModelContext {
  tools: RecordedTool[] = [];

  registerTool(
    descriptor: Omit<RecordedTool, 'signal'>,
    options?: { signal?: AbortSignal },
  ): Promise<void> {
    const record: RecordedTool = { ...descriptor, signal: options?.signal };
    options?.signal?.addEventListener('abort', () => {
      this.tools = this.tools.filter((t) => t !== record);
    });
    this.tools = this.tools.filter((t) => t.name !== descriptor.name);
    this.tools.push(record);
    return Promise.resolve();
  }

  find(name: string): RecordedTool | undefined {
    return this.tools.find((t) => t.name === name);
  }

  async call(name: string, args: Record<string, unknown> = {}): Promise<ToolResult> {
    const tool = this.find(name);
    assert.ok(tool, `agent tried to call unregistered tool "${name}"`);
    return await tool.execute(args);
  }
}

let context: FakeModelContext;

beforeEach(() => {
  context = new FakeModelContext();
  (globalThis as Record<string, unknown>).document = { modelContext: context };
});

const { Game } = await import('../src/game/game.ts');
const { ToolSurface } = await import('../src/webmcp/tools.ts');

/** Parse the JSON payload that read tools append after their prose summary. */
function payload(result: ToolResult): Record<string, unknown> {
  const text = result.content[0].text;
  const start = text.indexOf('{');
  assert.ok(start >= 0, `expected a JSON payload, got: ${text}`);
  return JSON.parse(text.slice(start)) as Record<string, unknown>;
}

async function freshSurface() {
  const game = new Game();
  const surface = new ToolSurface(game);
  await surface.install();
  return { game, surface };
}

/** Answer the opening screen and start the floor, the way an agent would. */
async function startFloor(surface: InstanceType<typeof ToolSurface>, mode: 'coop' | 'agent' = 'coop') {
  await context.call('set_play_mode', { mode });
  await surface.syncPhaseTools();
  // picking AI drops straight into the floor; co-op still stops at the briefing
  if (context.find('begin_infiltration')) {
    await context.call('begin_infiltration');
    await surface.syncPhaseTools();
  }
}

test('the page registers its tool surface on document.modelContext', async () => {
  const { surface } = await freshSurface();
  assert.equal(surface.bridge.mode, 'native');

  const names = context.tools.map((t) => t.name);
  for (const expected of [
    'get_situation',
    'assess_tile',
    'plan_route',
    'list_abilities',
    'move_operative',
    'hack_terminal',
    'end_turn',
    'ping_scan',
    'cycle_door',
    'loop_camera',
    'trigger_distraction',
    'cut_power',
    'reroute_patrol',
  ]) {
    assert.ok(names.includes(expected), `tool "${expected}" was never registered`);
  }
});

test('every registered tool carries a description and an object input schema', async () => {
  await freshSurface();
  for (const tool of context.tools) {
    assert.ok(
      tool.description.length > 40,
      `tool "${tool.name}" needs a description an agent can act on`,
    );
    assert.equal(
      tool.inputSchema.type,
      'object',
      `tool "${tool.name}" must declare an object input schema`,
    );
  }
});

test('get_situation reports the operative position the engine actually holds', async () => {
  const { game } = await freshSurface();
  const data = payload(await context.call('get_situation'));
  const operative = data.operative as { position: { x: number; y: number } };
  assert.deepEqual(operative.position, game.state.player);
  assert.equal(data.turn, game.state.turn);
});

test('the opening screen gates the run behind set_play_mode', async () => {
  const { game, surface } = await freshSurface();
  assert.equal(game.state.phase, 'mode_select');
  assert.ok(context.find('set_play_mode'), 'the opening screen must expose set_play_mode');
  assert.equal(
    context.find('begin_infiltration'),
    undefined,
    'the floor cannot be started before a play mode is chosen',
  );

  await context.call('set_play_mode', { mode: 'coop' });
  await surface.syncPhaseTools();
  assert.equal(game.state.mode, 'coop');
  assert.equal(game.state.phase, 'briefing');
  assert.ok(context.find('begin_infiltration'), 'briefing must expose begin_infiltration');

  await context.call('begin_infiltration');
  assert.equal(game.state.phase, 'playing');

  await surface.syncPhaseTools();
  assert.equal(
    context.find('begin_infiltration'),
    undefined,
    'begin_infiltration must disappear once the floor has started',
  );
});

test('get_situation tells a connecting agent what its role is', async () => {
  const { surface } = await freshSurface();
  await startFloor(surface, 'coop');
  const data = payload(await context.call('get_situation'));
  assert.equal(data.playMode, 'coop');
  assert.match(String(data.yourRole), /human moves the operative/i);
});

test('move_operative moves the operative and spends action points', async () => {
  const { game, surface } = await freshSurface();
  await startFloor(surface);

  const start = { ...game.state.player };
  const apBefore = game.state.ap;
  const target = { x: start.x + 1, y: start.y };

  const plan = game.planRoute(target.x, target.y);
  if (!plan || plan.length === 0) return; // entry corner without an eastward neighbour

  await context.call('move_operative', target);
  assert.notDeepEqual(game.state.player, start, 'the operative must have moved');
  assert.ok(game.state.ap < apBefore, 'moving must cost action points');
});

test('trigger_distraction pulls a real guard off patrol', async () => {
  const { game, surface } = await freshSurface();
  await startFloor(surface);

  const guard = game.state.floor.guards[0];
  assert.ok(guard, 'the floor must have spawned at least one guard');
  const spot = { x: guard.x, y: guard.y };

  const result = await context.call('trigger_distraction', spot);
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(guard.state, 'suspicious');
  assert.deepEqual(guard.investigating, spot);
});

test('tools refuse impossible requests instead of silently succeeding', async () => {
  const { surface } = await freshSurface();
  await startFloor(surface);

  const badCamera = await context.call('loop_camera', { camera_id: 'cam-does-not-exist' });
  assert.equal(badCamera.isError, true, 'an unknown camera id must be an error');

  const offMap = await context.call('assess_tile', { x: -5, y: -5 });
  assert.equal(offMap.isError, true, 'an off-map tile must be an error');

  const noArgs = await context.call('plan_route', {});
  assert.equal(noArgs.isError, true, 'missing coordinates must be an error');
});

test('plan_route names the guard watching the route it returns', async () => {
  const { game, surface } = await freshSurface();
  await startFloor(surface);

  // put a guard directly in front of the operative, looking at them
  const player = game.state.player;
  game.state.floor.guards = [
    {
      id: 'guard-test',
      x: player.x,
      y: player.y + 2,
      facing: { dx: 0, dy: -1 },
      route: [],
      routeIdx: 0,
      state: 'patrol',
      investigating: null,
      patience: 0,
      visionRange: 6,
      coneHalfAngleDeg: 60,
      stunTurns: 0,
    },
  ];

  const result = await context.call('plan_route', { x: player.x, y: player.y + 1 });
  if (result.isError) return; // no walkable tile that way on this seed
  const data = payload(result);
  const steps = data.steps as { watchedBy: string[] }[];
  assert.ok(
    steps.some((step) => step.watchedBy.includes('guard-test')),
    'a route walking into a guard cone must name that guard',
  );
});

test('cut_power reports the blackout to the agent and the engine agrees', async () => {
  const { game, surface } = await freshSurface();
  await startFloor(surface);

  const result = await context.call('cut_power');
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.ok(game.state.powerOutTurns > 0, 'the engine must record an active blackout');

  const situation = payload(await context.call('get_situation'));
  assert.equal(situation.powerOutTurnsRemaining, game.state.powerOutTurns);
});

test('an agent can start playing by simply acting, with no UI steps', async () => {
  const { game } = await freshSurface();
  assert.equal(game.state.phase, 'mode_select', 'a fresh page waits on the opening screen');

  // no set_play_mode, no begin_infiltration — the handler just acts
  const result = await context.call('ping_scan', { x: 5, y: 5 });

  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(game.state.phase, 'playing', 'acting must start the run for an agent');
  assert.equal(game.state.mode, 'agent', 'an unattended start is an agent run');
});

test('autostart does not override a human who already chose co-op', async () => {
  const { game, surface } = await freshSurface();
  await context.call('set_play_mode', { mode: 'coop' });
  await surface.syncPhaseTools();
  assert.equal(game.state.phase, 'briefing');

  await context.call('ping_scan', { x: 5, y: 5 });

  assert.equal(game.state.phase, 'playing', 'the agent may still start the floor');
  assert.equal(game.state.mode, 'coop', 'the human\u2019s choice must survive');
});

test('read tools never start the run as a side effect', async () => {
  const { game } = await freshSurface();
  await context.call('get_situation');
  await context.call('list_abilities');
  await context.call('assess_tile', { x: 3, y: 3 });
  assert.equal(game.state.phase, 'mode_select', 'reads must be side-effect free');
});

test('every action result tells the agent how to keep going', async () => {
  const { surface } = await freshSurface();
  await startFloor(surface, 'agent');

  const result = await context.call('ping_scan', { x: 6, y: 6 });
  const data = payload(result);

  assert.ok(Array.isArray(data.nextSteps), 'an action must return a nextSteps list');
  assert.ok((data.nextSteps as unknown[]).length > 0, 'nextSteps must not be empty mid-run');
  assert.match(String(data.continue), /keep going/i);

  for (const step of data.nextSteps as { tool: string; why: string }[]) {
    assert.ok(context.find(step.tool), `nextSteps named "${step.tool}", which is not registered`);
    assert.ok(step.why.length > 15, `nextSteps entry "${step.tool}" needs a real reason`);
  }

  // the budget an agent needs in order to plan the rest of the turn
  assert.equal(data.actionPoints, surface['game'].state.ap);
  assert.equal(data.bandwidth, surface['game'].state.bandwidth);
});

test('the continuation signal changes with the situation', async () => {
  const { game, surface } = await freshSurface();
  await startFloor(surface, 'agent');

  // drain the turn: the agent should be told to end it
  game.state.ap = 0;
  const spent = payload(await context.call('ping_scan', { x: 4, y: 4 }));
  const spentTools = (spent.nextSteps as { tool: string }[]).map((s) => s.tool);
  assert.ok(spentTools.includes('end_turn'), 'with no AP the agent must be told to end the turn');

  // a hunting guard should push door-sealing to the front
  game.state.ap = game.state.maxAp;
  game.state.floor.guards[0].state = 'hunting';
  const chased = payload(await context.call('ping_scan', { x: 4, y: 4 }));
  const chasedTools = (chased.nextSteps as { tool: string }[]).map((s) => s.tool);
  assert.equal(chasedTools[0], 'cycle_door', 'a hunting guard must be the first thing raised');
});

test('a finished run still tells the agent what to do', async () => {
  const { game, surface } = await freshSurface();
  await startFloor(surface, 'agent');
  game.state.phase = 'run_failed';
  game.state.endReason = 'forced for the test';

  const data = payload(await context.call('get_situation'));
  const tools = (data.nextSteps as { tool: string }[]).map((s) => s.tool);
  assert.deepEqual(tools, ['start_new_run']);
  assert.match(String(data.continue), /start_new_run/);
});

test('choosing AI starts the floor immediately, with no briefing to click', async () => {
  const { game, surface } = await freshSurface();
  assert.equal(game.state.phase, 'mode_select');

  const result = await context.call('set_play_mode', { mode: 'agent' });
  await surface.syncPhaseTools();

  assert.equal(game.state.phase, 'playing', 'AI mode must not stop at the briefing');
  const data = payload(result);
  assert.equal(data.phase, 'playing');
  const tools = (data.nextSteps as { tool: string }[]).map((s) => s.tool);
  assert.ok(
    !tools.includes('begin_infiltration'),
    'AI mode must not ask an agent to begin a floor that is already live',
  );
  assert.ok(tools.length > 0, 'the agent must be handed something to do straight away');
});

test('choosing Human still shows the briefing to read', async () => {
  const { game, surface } = await freshSurface();
  await context.call('set_play_mode', { mode: 'coop' });
  await surface.syncPhaseTools();

  assert.equal(game.state.phase, 'briefing', 'a human should get the briefing');
  assert.ok(context.find('begin_infiltration'), 'begin_infiltration must be available to start it');
});

test('a repeat run in AI mode does not park the agent at a briefing', async () => {
  const { game, surface } = await freshSurface();
  await context.call('set_play_mode', { mode: 'agent' });
  await surface.syncPhaseTools();
  assert.equal(game.state.phase, 'playing');

  game.newRun(4242);
  await surface.syncPhaseTools();

  assert.equal(game.state.mode, 'agent', 'the mode choice should carry across runs');
  assert.equal(game.state.phase, 'playing', 'an agent run must not stop at the briefing');
});

test('a repeat run in Human mode still offers the briefing', async () => {
  const { game, surface } = await freshSurface();
  await context.call('set_play_mode', { mode: 'coop' });
  await surface.syncPhaseTools();

  game.newRun(4242);
  await surface.syncPhaseTools();

  assert.equal(game.state.mode, 'coop');
  assert.equal(game.state.phase, 'briefing');
});
