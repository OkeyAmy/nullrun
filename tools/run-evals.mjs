/**
 * Executes every case in evals.json against the live page through
 * `document.modelContext`, the same way the WebMCP Evals CLI's `smoke` mode
 * does — no API key, no LLM, fully deterministic.
 *
 * It answers three questions for all 313 cases:
 *   1. does the tool the phrasing should reach actually exist?
 *   2. does it accept the argument shape the eval expects?
 *   3. does it respond without throwing, and with a well-formed result?
 *
 * A tool that refuses on game grounds ("no terminal within reach") passes —
 * that is a correct response, not a broken tool. Only missing tools, schema
 * rejections and thrown exceptions fail.
 *
 * Usage: node tools/run-evals.mjs [url] [--evals evals.json] [--verbose]
 */
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const url = argv.find((a) => a.startsWith('http')) ?? 'http://localhost:5183/';
const evalsPath = (() => {
  const i = argv.indexOf('--evals');
  return i >= 0 ? argv[i + 1] : 'evals.json';
})();
const verbose = argv.includes('--verbose');

const cases = JSON.parse(readFileSync(evalsPath, 'utf8'));

/** Turn eval constraint operators into a concrete value to send. */
function concrete(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    if ('$contains' in value) return value.$contains;
    if ('$pattern' in value) return String(value.$pattern).replace(/[^\w-]/g, '');
    if ('$gte' in value) return value.$gte;
    if ('$lte' in value) return value.$lte;
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = concrete(v);
    return out;
  }
  return value;
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });

const consoleErrors = [];
page.on('console', (m) => m.type() === 'error' && consoleErrors.push(m.text()));
page.on('pageerror', (e) => consoleErrors.push(String(e)));

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.nullrun), null, { timeout: 15_000 });

const registered = await page.evaluate(async () =>
  (await document.modelContext.getTools()).map((t) => t.name),
);

async function callTool(name, args) {
  return page.evaluate(
    async ([toolName, payload]) => {
      const tools = await document.modelContext.getTools();
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) return { missing: true };
      try {
        const raw = await document.modelContext.executeTool(tool, JSON.stringify(payload));
        let result = raw;
        if (typeof raw === 'string') {
          try {
            result = JSON.parse(raw);
          } catch {
            result = { content: [{ type: 'text', text: raw }] };
          }
        }
        const text = result?.content?.[0]?.text;
        return {
          isError: Boolean(result?.isError),
          wellFormed: typeof text === 'string' && text.length > 0,
          text: (text ?? '').slice(0, 120),
        };
      } catch (error) {
        return { threw: String(error) };
      }
    },
    [name, args],
  );
}

const failures = [];
const perTool = new Map();
let refusals = 0;

for (const [i, testCase] of cases.entries()) {
  const expected = testCase.expectedCall[0];
  const name = expected.functionName;
  const args = concrete(expected.arguments ?? {});

  // keep the run alive so tools are exercised in a real playing state
  if (i % 25 === 0) {
    await page.evaluate(() => {
      const g = window.nullrun.game;
      g.newRun(20260903);
      g.setMode('agent');
      g.beginInfiltration();
    });
  }

  const stats = perTool.get(name) ?? { ok: 0, refused: 0, failed: 0 };
  perTool.set(name, stats);

  if (!registered.includes(name)) {
    // phase-scoped tools legitimately come and go; re-check live before failing
    const live = await page.evaluate(async () =>
      (await document.modelContext.getTools()).map((t) => t.name),
    );
    if (!live.includes(name)) {
      stats.failed++;
      failures.push({ case: testCase.name, reason: `tool "${name}" is not registered` });
      continue;
    }
  }

  const result = await callTool(name, args);

  if (result.missing) {
    stats.failed++;
    failures.push({ case: testCase.name, reason: `tool "${name}" disappeared mid-run` });
  } else if (result.threw) {
    stats.failed++;
    failures.push({ case: testCase.name, reason: `threw: ${result.threw}` });
  } else if (!result.wellFormed) {
    stats.failed++;
    failures.push({ case: testCase.name, reason: 'returned an empty or malformed result' });
  } else if (result.isError) {
    stats.refused++;
    refusals++;
    if (verbose) console.log(`  refused  ${name}: ${result.text}`);
  } else {
    stats.ok++;
  }
}


