import assert from 'node:assert/strict';
import { test } from 'vitest';

const store = new Map<string, string>();
(globalThis as Record<string, unknown>).localStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k),
  clear: () => store.clear(),
};

const { Game } = await import('../src/game/game.ts');
const { BALANCE } = await import('../src/game/config.ts');
const { RNG } = await import('../src/game/rng.ts');
const { floorConfig, floorStart, generateFloor } = await import('../src/game/mapgen.ts');
const { canPathThrough, findPath, isWalkable, tileAt } = await import('../src/game/grid.ts');
import type { FloorState, GameState, Vec } from '../src/game/types.ts';

const VALID_PHASES = new Set([
  'mode_select',
  'menu',
  'briefing',
  'playing',
  'floor_clear',
  'choosing_implant',
  'run_failed',
  'run_complete',
]);

/**
 * Everything that must be true of a floor no matter how it was generated.
 * Run across hundreds of seeds so a rare layout cannot slip through.
 */
function assertFloorInvariants(floor: FloorState, label: string): void {
  const start = floorStart(floor);
  assert.ok(isWalkable(floor, start.x, start.y), `${label}: entry tile not walkable`);

  const inBounds = (v: Vec) => v.x >= 0 && v.y >= 0 && v.x < floor.width && v.y < floor.height;

  assert.ok(inBounds(floor.extraction), `${label}: extraction is off-map`);
  assert.ok(
    canPathThrough(floor, floor.extraction.x, floor.extraction.y),
    `${label}: extraction tile is solid`,
  );
  assert.ok(findPath(floor, start, floor.extraction), `${label}: extraction unreachable from entry`);

  const cores = floor.terminals.filter((t) => t.kind === 'data');
  assert.ok(cores.length >= 1, `${label}: no data cores`);

  for (const terminal of floor.terminals) {
    assert.ok(inBounds(terminal), `${label}: terminal ${terminal.id} off-map`);
    assert.ok(
      canPathThrough(floor, terminal.x, terminal.y),
      `${label}: terminal ${terminal.id} inside a wall`,
    );
    assert.ok(
      findPath(floor, start, { x: terminal.x, y: terminal.y }),
      `${label}: terminal ${terminal.id} unreachable`,
    );
  }

  for (const item of floor.loot) {
    assert.ok(inBounds(item), `${label}: loot ${item.id} off-map`);
    assert.ok(canPathThrough(floor, item.x, item.y), `${label}: loot ${item.id} inside a wall`);
  }

  for (const guard of floor.guards) {
    assert.ok(inBounds(guard), `${label}: ${guard.id} off-map`);
    assert.ok(canPathThrough(floor, guard.x, guard.y), `${label}: ${guard.id} spawned in a wall`);
    assert.ok(guard.route.length > 0, `${label}: ${guard.id} has an empty patrol route`);
    for (const waypoint of guard.route) {
      assert.ok(inBounds(waypoint), `${label}: ${guard.id} has an off-map waypoint`);
    }
  }

  for (const camera of floor.cameras) {
    assert.ok(inBounds(camera), `${label}: ${camera.id} off-map`);
  }

  assert.equal(floor.tiles.length, floor.width * floor.height, `${label}: tile array size mismatch`);
  assert.equal(floor.discovered.length, floor.tiles.length, `${label}: fog array size mismatch`);
}

