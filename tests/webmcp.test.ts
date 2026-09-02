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

test('an agent can only start the floor through the phase-scoped tool', async () => {
  const { game, surface } = await freshSurface();
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

test('move_operative moves the operative and spends action points', async () => {
  const { game } = await freshSurface();
  await context.call('begin_infiltration');

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
  const { game } = await freshSurface();
  await context.call('begin_infiltration');

  const guard = game.state.floor.guards[0];
  assert.ok(guard, 'the floor must have spawned at least one guard');
  const spot = { x: guard.x, y: guard.y };

  const result = await context.call('trigger_distraction', spot);
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.equal(guard.state, 'suspicious');
  assert.deepEqual(guard.investigating, spot);
});

test('tools refuse impossible requests instead of silently succeeding', async () => {
  await freshSurface();
  await context.call('begin_infiltration');

  const badCamera = await context.call('loop_camera', { camera_id: 'cam-does-not-exist' });
  assert.equal(badCamera.isError, true, 'an unknown camera id must be an error');

  const offMap = await context.call('assess_tile', { x: -5, y: -5 });
  assert.equal(offMap.isError, true, 'an off-map tile must be an error');

  const noArgs = await context.call('plan_route', {});
  assert.equal(noArgs.isError, true, 'missing coordinates must be an error');
});

test('plan_route names the guard watching the route it returns', async () => {
  const { game } = await freshSurface();
  await context.call('begin_infiltration');

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
  const { game } = await freshSurface();
  await context.call('begin_infiltration');

  const result = await context.call('cut_power');
  assert.notEqual(result.isError, true, result.content[0].text);
  assert.ok(game.state.powerOutTurns > 0, 'the engine must record an active blackout');

  const situation = payload(await context.call('get_situation'));
  assert.equal(situation.powerOutTurnsRemaining, game.state.powerOutTurns);
});