// --- success-path pass ----------------------------------------------------
// The matrix above proves every tool responds. It does not prove every tool
// can succeed, because randomly chosen coordinates rarely land on a real door
// and floor 1 carries no cameras. This pass builds valid arguments out of live
// game state so each tool has to actually do its job at least once.

const successPass = [];
async function mustSucceed(label, fn) {
  const result = await fn();
  const ok = result && !result.missing && !result.threw && result.wellFormed && !result.isError;
  successPass.push({ label, ok, detail: result?.text ?? result?.threw ?? 'no result' });
}

async function freshFloor(floorIndex = 2) {
  await page.evaluate((idx) => {
    const g = window.nullrun.game;
    g.newRun(20260903);
    g.setMode('agent');
    g.beginInfiltration();
    // descend to a floor that carries cameras, and reveal it for targeting
    for (let i = 0; i < idx; i++) {
      g.state.floor.terminals.forEach((t) => (t.hacked = true));
      g.state.player = { ...g.state.floor.extraction };
      g.extract();
      if (g.state.phase === 'choosing_implant') {
        g.chooseImplant(g.state.implantChoices[0].id);
      }
    }
    g.state.floor.discovered.fill(true);
  }, floorIndex);
}

await freshFloor(2);
const live = await page.evaluate(() => {
  const s = window.nullrun.game.state;
  const floor = s.floor;
  const doorIndex = floor.tiles.findIndex((t) => t.kind === 'door');
  const walkable = [];
  for (let y = 0; y < floor.height; y++) {
    for (let x = 0; x < floor.width; x++) {
      const t = floor.tiles[y * floor.width + x];
      if (t.kind === 'floor') walkable.push({ x, y });
    }
  }
  return {
    door:
      doorIndex >= 0
        ? { x: doorIndex % floor.width, y: Math.floor(doorIndex / floor.width) }
        : null,
    camera: floor.cameras[0]?.id ?? null,
    guard: floor.guards[0]?.id ?? null,
    core: floor.terminals.find((t) => t.kind === 'data') ?? null,
    loot: floor.loot.find((l) => !l.taken) ?? null,
    extraction: floor.extraction,
    walkable: walkable.slice(0, 5),
  };
});

await mustSucceed('get_situation returns a snapshot', () => callTool('get_situation', {}));
await mustSucceed('list_abilities returns the economy', () => callTool('list_abilities', {}));
await mustSucceed('get_run_status reports progress', () => callTool('get_run_status', {}));
await mustSucceed('set_play_mode hands control over mid-run', () =>
  callTool('set_play_mode', { mode: 'coop' }));
await mustSucceed('set_play_mode hands it back', () => callTool('set_play_mode', { mode: 'agent' }));

if (live.walkable.length) {
  await mustSucceed('assess_tile reads a real floor tile', () =>
    callTool('assess_tile', live.walkable[0]));
  await mustSucceed('plan_route routes to a real tile', () =>
    callTool('plan_route', live.walkable[live.walkable.length - 1]));
}
await mustSucceed('ping_scan sweeps a real area', () =>
  callTool('ping_scan', { x: live.extraction.x, y: live.extraction.y }));
await mustSucceed('cut_power drops the grid', () => callTool('cut_power', {}));

