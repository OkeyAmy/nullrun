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


/** Archetype fields every hand-built guard fixture needs. */
const GUARD_DEFAULTS = {
  patrolSpeed: 1,
  huntSpeed: 2,
  stationary: false,
  deafToNoise: false,
  seesInBlackout: false,
} as const;

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
      archetype: 'patrol' as const,
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
      ...GUARD_DEFAULTS,
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
      archetype: 'patrol' as const,
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
      ...GUARD_DEFAULTS,
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
      archetype: 'patrol' as const,
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
      ...GUARD_DEFAULTS,
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
      archetype: 'patrol' as const,
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
      ...GUARD_DEFAULTS,
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
      archetype: 'patrol' as const,
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
      ...GUARD_DEFAULTS,
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
      archetype: 'patrol' as const,
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
      ...GUARD_DEFAULTS,
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

// --- meta progression: banked intel has to buy something ------------------

test('banked intel buys a permanent implant that starts installed next run', () => {
  localStorage.clear();
  const game = new Game();
  const cost = game.upgradeCost();

  // bank enough to shop with
  game.state.bankedIntel = cost + 10;
  game.state.phase = 'run_failed';
  game.state.endReason = 'test';

  const target = game.availableUpgrades()[0];
  assert.ok(target, 'the blackmarket must have stock on a fresh profile');

  const bought = game.purchaseUpgrade(target.id);
  assert.equal(bought.ok, true, bought.message);
  assert.equal(game.state.bankedIntel, 10, 'the price must be deducted');
  assert.ok(game.state.unlockedIds.includes(target.id));

  // and it must actually be installed on the next run
  game.newRun(99);
  assert.ok(
    game.state.implants.some((i) => i.id === target.id),
    'a bought implant must start installed on the next run',
  );
  localStorage.clear();
});

test('an unaffordable or duplicate purchase is refused', () => {
  localStorage.clear();
  const game = new Game();
  game.state.phase = 'run_failed';
  game.state.bankedIntel = 0;

  const target = game.availableUpgrades()[0];
  const broke = game.purchaseUpgrade(target.id);
  assert.equal(broke.ok, false, 'buying with no intel must fail');
  assert.match(broke.message, /costs|banked/i);

  game.state.bankedIntel = 10_000;
  assert.equal(game.purchaseUpgrade(target.id).ok, true);
  const again = game.purchaseUpgrade(target.id);
  assert.equal(again.ok, false, 'buying the same implant twice must fail');
  localStorage.clear();
});

test('upgrade prices rise with each implant owned', () => {
  localStorage.clear();
  const game = new Game();
  game.state.phase = 'run_failed';
  game.state.bankedIntel = 100_000;

  const first = game.upgradeCost();
  game.purchaseUpgrade(game.availableUpgrades()[0].id);
  const second = game.upgradeCost();
  assert.ok(second > first, `price must escalate: ${first} -> ${second}`);
  localStorage.clear();
});

test('the blackmarket is shut while a run is in progress', () => {
  localStorage.clear();
  const game = new Game();
  game.setMode('agent');
  game.state.bankedIntel = 100_000;
  assert.equal(game.state.phase, 'playing');

  const result = game.purchaseUpgrade(game.availableUpgrades()[0].id);
  assert.equal(result.ok, false, 'shopping mid-run must be refused');
  localStorage.clear();
});

// --- guard archetypes -----------------------------------------------------

test('a thermal drone keeps its full cone through a blackout', () => {
  const game = sandboxGame();
  const base = {
    x: 1, y: 2, facing: { dx: 1, dy: 0 }, route: [], routeIdx: 0,
    state: 'patrol' as const, investigating: null, patience: 0,
    visionRange: 6, coneHalfAngleDeg: 45, stunTurns: 0,
    patrolSpeed: 1, huntSpeed: 2, stationary: false, deafToNoise: false,
  };
  game.state.floor.guards = [
    { id: 'patrol-0', archetype: 'patrol' as const, ...base, seesInBlackout: false },
    { id: 'drone-0', archetype: 'drone' as const, ...base, seesInBlackout: true },
  ];

  const lit = tileThreat(game.state.floor, { x: 6, y: 2 }, { powerOutTurns: 0 }).watchedBy;
  assert.deepEqual(lit.sort(), ['drone-0', 'patrol-0'], 'both should see down a lit corridor');

  const dark = tileThreat(game.state.floor, { x: 6, y: 2 }, { powerOutTurns: 3 }).watchedBy;
  assert.deepEqual(dark, ['drone-0'], 'only the thermal unit should see through a blackout');
});

