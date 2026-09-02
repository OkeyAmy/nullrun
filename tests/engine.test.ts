import assert from 'node:assert/strict';
import { test } from 'vitest';

// The engine persists meta-progress through localStorage; stub it before the
// game module is imported so these tests stay hermetic.
const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const { Game } = await import('../src/game/game.ts');
const { findPath, isWalkable, tileAt } = await import('../src/game/grid.ts');
const { generateFloor, floorConfig, floorStart } = await import('../src/game/mapgen.ts');
const { BALANCE } = await import('../src/game/config.ts');
const { tileThreat } = await import('../src/game/vision.ts');
import type { FloorState, Tile } from '../src/game/types.ts';

/** A hand-built 9x5 room so mechanics tests don't depend on generated layout. */
function sandboxFloor(): FloorState {
  const width = 9;
  const height = 5;
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const edge = x === 0 || y === 0 || x === width - 1 || y === height - 1;
      tiles.push({
        kind: edge ? 'wall' : 'floor',
        open: false,
        lockedTurns: 0,
        roomId: edge ? -1 : 0,
      });
    }
  }
  return {
    index: 0,
    width,
    height,
    tiles,
    guards: [],
    cameras: [],
    terminals: [],
    loot: [],
    extraction: { x: 7, y: 2 },
    discovered: new Array(width * height).fill(true),
    visible: new Array(width * height).fill(true),
    scanned: new Array(width * height).fill(false),
    noises: [],
  };
}

function sandboxGame() {
  const game = new Game();
  game.state.floor = sandboxFloor();
  game.state.player = { x: 1, y: 2 };
  game.state.phase = 'playing';
  game.state.alarm = 0;
  game.state.ap = 99;
  game.state.maxAp = 99;
  game.state.bandwidth = 99;
  game.state.maxBandwidth = 99;
  return game;
}

// --- generated floors are always completable -----------------------------

test('every generated floor has a walkable route from entry to extraction', () => {
  for (let seed = 1; seed <= 40; seed++) {
    for (let index = 0; index < BALANCE.run.floors; index++) {
      const floor = generateFloor(seed, floorConfig(index));
      const start = floorStart(floor);
      assert.ok(
        isWalkable(floor, start.x, start.y),
        `seed ${seed} floor ${index}: entry tile is not walkable`,
      );
      const path = findPath(floor, start, floor.extraction);
      assert.ok(path, `seed ${seed} floor ${index}: no route from entry to extraction`);
    }
  }
});

test('every generated floor places at least one data core, reachable from entry', () => {
  for (let seed = 1; seed <= 40; seed++) {
    const floor = generateFloor(seed, floorConfig(0));
    const cores = floor.terminals.filter((t) => t.kind === 'data');
    assert.ok(cores.length >= 1, `seed ${seed}: no data cores placed`);
    const start = floorStart(floor);
    for (const core of cores) {
      assert.ok(
        findPath(floor, start, { x: core.x, y: core.y }),
        `seed ${seed}: core ${core.id} unreachable`,
      );
    }
  }
});

// --- operative economy ----------------------------------------------------

test('a move costs exactly one action point and walls reject movement', () => {
  const game = sandboxGame();
  game.state.ap = 3;
  game.state.maxAp = 3;

  const before = game.state.ap;
  const ok = game.move(1, 0);
  assert.equal(ok.ok, true);
  assert.equal(game.state.ap, before - BALANCE.apCost.move);
  assert.deepEqual(game.state.player, { x: 2, y: 2 });

  game.state.player = { x: 1, y: 1 };
  const intoWall = game.move(0, -1);
  assert.equal(intoWall.ok, false, 'walking into a wall must fail');
});

test('extraction is refused while data cores remain and allowed once they are gone', () => {
  const game = sandboxGame();
  game.state.floor.terminals = [{ id: 'core-0', x: 3, y: 2, kind: 'data', hacked: false }];
  game.state.player = { ...game.state.floor.extraction };

  const blocked = game.extract();
  assert.equal(blocked.ok, false, 'extraction must be locked while a core is un-hacked');

  game.state.floor.terminals[0].hacked = true;
  const allowed = game.extract();
  assert.equal(allowed.ok, true, 'extraction must open once all cores are hacked');
});

test('sprinting emits a noise event that guards can hear', () => {
  const game = sandboxGame();
  game.state.player = { x: 1, y: 2 };
  const result = game.moveTo(4, 2, true);
  assert.equal(result.ok, true);
  assert.equal(
    game.state.floor.noises.length,
    1,
    'a sprint must register exactly one noise event',
  );
  assert.equal(game.state.floor.noises[0].radius, BALANCE.noise.sprint);
});

// --- the agent's abilities have to actually change the simulation ---------

test('sealing a door stops a hunting guard from pathing through it', () => {
  const game = sandboxGame();
  const floor = game.state.floor;
  // wall off the right half, leaving one door at x=5
  for (let y = 1; y < floor.height - 1; y++) {
    floor.tiles[y * floor.width + 5].kind = 'wall';
  }
  const door = floor.tiles[2 * floor.width + 5];
  door.kind = 'door';
  door.open = true;

  floor.guards = [
    {
      id: 'guard-0',
      x: 7,
      y: 2,
      facing: { dx: -1, dy: 0 },
      route: [{ x: 1, y: 2 }],
      routeIdx: 0,
      state: 'patrol',
      investigating: null,
      patience: 0,
      visionRange: 1,
      coneHalfAngleDeg: 10,
      stunTurns: 0,
    },
  ];
  game.state.player = { x: 1, y: 2 };

  const sealed = game.agentToggleDoor(5, 2, true);
  assert.equal(sealed.ok, true);
  const sealTurns = door.lockedTurns;
  assert.ok(sealTurns > 0, 'sealing must set a lock timer');

  // walk the clock forward through the whole seal window: the guard has more
  // than enough movement to reach the door, so if the seal is not enforced it
  // will cross and reach the operative's side.
  for (let turn = 0; turn < sealTurns; turn++) {
    game.endTurn();
    assert.ok(
      game.state.floor.guards[0].x >= 5,
      `guard crossed a sealed door on turn ${turn + 1}`,
    );
    assert.equal(door.open, false, `sealed door was opened on turn ${turn + 1}`);
  }
});

