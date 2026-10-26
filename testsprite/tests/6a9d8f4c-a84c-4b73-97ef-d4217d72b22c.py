import asyncio
import re
from playwright import async_api
from playwright.async_api import expect

SEED = 20260922


async def run_test():
    pw = None
    browser = None
    context = None

    try:
        pw = await async_api.async_playwright().start()
        browser = await pw.chromium.launch(
            headless=True,
            args=[
                "--window-size=1280,720",
                "--disable-dev-shm-usage",
                "--ipc=host",
                "--single-process",
            ],
        )
        context = await browser.new_context()
        context.set_default_timeout(15000)
        page = await context.new_page()

        async def rig(seed=SEED):
            await page.goto("VAR_{url}")
            try:
                await page.wait_for_load_state("domcontentloaded", timeout=5000)
            except Exception:
                pass
            await page.wait_for_function("() => Boolean(window.nullrun)", timeout=20000)
            await page.evaluate("(s) => window.nullrun.game.newRun(s)", seed)
            await asyncio.sleep(0.3)
            await page.click('.overlay [data-mode="coop"]')
            await page.click("#btn-begin")
            await asyncio.sleep(0.4)

        async def pos():
            return await page.evaluate(
                "() => ({ x: window.nullrun.game.state.player.x, y: window.nullrun.game.state.player.y })"
            )

        async def tile_point(x, y):
            return await page.evaluate(
                "([tx, ty]) => { const r = window.nullrun.renderer;"
                " const rect = document.getElementById('board').getBoundingClientRect();"
                " return { x: rect.left + r.px(tx) + r.tileSize / 2, y: rect.top + r.py(ty) + r.tileSize / 2 }; }",
                [x, y],
            )

        async def turn_number():
            return await page.evaluate("() => window.nullrun.game.state.turn")

        async def find_adjacent_door():
            return await page.evaluate(
                "() => { const g = window.nullrun.game; const p = g.state.player;"
                " const f = g.state.floor;"
                " for (let dy = -1; dy <= 1; dy++) { for (let dx = -1; dx <= 1; dx++) {"
                " const t = f.tiles[(p.y + dy) * f.width + (p.x + dx)];"
                " if (t && t.kind === 'door') return { x: p.x + dx, y: p.y + dy, open: t.open }; } }"
                " return null; }"
            )

        async def door_state(x, y):
            return await page.evaluate(
                "([dx, dy]) => { const f = window.nullrun.game.state.floor;"
                " const t = f.tiles[dy * f.width + dx]; return { kind: t.kind, open: t.open }; }",
                [x, y],
            )

        stats = page.locator("#stats")

        await rig()
        # stand a hunting guard next to the operative
        await page.evaluate(
            "() => { const g = window.nullrun.game; const p = g.state.player;"
            " const guard = g.state.floor.guards[0];"
            " guard.x = p.x; guard.y = p.y + 1; guard.state = 'hunting'; guard.stunTurns = 0;"
            " guard.investigating = { x: p.x, y: p.y }; g.emit(); }"
        )
        await asyncio.sleep(0.3)

        # end the turn through the real keybinding: the guard grabs the operative
        await page.keyboard.press(" ")

        phase = None
        for _ in range(50):
            phase = await page.evaluate("() => window.nullrun.game.state.phase")
            if phase == "run_failed":
                break
            await asyncio.sleep(0.1)
        assert phase == "run_failed", f"the guard should end the run (phase={phase})"

        end_reason = await page.evaluate("() => window.nullrun.game.state.endReason")
        assert end_reason and "got hands on you" in end_reason.lower(), f"endReason: {end_reason}"

        log_text = await page.locator("#log").text_content()
        assert log_text and "got hands on you" in log_text.lower(), f"failure not in log: {log_text}"

        await asyncio.sleep(2)
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


asyncio.run(run_test())