test('a sentry cannot be lured by a distraction or rerouted', () => {
  const game = sandboxGame();
  game.state.floor.guards = [
    {
      id: 'sentry-0', archetype: 'sentry' as const, x: 3, y: 2,
      facing: { dx: 1, dy: 0 }, route: [{ x: 3, y: 2 }], routeIdx: 0,
      state: 'patrol', investigating: null, patience: 0,
      visionRange: 9, coneHalfAngleDeg: 70, stunTurns: 0,
      patrolSpeed: 0, huntSpeed: 0, stationary: true,
      deafToNoise: true, seesInBlackout: false,
    },
  ];

  game.distraction(6, 3);
  assert.equal(game.state.floor.guards[0].state, 'patrol', 'a deaf sentry must ignore noise');

  const rerouted = game.reroutePatrol('sentry-0', 6, 3);
  assert.equal(rerouted.ok, false, 'a bolted-down sentry cannot be rerouted');
  assert.match(rerouted.message, /fixed|cannot be moved/i);
});

test('a stationary sentry never leaves its tile', () => {
  const game = sandboxGame();
  game.state.floor.guards = [
    {
      id: 'sentry-0', archetype: 'sentry' as const, x: 3, y: 2,
      facing: { dx: 1, dy: 0 }, route: [{ x: 7, y: 2 }], routeIdx: 0,
      state: 'patrol', investigating: null, patience: 0,
      visionRange: 9, coneHalfAngleDeg: 70, stunTurns: 0,
      patrolSpeed: 0, huntSpeed: 0, stationary: true,
      deafToNoise: true, seesInBlackout: false,
    },
  ];
  game.state.player = { x: 1, y: 1 };

  for (let i = 0; i < 6; i++) game.endTurn();
  const sentry = game.state.floor.guards[0];
  assert.deepEqual({ x: sentry.x, y: sentry.y }, { x: 3, y: 2 }, 'a sentry must stay put');
});

test('a bloodhound hears noise from further away than a patrol', () => {
  const make = (id: string, archetype: 'patrol' | 'bloodhound') => ({
    id, archetype, x: 2, y: 2, facing: { dx: 1, dy: 0 }, route: [{ x: 2, y: 2 }],
    routeIdx: 0, state: 'patrol' as const, investigating: null, patience: 0,
    visionRange: 1, coneHalfAngleDeg: 10, stunTurns: 0,
    patrolSpeed: 1, huntSpeed: 2, stationary: false,
    deafToNoise: false, seesInBlackout: false,
  });

  // a noise just outside normal hearing: only the bloodhound should react
  // the sandbox player starts next to (2,2), and a guard always notices what is
  // standing beside it — park the operative out of reach so only hearing is tested
  const patrolGame = sandboxGame();
  patrolGame.state.player = { x: 7, y: 1 };
  patrolGame.state.floor.guards = [make('patrol-0', 'patrol')];
  patrolGame.emitNoise(7, 2, 4);
  patrolGame.endTurn();
  assert.equal(patrolGame.state.floor.guards[0].state, 'patrol', 'patrol should not hear it');

  const houndGame = sandboxGame();
  houndGame.state.player = { x: 7, y: 1 };
  houndGame.state.floor.guards = [make('bloodhound-0', 'bloodhound')];
  houndGame.emitNoise(7, 2, 4);
  houndGame.endTurn();
  assert.notEqual(
    houndGame.state.floor.guards[0].state,
    'patrol',
    'a bloodhound must hear noise a patrol misses',
  );
});

// --- the escalation clock ------------------------------------------------
// The alarm decays back to nothing, so without a ratchet the best way to play
// was to stand still and wait it out. These pin the ratchet down.