/** Everything that must hold of a live game after any sequence of actions. */
function assertStateInvariants(state: GameState, label: string): void {
  assert.ok(VALID_PHASES.has(state.phase), `${label}: bogus phase "${state.phase}"`);

  assert.ok(Number.isInteger(state.ap), `${label}: ap is not an integer`);
  assert.ok(state.ap >= 0, `${label}: negative ap (${state.ap})`);
  assert.ok(state.ap <= state.maxAp, `${label}: ap ${state.ap} exceeds max ${state.maxAp}`);

  assert.ok(state.bandwidth >= 0, `${label}: negative bandwidth (${state.bandwidth})`);
  assert.ok(
    state.bandwidth <= state.maxBandwidth,
    `${label}: bandwidth ${state.bandwidth} exceeds max ${state.maxBandwidth}`,
  );

  assert.ok(state.alarm >= 0, `${label}: negative alarm`);
  assert.ok(state.alarm <= BALANCE.alarm.max, `${label}: alarm ${state.alarm} above maximum`);

  assert.ok(state.turn >= 1, `${label}: turn counter below 1`);
  assert.ok(state.powerOutTurns >= 0, `${label}: negative blackout timer`);
  assert.ok(state.intelThisRun >= 0, `${label}: negative intel`);

  const floor = state.floor;
  assert.ok(
    state.player.x >= 0 &&
      state.player.y >= 0 &&
      state.player.x < floor.width &&
      state.player.y < floor.height,
    `${label}: operative left the map at ${state.player.x},${state.player.y}`,
  );
  assert.ok(
    canPathThrough(floor, state.player.x, state.player.y),
    `${label}: operative is standing inside solid geometry`,
  );

  for (const guard of floor.guards) {
    assert.ok(
      guard.x >= 0 && guard.y >= 0 && guard.x < floor.width && guard.y < floor.height,
      `${label}: ${guard.id} left the map`,
    );
    assert.ok(
      canPathThrough(floor, guard.x, guard.y),
      `${label}: ${guard.id} walked into solid geometry at ${guard.x},${guard.y}`,
    );
    assert.ok(guard.stunTurns >= 0, `${label}: ${guard.id} has a negative stun timer`);
  }

  for (const tile of floor.tiles) {
    assert.ok(tile.lockedTurns >= 0, `${label}: negative door lock timer`);
  }

  for (const camera of floor.cameras) {
    assert.ok(camera.disabledTurns >= 0, `${label}: ${camera.id} has a negative disable timer`);
  }

  if (state.phase === 'run_failed' || state.phase === 'run_complete') {
    assert.ok(state.endReason.length > 0, `${label}: run ended without a reason`);
  }
}

// -- generation ------------------------------------------------------------

test('300 seeds x every floor satisfy the floor invariants', { timeout: 60_000 }, () => {
  for (let seed = 1; seed <= 300; seed++) {
    for (let index = 0; index < BALANCE.run.floors; index++) {
      assertFloorInvariants(
        generateFloor(seed, floorConfig(index)),
        `seed ${seed} floor ${index}`,
      );
    }
  }
});

test('generation is deterministic — the same seed rebuilds an identical floor', () => {
  for (let seed = 1; seed <= 60; seed++) {
    const a = generateFloor(seed, floorConfig(2));
    const b = generateFloor(seed, floorConfig(2));
    assert.equal(
      JSON.stringify(a.tiles.map((t) => `${t.kind}${t.open ? '+' : ''}`)),
      JSON.stringify(b.tiles.map((t) => `${t.kind}${t.open ? '+' : ''}`)),
      `seed ${seed}: terrain differs between builds`,
    );
    assert.deepEqual(
      a.guards.map((g) => [g.id, g.x, g.y]),
      b.guards.map((g) => [g.id, g.x, g.y]),
      `seed ${seed}: guard placement differs between builds`,
    );
    assert.deepEqual(a.extraction, b.extraction, `seed ${seed}: extraction differs`);
  }
});

test('different seeds actually produce different facilities', () => {
  const fingerprints = new Set<string>();
  for (let seed = 1; seed <= 120; seed++) {
    const floor = generateFloor(seed, floorConfig(0));
    fingerprints.add(floor.tiles.map((t) => t.kind[0]).join(''));
  }
  assert.ok(
    fingerprints.size >= 115,
    `expected near-unique layouts across 120 seeds, got ${fingerprints.size}`,
  );
});

test('difficulty rises monotonically across the floor stack', () => {
  for (let index = 1; index < BALANCE.run.floors; index++) {
    const previous = floorConfig(index - 1);
    const current = floorConfig(index);
    assert.ok(current.guards > previous.guards, `floor ${index} does not add guards`);
    assert.ok(current.cameras >= previous.cameras, `floor ${index} loses cameras`);
    assert.ok(current.width >= previous.width, `floor ${index} shrinks`);
  }
});

// -- fuzzing ---------------------------------------------------------------

interface FuzzAction {
  name: string;
  run: (game: InstanceType<typeof Game>, rng: InstanceType<typeof RNG>) => void;
}