test('a distraction redirects guards to the noise instead of their patrol', () => {
  const game = sandboxGame();
  game.state.floor.guards = [
    {
      id: 'guard-0',
      x: 2,
      y: 2,
      facing: { dx: 1, dy: 0 },
      route: [{ x: 7, y: 2 }],
      routeIdx: 0,
      state: 'patrol',
      investigating: null,
      patience: 0,
      visionRange: 1,
      coneHalfAngleDeg: 10,
      stunTurns: 0,
    },
  ];

  const result = game.distraction(6, 3);
  assert.equal(result.ok, true);
  const guard = game.state.floor.guards[0];
  assert.equal(guard.state, 'suspicious');
  assert.deepEqual(guard.investigating, { x: 6, y: 3 });
});

test('cutting power shortens vision so a watched tile stops being watched', () => {
  const game = sandboxGame();
  game.state.floor.guards = [
    {
      id: 'guard-0',
      x: 1,
      y: 2,
      facing: { dx: 1, dy: 0 },
      route: [],
      routeIdx: 0,
      state: 'patrol',
      investigating: null,
      patience: 0,
      visionRange: 6,
      coneHalfAngleDeg: 45,
      stunTurns: 0,
    },
  ];
  const target = { x: 6, y: 2 };

  const litUp = tileThreat(game.state.floor, target, { powerOutTurns: 0 });
  assert.deepEqual(litUp.watchedBy, ['guard-0'], 'guard should see down the corridor when lit');

  const dark = tileThreat(game.state.floor, target, { powerOutTurns: 3 });
  assert.deepEqual(dark.watchedBy, [], 'blackout should pull the cone in short of the target');
});

test('agent abilities are refused when bandwidth is short', () => {
  const game = sandboxGame();
  game.state.bandwidth = 0;
  const result = game.ping(3, 2);
  assert.equal(result.ok, false, 'a ping with no bandwidth must be refused');
  assert.match(result.message, /bandwidth/i);
});

// --- failure conditions ---------------------------------------------------

test('the run fails when the alarm is driven to its maximum', () => {
  const game = sandboxGame();
  game.state.alarm = BALANCE.alarm.max - BALANCE.alarm.perGuardSighting;
  game.state.floor.guards = [
    {
      id: 'guard-0',
      x: 3,
      y: 2,
      facing: { dx: -1, dy: 0 },
      route: [],
      routeIdx: 0,
      state: 'patrol',
      investigating: null,
      patience: 0,
      visionRange: 6,
      coneHalfAngleDeg: 45,
      stunTurns: 0,
    },
  ];
  game.state.player = { x: 1, y: 2 };

  game.move(1, 0); // step into the guard's cone
  assert.equal(game.state.phase, 'run_failed');
  assert.equal(game.state.alarm, BALANCE.alarm.max);
});

test('a hunting guard that reaches the operative ends the run', () => {
  const game = sandboxGame();
  game.state.floor.guards = [
    {
      id: 'guard-0',
      x: 3,
      y: 2,
      facing: { dx: -1, dy: 0 },
      route: [],
      routeIdx: 0,
      state: 'hunting',
      investigating: { x: 1, y: 2 },
      patience: 4,
      visionRange: 1,
      coneHalfAngleDeg: 10,
      stunTurns: 0,
    },
  ];
  game.state.player = { x: 1, y: 2 };
  game.state.reflexAvailable = false;

  game.endTurn();
  assert.equal(game.state.phase, 'run_failed');
});

// --- the read tools have to return usable reasoning material --------------

test('plan_route reports per-step risk and names the observer', () => {
  const game = sandboxGame();
  game.state.floor.guards = [
    {
      id: 'guard-0',
      x: 4,
      y: 1,
      facing: { dx: 0, dy: 1 },
      route: [],
      routeIdx: 0,
      state: 'patrol',
      investigating: null,
      patience: 0,
      visionRange: 5,
      coneHalfAngleDeg: 45,
      stunTurns: 0,
    },
  ];
  game.state.player = { x: 1, y: 2 };

  const plan = game.planRoute(7, 2);
  assert.ok(plan, 'a route across an open room must exist');
  assert.equal(plan.apRequired, plan.length * BALANCE.apCost.move);
  const watched = plan.steps.filter((s) => s.watchedBy.includes('guard-0'));
  assert.ok(watched.length > 0, 'the route passes the guard, so some step must be watched');
  assert.ok(plan.totalRisk > 0, 'a watched route must carry non-zero risk');
  assert.ok(plan.mostDangerousStep, 'the most dangerous step must be identified');
});

test('assess_tile terrain lookup matches the underlying grid', () => {
  const game = sandboxGame();
  assert.equal(tileAt(game.state.floor, 0, 0)?.kind, 'wall');
  assert.equal(tileAt(game.state.floor, 4, 2)?.kind, 'floor');
  assert.equal(tileAt(game.state.floor, -1, 2), null);
});
