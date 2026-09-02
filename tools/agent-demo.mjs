/**
 * A handler that plays NULLRUN using nothing but the WebMCP tool surface.
 *
 * It never touches the DOM, never reads game internals, and never calls a
 * method on the engine. Every decision is made from what `get_situation` and
 * `plan_route` return, and every action goes through
 * `document.modelContext.executeTool`. If this can finish a floor, the tool
 * surface is complete.
 *
 * Usage: node tools/agent-demo.mjs [url] [--seed=N] [--turns=N] [--headed] [--shots]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const args = process.argv.slice(2);
const url = args.find((a) => a.startsWith('http')) ?? 'http://localhost:5183/';
const seed = Number(args.find((a) => a.startsWith('--seed='))?.split('=')[1] ?? 20260903);
const maxTurns = Number(args.find((a) => a.startsWith('--turns='))?.split('=')[1] ?? 40);
const headed = args.includes('--headed');
const shots = args.includes('--shots');

if (shots) mkdirSync('.demo', { recursive: true });

const browser = await chromium.launch({ headless: !headed, slowMo: headed ? 220 : 0 });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.nullrun), null, { timeout: 10_000 });
await page.evaluate((s) => window.nullrun.game.newRun(s), seed);
await page.waitForTimeout(200);

/** The only channel this script uses to touch the game. */
async function call(name, toolArgs = {}) {
  return page.evaluate(
    async ([toolName, payload]) => {
      const tools = await document.modelContext.getTools();
      const tool = tools.find((t) => t.name === toolName);
      if (!tool) return { missing: true, text: `tool ${toolName} not registered` };
      const raw = await document.modelContext.executeTool(tool, JSON.stringify(payload));
      let result = raw;
      if (typeof raw === 'string') {
        try {
          result = JSON.parse(raw);
        } catch {
          result = { content: [{ type: 'text', text: raw }] };
        }
      }
      return { isError: Boolean(result?.isError), text: result?.content?.[0]?.text ?? '' };
    },
    [name, toolArgs],
  );
}

function data(result) {
  const start = result.text.indexOf('{');
  if (start < 0) return null;
  try {
    return JSON.parse(result.text.slice(start));
  } catch {
    return null;
  }
}

let calls = 0;
async function act(name, toolArgs, note) {
  calls++;
  const result = await call(name, toolArgs);
  const head = result.text.split('\n')[0].slice(0, 96);
  console.log(`  ${result.isError ? '✗' : '→'} ${name}${note ? ` (${note})` : ''}: ${head}`);
  return result;
}

const dist = (a, b) => Math.abs(a.x - b.x) + Math.abs(a.y - b.y);

console.log(`NULLRUN handler — seed ${seed}, driving via document.modelContext\n`);

await act('set_play_mode', { mode: 'agent' }, 'the handler takes both roles');
await act('begin_infiltration', {}, 'start the floor');

let turn = 0;
let lastPingRing = 0;
let stalled = 0;