const FUZZ_ACTIONS: FuzzAction[] = [
  {
    name: 'move',
    run: (game, rng) => {
      const dirs = [
        [0, -1],
        [1, 0],
        [0, 1],
        [-1, 0],
      ];
      const [dx, dy] = dirs[rng.int(0, 3)];
      game.move(dx, dy);
    },
  },
  {
    name: 'moveTo',
    run: (game, rng) => {
      const floor = game.state.floor;
      game.moveTo(rng.int(0, floor.width - 1), rng.int(0, floor.height - 1), rng.next() < 0.35);
    },
  },
  { name: 'hack', run: (game) => void game.hack() },
  { name: 'grab', run: (game) => void game.grab() },
  {
    name: 'toggleDoor',
    run: (game, rng) => {
      const floor = game.state.floor;
      game.toggleDoor(rng.int(0, floor.width - 1), rng.int(0, floor.height - 1));
    },
  },
  { name: 'extract', run: (game) => void game.extract() },
  { name: 'endTurn', run: (game) => void game.endTurn() },
  {
    name: 'ping',
    run: (game, rng) => {
      const floor = game.state.floor;
      game.ping(rng.int(-4, floor.width + 4), rng.int(-4, floor.height + 4));
    },
  },
  {
    name: 'agentDoor',
    run: (game, rng) => {
      const floor = game.state.floor;
      game.agentToggleDoor(
        rng.int(0, floor.width - 1),
        rng.int(0, floor.height - 1),
        rng.next() < 0.5,
      );
    },
  },
  {
    name: 'loopCamera',
    run: (game, rng) => {
      const cameras = game.state.floor.cameras;
      const id = cameras.length ? cameras[rng.int(0, cameras.length - 1)].id : 'cam-nope';
      game.loopCamera(id);
    },
  },
  {
    name: 'distraction',
    run: (game, rng) => {
      const floor = game.state.floor;
      game.distraction(rng.int(0, floor.width - 1), rng.int(0, floor.height - 1));
    },
  },
  { name: 'cutPower', run: (game) => void game.cutPower() },
  {
    name: 'reroute',
    run: (game, rng) => {
      const guards = game.state.floor.guards;
      const id = guards.length ? guards[rng.int(0, guards.length - 1)].id : 'guard-nope';
      const floor = game.state.floor;
      game.reroutePatrol(id, rng.int(0, floor.width - 1), rng.int(0, floor.height - 1));
    },
  },
  {
    name: 'planRoute',
    run: (game, rng) => {
      const floor = game.state.floor;
      game.planRoute(rng.int(-3, floor.width + 3), rng.int(-3, floor.height + 3));
    },
  },
  {
    name: 'threatAt',
    run: (game, rng) => {
      const floor = game.state.floor;
      game.threatAt(rng.int(0, floor.width - 1), rng.int(0, floor.height - 1));
    },
  },
];

test('200 fuzzed runs never break a state invariant or throw', { timeout: 60_000 }, () => {
  let actionsRun = 0;
  let runsFinished = 0;

  for (let seed = 1; seed <= 200; seed++) {
    const rng = new RNG(seed * 104729);
    const game = new Game();
    game.newRun(seed);
    game.setMode(rng.next() < 0.5 ? 'coop' : 'agent');
    game.beginInfiltration();

    for (let step = 0; step < 120; step++) {
      const state = game.state;

      if (state.phase === 'choosing_implant') {
        const choices = state.implantChoices;
        assert.ok(choices.length > 0, `seed ${seed}: implant choice with no options`);
        game.chooseImplant(choices[rng.int(0, choices.length - 1)].id);
        assertStateInvariants(game.state, `seed ${seed} step ${step} (implant)`);
        continue;
      }
      if (state.phase !== 'playing') {
        runsFinished++;
        break;
      }

      const action = FUZZ_ACTIONS[rng.int(0, FUZZ_ACTIONS.length - 1)];
      action.run(game, rng);
      actionsRun++;
      assertStateInvariants(game.state, `seed ${seed} step ${step} after ${action.name}`);
    }
  }

  assert.ok(actionsRun > 10_000, `expected a deep fuzz, only ran ${actionsRun} actions`);
  assert.ok(runsFinished > 0, 'no fuzzed run ever reached an end state — check the fuzz loop');
});

test('actions are refused rather than throwing once a run is over', () => {
  const game = new Game();
  game.newRun(7);
  game.setMode('agent');
  game.beginInfiltration();
  game.state.phase = 'run_failed';
  game.state.endReason = 'forced for the test';

  for (const action of FUZZ_ACTIONS) {
    const rng = new RNG(1);
    action.run(game, rng);
    assert.equal(game.state.phase, 'run_failed', `${action.name} resurrected a finished run`);
  }
  assertStateInvariants(game.state, 'post-run');
});