if (live.camera) {
  await freshFloor(2);
  await mustSucceed(`loop_camera blinds ${live.camera}`, () =>
    callTool('loop_camera', { camera_id: live.camera }));
}
if (live.door) {
  await freshFloor(2);
  await mustSucceed('cycle_door seals a real door', () =>
    callTool('cycle_door', { ...live.door, seal: true }));
  await mustSucceed('cycle_door opens a real door', () =>
    callTool('cycle_door', { ...live.door, seal: false }));
}
if (live.guard) {
  await freshFloor(2);
  await mustSucceed(`reroute_patrol redirects ${live.guard}`, () =>
    callTool('reroute_patrol', { guard_id: live.guard, x: live.extraction.x, y: live.extraction.y }));
  await mustSucceed('trigger_distraction fires at a real spot', () =>
    callTool('trigger_distraction', { x: live.extraction.x, y: live.extraction.y }));
}

await freshFloor(2);
// pick a walkable tile the operative is not already standing on
const walkTarget = await page.evaluate((candidates) => {
  const p = window.nullrun.game.state.player;
  return candidates.find((c) => c.x !== p.x || c.y !== p.y) ?? null;
}, live.walkable);
await mustSucceed('move_operative walks somewhere real', () =>
  callTool('move_operative', walkTarget ?? live.extraction));
await mustSucceed('end_turn advances the clock', () => callTool('end_turn', {}));

// drive the operative onto a core and an intel cache so those paths run too
if (live.core) {
  await page.evaluate((core) => {
    const g = window.nullrun.game;
    g.state.player = { x: core.x + 1, y: core.y };
    g.state.ap = g.state.maxAp;
  }, live.core);
  await mustSucceed('hack_terminal siphons an adjacent core', () =>
    callTool('hack_terminal', {}));
}
if (live.loot) {
  await page.evaluate((loot) => {
    const g = window.nullrun.game;
    g.state.player = { x: loot.x, y: loot.y };
    g.state.ap = g.state.maxAp;
  }, live.loot);
  await mustSucceed('grab_intel lifts a real cache', () => callTool('grab_intel', {}));
}
await page.evaluate(() => {
  const g = window.nullrun.game;
  g.state.floor.terminals.forEach((t) => (t.hacked = true));
  g.state.player = { ...g.state.floor.extraction };
  g.state.ap = g.state.maxAp;
});
await mustSucceed('extract clears the floor', () => callTool('extract', {}));

console.log(`\nWebMCP eval smoke — ${cases.length} cases against ${url}\n`);
const rows = [...perTool.entries()].sort((a, b) => b[1].ok + b[1].refused - (a[1].ok + a[1].refused));
for (const [tool, s] of rows) {
  const flag = s.failed ? 'FAIL' : '  ok';
  console.log(
    `${flag}  ${tool.padEnd(22)} executed ${String(s.ok + s.refused).padStart(3)}` +
      `   accepted ${String(s.ok).padStart(3)}   refused-on-game-rules ${String(s.refused).padStart(3)}` +
      (s.failed ? `   BROKEN ${s.failed}` : ''),
  );
}

console.log(
  `\ntools covered      : ${perTool.size}` +
    `\ncases executed     : ${cases.length - failures.length}/${cases.length}` +
    `\nrefused on rules   : ${refusals} (correct behaviour, not a failure)` +
    `\nbroken             : ${failures.length}` +
    `\nconsole errors     : ${consoleErrors.length}`,
);

const brokenSuccess = successPass.filter((r) => !r.ok);
console.log(`\nsuccess-path pass  : ${successPass.length - brokenSuccess.length}/${successPass.length} tools proved a working success path`);
for (const r of brokenSuccess) console.log(`  NO-SUCCESS ${r.label}\n             ${r.detail}`);

for (const f of failures.slice(0, 20)) console.log(`  FAIL ${f.case}\n       ${f.reason}`);
for (const e of consoleErrors.slice(0, 5)) console.log(`  console: ${e}`);

await browser.close();
if (failures.length || consoleErrors.length || brokenSuccess.length) {
  process.exitCode = 1;
  console.log('\nEVALS FAILED');
} else {
  console.log('\nEVALS PASSED');
}