while (turn < maxTurns) {
  const situation = data(await call('get_situation'));
  if (!situation) break;

  if (situation.phase === 'choosing_implant') {
    const pick = situation.implantChoices?.[0];
    console.log(`\n[floor cleared] installing ${pick?.name ?? 'implant'}`);
    await act('choose_implant', { implant_id: pick.id }, 'descend');
    continue;
  }
  if (situation.phase !== 'playing') {
    console.log(`\nrun ended: ${situation.phase}`);
    break;
  }

  turn++;
  const me = situation.operative.position;
  const cores = situation.terminals.filter((t) => t.kind === 'data' && !t.hacked);
  console.log(
    `\nT${situation.turn} floor ${situation.floor} · ap ${situation.operative.actionPoints} · bw ${situation.agent.bandwidth} · alarm ${situation.alarm.level}% · cores left ${situation.objective.dataCoresRemaining}`,
  );

  // 1. no known core? sweep the network for one rather than wandering blind
  if (!cores.length && situation.objective.dataCoresRemaining > 0) {
    const ring = 6 + (lastPingRing % 3) * 6;
    const spots = [
      { x: me.x + ring, y: me.y },
      { x: me.x, y: me.y + ring },
      { x: me.x - ring, y: me.y },
      { x: me.x, y: me.y - ring },
    ];
    const spot = spots[lastPingRing % spots.length];
    lastPingRing++;
    const clamped = {
      x: Math.max(1, Math.min(situation.mapSize.width - 2, spot.x)),
      y: Math.max(1, Math.min(situation.mapSize.height - 2, spot.y)),
    };
    if (situation.agent.bandwidth > 0) {
      await act('ping_scan', clamped, 'looking for a data core');
    } else {
      await act('end_turn', {}, 'out of bandwidth to scan');
    }
    continue;
  }

  // 2. pick the objective: nearest un-hacked core, else the extraction pad
  const target = cores.length
    ? cores.sort((a, b) => dist(me, a.position) - dist(me, b.position))[0].position
    : situation.objective.extractionAt;
  const goingToCore = cores.length > 0;

  // 3. standing next to the core? take it
  if (goingToCore && Math.max(Math.abs(target.x - me.x), Math.abs(target.y - me.y)) <= 1) {
    const hacked = await act('hack_terminal', {}, 'siphon the core');
    if (!hacked.isError) continue;
  }
  if (!goingToCore && me.x === target.x && me.y === target.y) {
    const out = await act('extract', {}, 'extraction pad');
    if (!out.isError) continue;
  }

  // 4. read the route before walking it
  const routeResult = await call('plan_route', target);
  const route = data(routeResult);
  if (!route) {
    await act('end_turn', {}, 'no route — wait for patrols to shift');
    continue;
  }
  console.log(
    `  · route ${route.length} steps, ${route.exposedSteps} exposed, risk ${route.totalRisk}`,
  );

  // 5. the route is watched — spend bandwidth to make it safe, then walk it
  const danger = route.mostDangerousStep;
  if (danger && situation.agent.bandwidth > 0) {
    const camera = danger.watchedBy.find((id) => id.startsWith('cam'));
    const guard = danger.watchedBy.find((id) => id.startsWith('guard'));

    if (camera && situation.agent.bandwidth >= 2) {
      await act('loop_camera', { camera_id: camera }, `blind ${camera} over the crossing`);
    } else if (guard && situation.agent.bandwidth >= 2) {
      // pull the guard away from the route, not toward the operative
      const g = situation.guards.find((entry) => entry.id === guard);
      const away = g
        ? { x: g.position.x + (g.position.x - me.x), y: g.position.y + (g.position.y - me.y) }
        : null;
      const spot = away
        ? {
            x: Math.max(1, Math.min(situation.mapSize.width - 2, away.x)),
            y: Math.max(1, Math.min(situation.mapSize.height - 2, away.y)),
          }
        : null;
      if (spot) await act('trigger_distraction', spot, `pull ${guard} off the route`);
      else await act('cut_power', {}, 'shorten every cone');
    } else if (situation.agent.bandwidth >= 3) {
      await act('cut_power', {}, 'shorten every cone');
    }
  }

  // 6. a guard already hunting is the emergency: put a door between you
  const hunter = situation.guards.find((g) => g.state === 'hunting');
  if (hunter && situation.agent.bandwidth >= 1) {
    const doorStep = route.steps
      .slice(0, situation.operative.actionPoints)
      .find((s) => dist({ x: s.x, y: s.y }, hunter.position) < dist(me, hunter.position));
    if (doorStep) {
      const probe = data(await call('assess_tile', { x: doorStep.x, y: doorStep.y }));
      if (probe?.terrain === 'door') {
        await act('cycle_door', { x: doorStep.x, y: doorStep.y, seal: true }, `lock out ${hunter.id}`);
      }
    }
  }

  // 7. move — but stop on a tile that is not watched. Ending a turn inside a
  //    cone is what gets the operative caught, so a shorter safe move beats a
  //    longer exposed one.
  const reachable = route.steps.slice(0, situation.operative.actionPoints);
  const safest = [...reachable].reverse().find((s) => s.risk === 0);
  const fallback = reachable.reduce(
    (best, s) => (best === null || s.risk < best.risk ? s : best),
    null,
  );
  // no unwatched step available: advancing into a cone is how runs end. Spend
  // bandwidth to clear the way, and failing that hold position — unless the
  // operative is already being watched, when standing still is the worse option.
  const exposedHere = situation.operative.currentlyWatchedBy.length > 0;

  // already in a cone with nowhere safe ahead: break line of sight rather than
  // pushing on, otherwise the alarm climbs every turn until lockdown
  if (exposedHere && !safest) {
    const neighbours = [
      { x: me.x + 1, y: me.y },
      { x: me.x - 1, y: me.y },
      { x: me.x, y: me.y + 1 },
      { x: me.x, y: me.y - 1 },
    ];
    let refuge = null;
    for (const spot of neighbours) {
      const probe = data(await call('assess_tile', spot));
      if (probe?.walkable && probe.risk === 0) {
        refuge = { spot, cover: probe.givesCover };
        break;
      }
    }
    if (refuge) {
      await act(
        'move_operative',
        refuge.spot,
        `breaking line of sight from ${situation.operative.currentlyWatchedBy.join(', ')}`,
      );
      await act('end_turn', {});
      continue;
    }
  }

  if (!safest && !exposedHere) {
    if (situation.agent.bandwidth >= 3 && situation.powerOutTurnsRemaining === 0) {
      await act('cut_power', {}, 'every forward step is watched');
      continue;
    }
    stalled++;
    if (stalled < 3) {
      await act('end_turn', {}, 'holding — waiting for the patrol to turn away');
      continue;
    }
  }
  stalled = 0;

  const step = safest ?? fallback;
  const moveTo = step ? { x: step.x, y: step.y } : target;
  const moved = await act(
    'move_operative',
    moveTo,
    `${goingToCore ? 'toward the core' : 'toward extraction'}${
      step ? `, ending on risk ${step.risk}` : ''
    }`,
  );

  if (shots) {
    await page.screenshot({ path: `.demo/turn-${String(turn).padStart(2, '0')}.png` });
  }

  // 7. out of action points — hand the floor to the guards
  const after = data(await call('get_situation'));
  if (after && after.phase === 'playing' && after.operative.actionPoints <= 0) {
    await act('end_turn', {});
  } else if (moved.isError) {
    await act('end_turn', {}, 'stuck this turn');
  }
}

const final = data(await call('get_run_status'));
console.log('\n─────────────────────────────');
console.log(`phase        : ${final?.phase}`);
console.log(`floor        : ${final?.floor}/${final?.totalFloors}`);
console.log(`intel        : ${final?.intelThisRun}`);
console.log(`tool calls   : ${calls}`);
if (final?.endReason) console.log(`ended        : ${final.endReason}`);
console.log('─────────────────────────────');

await browser.close();