test('a fuzzed run never spends resources it does not have', { timeout: 60_000 }, () => {
  for (let seed = 1; seed <= 120; seed++) {
    const rng = new RNG(seed * 7919);
    const game = new Game();
    game.newRun(seed);
    game.setMode('agent');
    game.beginInfiltration();

    for (let step = 0; step < 90 && game.state.phase === 'playing'; step++) {
      const apBefore = game.state.ap;
      const bandwidthBefore = game.state.bandwidth;
      const turnBefore = game.state.turn;

      const action = FUZZ_ACTIONS[rng.int(0, FUZZ_ACTIONS.length - 1)];
      action.run(game, rng);

      // resources may only rise when the turn rolls over
      if (game.state.turn === turnBefore && game.state.phase === 'playing') {
        assert.ok(
          game.state.ap <= apBefore,
          `seed ${seed}: ${action.name} gained AP mid-turn (${apBefore} -> ${game.state.ap})`,
        );
        assert.ok(
          game.state.bandwidth <= bandwidthBefore,
          `seed ${seed}: ${action.name} gained bandwidth mid-turn`,
        );
      }
    }
  }
});

test('sealed doors are never pathed through, across many fuzzed floors', () => {
  for (let seed = 1; seed <= 80; seed++) {
    const floor = generateFloor(seed, floorConfig(2));
    const doors = floor.tiles
      .map((tile, i) => ({ tile, i }))
      .filter((entry) => entry.tile.kind === 'door');
    if (!doors.length) continue;

    for (const { tile } of doors) {
      tile.open = false;
      tile.lockedTurns = 3;
    }

    for (let i = 0; i < floor.tiles.length; i++) {
      const tile = floor.tiles[i];
      if (tile.kind !== 'door') continue;
      assert.equal(
        canPathThrough(floor, i % floor.width, Math.floor(i / floor.width)),
        false,
        `seed ${seed}: a sealed door is still pathable`,
      );
    }
  }
});

test('every reported watcher genuinely has line of sight and range', async () => {
  const { hasLineOfSight } = await import('../src/game/grid.ts');
  const { tileThreat } = await import('../src/game/vision.ts');

  let watchedSamples = 0;
  for (let seed = 1; seed <= 40; seed++) {
    const floor = generateFloor(seed, floorConfig(3));
    for (let y = 0; y < floor.height; y++) {
      for (let x = 0; x < floor.width; x++) {
        const threat = tileThreat(floor, { x, y }, { powerOutTurns: 0 });
        if (!threat.watchedBy.length) continue;
        watchedSamples++;
        for (const id of threat.watchedBy) {
          const observer =
            floor.guards.find((g) => g.id === id) ?? floor.cameras.find((c) => c.id === id);
          assert.ok(observer, `seed ${seed}: threat named unknown observer "${id}"`);
          assert.ok(
            hasLineOfSight(floor, { x: observer.x, y: observer.y }, { x, y }),
            `seed ${seed}: ${id} watches ${x},${y} with no line of sight`,
          );
          assert.ok(
            Math.hypot(observer.x - x, observer.y - y) <= observer.visionRange,
            `seed ${seed}: ${id} watches ${x},${y} beyond its vision range`,
          );
        }
      }
    }
  }
  assert.ok(watchedSamples > 500, `expected a broad sample, only saw ${watchedSamples} watched tiles`);
});

test('cutting power strictly shrinks what every observer can see', async () => {
  const { tileThreat } = await import('../src/game/vision.ts');
  let comparisons = 0;

  for (let seed = 1; seed <= 40; seed++) {
    const floor = generateFloor(seed, floorConfig(3));
    for (let y = 0; y < floor.height; y++) {
      for (let x = 0; x < floor.width; x++) {
        const lit = tileThreat(floor, { x, y }, { powerOutTurns: 0 }).watchedBy;
        const dark = tileThreat(floor, { x, y }, { powerOutTurns: 3 }).watchedBy;
        comparisons++;
        for (const id of dark) {
          assert.ok(
            lit.includes(id),
            `seed ${seed}: ${id} sees ${x},${y} in a blackout but not with the lights on`,
          );
        }
      }
    }
  }
  assert.ok(comparisons > 20_000, `expected a wide sweep, only compared ${comparisons} tiles`);
});
