/**
 * Browser smoke check: boots the real page, drives it the way a player and an
 * agent would, and fails loudly on any console error.
 *
 * Usage: node tools/smoke.mjs [url] [--headed]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2]?.startsWith('http') ? process.argv[2] : 'http://localhost:5183/';
const headed = process.argv.includes('--headed');

mkdirSync('.smoke', { recursive: true });

const browser = await chromium.launch({ headless: !headed });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

const errors = [];
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(msg.text());
});
page.on('pageerror', (err) => errors.push(String(err)));

function check(label, condition) {
  console.log(`${condition ? 'PASS' : 'FAIL'}  ${label}`);
  if (!condition) process.exitCode = 1;
}

await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.nullrun), null, { timeout: 10_000 });

// pin the facility seed so this check is repeatable — otherwise a random layout
// can end the run mid-script and the later assertions become nondeterministic
await page.evaluate(() => window.nullrun.game.newRun(20260903));
await page.waitForTimeout(150);

// --- briefing -------------------------------------------------------------
check('opening screen is shown', await page.locator('.overlay .card h2').isVisible());
check(
  'the opening screen offers all three play modes',
  (await page.locator('.overlay [data-mode]').count()) === 3,
);
await page.screenshot({ path: '.smoke/0-mode-select.png' });

await page.click('.overlay [data-mode="coop"]');
await page.waitForTimeout(200);
check('briefing follows the mode choice', await page.locator('.overlay .card h2').isVisible());
await page.screenshot({ path: '.smoke/1-briefing.png' });

const bridgeMode = await page.evaluate(() => window.nullrun.tools.bridge.mode);
const toolCount = await page.evaluate(() => window.nullrun.tools.registered.length);
console.log(`      WebMCP bridge: ${bridgeMode}, ${toolCount} tools registered`);
check('a WebMCP context was installed', bridgeMode !== 'unavailable');
check('tools are registered on document.modelContext', toolCount >= 15);

// --- start the floor ------------------------------------------------------
await page.click('#btn-begin');
await page.waitForTimeout(300);
check('overlay clears once the floor starts', await page.locator('.overlay').isHidden());
await page.screenshot({ path: '.smoke/2-floor.png' });

// --- the canvas is actually drawing ---------------------------------------
const painted = await page.evaluate(() => {
  const canvas = document.getElementById('board');
  const ctx = canvas.getContext('2d');
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const seen = new Set();
  for (let i = 0; i < data.length; i += 4 * 997) {
    seen.add(`${data[i]},${data[i + 1]},${data[i + 2]}`);
  }
  return seen.size;
});
check(`canvas renders a real scene (${painted} distinct sampled colours)`, painted > 5);

// --- a human moving around must not break the UI --------------------------
for (const key of ['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', ' ']) {
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(40);
  }
}
const afterMoving = await page.evaluate(() => ({
  phase: window.nullrun.game.state.phase,
  statsVisible: document.querySelectorAll('#stats .stat').length,
  actionButtons: document.querySelectorAll('#actionbar button').length,
  logEntries: document.querySelectorAll('.log-entry').length,
}));
check('HUD stats survive continuous movement', afterMoving.statsVisible >= 6);
check('action bar survives continuous movement', afterMoving.actionButtons >= 5);

// hit-test every control: a button that exists in the DOM but is covered by the
// canvas is invisible and unclickable, which is how the action bar broke before
const occluded = await page.evaluate(() =>
  [...document.querySelectorAll('#actionbar button')]
    .map((button) => {
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return { id: button.id, covered: hit !== button && !button.contains(hit) };
    })
    .filter((entry) => entry.covered)
    .map((entry) => entry.id),
);
check(
  `no action-bar button is covered by the canvas${occluded.length ? ` (${occluded.join(', ')})` : ''}`,
  occluded.length === 0,
);
console.log(`      phase after input: ${afterMoving.phase}, log entries: ${afterMoving.logEntries}`);
await page.screenshot({ path: '.smoke/3-after-input.png' });

// --- hovering must produce a route preview without throwing ---------------
const box = await page.locator('#board').boundingBox();
await page.mouse.move(box.x + box.width * 0.5, box.y + box.height * 0.5);
await page.waitForTimeout(120);
await page.mouse.move(box.x + box.width * 0.62, box.y + box.height * 0.42);
await page.waitForTimeout(120);
await page.screenshot({ path: '.smoke/4-hover.png' });

// --- drive it as an agent would, straight through document.modelContext ---
// reset to a known live floor first: the stress input above may legitimately
// have ended the run, and agent abilities are only valid while playing
await page.evaluate(() => {
  window.nullrun.game.newRun(20260903);
  window.nullrun.game.setMode('coop');
  window.nullrun.game.beginInfiltration();
});
await page.waitForTimeout(150);
check(
  'run is live before the agent drives it',
  (await page.evaluate(() => window.nullrun.game.state.phase)) === 'playing',
);

const agentRun = await page.evaluate(async () => {
  const call = async (name, args = {}) => {
    const tools = await document.modelContext.getTools();
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { name, missing: true };
    // the WebMCP core API takes arguments as a JSON string, and the polyfill
    // hands the result back serialised; native implementations return an object
    const raw = await document.modelContext.executeTool(tool, JSON.stringify(args));
    let result = raw;
    if (typeof raw === 'string') {
      try {
        result = JSON.parse(raw);
      } catch {
        result = { content: [{ type: 'text', text: raw }] };
      }
    }
    return { name, isError: Boolean(result?.isError), text: result?.content?.[0]?.text ?? '' };
  };

  const situation = await call('get_situation');
  const abilities = await call('list_abilities');
  const before = window.nullrun.game.state.bandwidth;
  const ping = await call('ping_scan', { x: 8, y: 6 });
  const after = window.nullrun.game.state.bandwidth;
  const status = await call('get_run_status');
  return {
    situationOk: !situation.isError && situation.text.includes('operative'),
    abilitiesOk: !abilities.isError && abilities.text.includes('bandwidth'),
    pingOk: !ping.isError,
    bandwidthSpent: before - after,
    statusOk: !status.isError,
  };
});

check('agent can read the situation via executeTool', agentRun.situationOk);
check('agent can read the ability economy', agentRun.abilitiesOk);
check('agent ping_scan executes', agentRun.pingOk);
check(`agent ping_scan spends bandwidth (${agentRun.bandwidthSpent})`, agentRun.bandwidthSpent > 0);
check('agent can read run status', agentRun.statusOk);
await page.screenshot({ path: '.smoke/5-after-agent.png' });

// --- console must be clean ------------------------------------------------
check(`no console errors (${errors.length})`, errors.length === 0);
for (const error of errors) console.log(`      console error: ${error}`);

await browser.close();
console.log(process.exitCode ? '\nSMOKE FAILED' : '\nSMOKE PASSED — screenshots in .smoke/');