test('escalation rises on its own even when the operative does nothing', () => {
  const game = sandboxGame();
  assert.equal(game.state.escalation, 0, 'a fresh sandbox floor starts quiet');

  // turn 1 -> 8; the tick lands the turn the counter reaches turnsPerTick
  for (let i = 0; i < BALANCE.alert.turnsPerTick - 1; i++) game.endTurn();

  assert.equal(game.state.turn, BALANCE.alert.turnsPerTick);
  assert.equal(
    game.state.escalation,
    BALANCE.alert.perTick,
    'one full sweep cycle of loitering must cost exactly one tick',
  );
});

test('escalation never falls, however long you hide', () => {
  const game = sandboxGame();
  let previous = game.state.escalation;

  for (let i = 0; i < 30; i++) {
    game.endTurn();
    assert.ok(
      game.state.escalation >= previous,
      `escalation dropped from ${previous} to ${game.state.escalation} on turn ${game.state.turn}`,
    );
    previous = game.state.escalation;
  }

  assert.ok(previous > 0, 'thirty turns of waiting must have cost something');
});

test('being seen escalates the facility on top of the alarm', () => {
  const game = sandboxGame();
  game.state.floor.guards = [
    {
      id: 'patrol-0', archetype: 'patrol' as const, x: 2, y: 2,
      facing: { dx: -1, dy: 0 }, route: [{ x: 2, y: 2 }], routeIdx: 0,
      state: 'patrol' as const, investigating: null, patience: 0,
      visionRange: 7, coneHalfAngleDeg: 45, stunTurns: 0,
      ...GUARD_DEFAULTS,
    },
  ];
  game.state.player = { x: 1, y: 2 };

  const before = game.state.escalation;
  game.endTurn();

  assert.ok(
    game.state.escalation >= before + BALANCE.alert.perSighting,
    `a sighting must add at least ${BALANCE.alert.perSighting} escalation`,
  );
});

test('the first stage widens every guard cone by one tile', () => {
  const game = sandboxGame();
  game.state.floor.guards = [
    {
      id: 'patrol-0', archetype: 'patrol' as const, x: 6, y: 2,
      facing: { dx: 1, dy: 0 }, route: [{ x: 6, y: 2 }], routeIdx: 0,
      state: 'patrol' as const, investigating: null, patience: 0,
      visionRange: 7, coneHalfAngleDeg: 45, stunTurns: 0,
      ...GUARD_DEFAULTS,
    },
  ];

  game.raiseAlert(BALANCE.alert.stageAt[0], 'test');

  assert.equal(game.state.alertStage, 1);
  assert.equal(game.state.floor.guards[0].visionRange, 8, 'stage 1 must widen the sweep');
});

test('the second stage sends a hunter in after you', () => {
  const game = sandboxGame();
  const before = game.state.floor.guards.length;

  game.raiseAlert(BALANCE.alert.stageAt[1], 'test');

  assert.equal(game.state.alertStage, 2);
  assert.equal(game.state.floor.guards.length, before + 1, 'a reinforcement must arrive');
  const sent = game.state.floor.guards.at(-1);
  assert.equal(sent.archetype, 'hunter');
  assert.notEqual(sent.state, 'patrol', 'a reinforcement arrives already looking for you');
});

test('lockdown stops the alarm cooling down, so hiding is no longer an escape', () => {
  const game = sandboxGame();
  game.raiseAlert(BALANCE.alert.stageAt[2], 'test');
  assert.equal(game.state.alertStage, 3, 'the final stage must be reached');

  game.state.alarm = 50;
  for (let i = 0; i < 6; i++) game.endTurn();

  assert.equal(game.state.alarm, 50, 'under lockdown the alarm must not decay at all');
});

test('a deeper floor starts hotter than the one above it', () => {
  const game = sandboxGame();
  const shallow = game.state.escalation;

  // clear the floor and drop through to the next one; extraction hands you an
  // implant choice first, and picking it is what actually starts the next floor
  game.state.floor.loot = [];
  game.state.floor.terminals = [];
  game.state.player = { ...game.state.floor.extraction };
  assert.equal(game.extract().ok, true, 'a cleared floor must let you extract');
  game.chooseImplant(game.state.implantChoices[0].id);

  assert.equal(game.state.floor.index, 1, 'the run must have advanced a floor');
  assert.ok(
    game.state.escalation > shallow,
    `floor 2 must open hotter than floor 1 opened (${game.state.escalation} vs ${shallow})`,
  );
});
