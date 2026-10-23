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

        stats = page.locator("#stats")

        await rig()
        # Complete objective
        await page.evaluate(
            "() => { const g = window.nullrun.game; const p = g.state.player;"
            " const t = g.state.floor.terminals.find((x) => x.kind === 'data') || g.state.floor.terminals[0];"
            " t.x = p.x; t.y = p.y + 1; t.hacked = false; g.emit(); }"
        )
        await expect(page.locator("#btn-hack")).to_be_enabled(timeout=15000)
        await page.keyboard.press("e")
        await asyncio.sleep(0.5)

        # Walk onto extraction pad - verify gating
        await page.evaluate(
            "() => { const g = window.nullrun.game; const e = g.state.floor.extraction;"
            " g.state.player = { x: e.x, y: e.y }; g.emit(); }"
        )
        await asyncio.sleep(0.25)
        await expect(page.locator("#btn-extract")).to_be_enabled(timeout=15000)
        await page.keyboard.press("x")
        await asyncio.sleep(0.6)

        phase = await page.evaluate("() => window.nullrun.game.state.phase")
        assert phase == "choosing_implant", f"extraction should open implant choice, got {phase}"

        await asyncio.sleep(2)
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


asyncio.run(run_test())