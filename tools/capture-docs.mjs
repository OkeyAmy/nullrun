/**
 * Captures the screenshots embedded in README.md.
 * Usage: node tools/capture-docs.mjs [url]
 */
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const url = process.argv[2] ?? 'http://localhost:5183/';
mkdirSync('docs', { recursive: true });

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1440, height: 860 }, deviceScaleFactor: 2 });
await page.goto(url, { waitUntil: 'networkidle' });
await page.waitForFunction(() => Boolean(window.nullrun));
await page.evaluate(() => window.nullrun.game.newRun(20260903));
await page.waitForTimeout(200);

await page.screenshot({ path: 'docs/01-who-is-playing.png' });

await page.click('.overlay [data-mode="coop"]');
await page.waitForTimeout(150);
await page.screenshot({ path: 'docs/02-briefing.png' });

await page.click('#btn-begin');
await page.waitForTimeout(300);

// a readable mid-run frame: reveal the floor, stage guards in different states
await page.evaluate(() => {
  const g = window.nullrun.game, s = g.state;
  s.floor.discovered.fill(true);
  g.ping(s.floor.extraction.x, s.floor.extraction.y);
  const gs = s.floor.guards;
  if (gs[1]) gs[1].state = 'suspicious';
  if (gs[2]) gs[2].state = 'hunting';
  g.cutPower();
  g.log('agent', 'Grid cut — every cone shortened for 3 turns.');
  g.log('operative', 'Moving on the core while they are blind.');
});
await page.waitForTimeout(500);
await page.screenshot({ path: 'docs/03-infiltration.png' });

// hover a distant tile so the route-risk preview is visible
const box = await page.locator('#board').boundingBox();
await page.mouse.move(box.x + box.width * 0.55, box.y + box.height * 0.35);
await page.waitForTimeout(400);
await page.screenshot({ path: 'docs/04-route-risk.png' });

await browser.close();
console.log('wrote docs/01..04');
