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

        stats = page.locator("#stats")

        await rig()
        # Place a guard adjacent and verify takedown
        await page.evaluate(
            "() => { const g = window.nullrun.game; const p = g.state.player;"
            " const guard = g.state.floor.guards[0]; guard.x = p.x; guard.y = p.y + 1;"
            " guard.state = 'patrol'; guard.stunTurns = 0; g.emit(); }"
        )
        guards_before = await page.evaluate("() => window.nullrun.game.state.floor.guards.length")
        bodies_before = await page.evaluate("() => window.nullrun.game.state.floor.bodies.length")

        await expect(page.locator("#btn-takedown")).to_be_enabled(timeout=15000)
        await page.keyboard.press("t")
        await asyncio.sleep(0.5)

        guards_after = await page.evaluate("() => window.nullrun.game.state.floor.guards.length")
        bodies_after = await page.evaluate("() => window.nullrun.game.state.floor.bodies.length")
        assert guards_after == guards_before - 1, f"one guard removed: {guards_before} -> {guards_after}"
        assert bodies_after == bodies_before + 1, f"body left behind: {bodies_before} -> {bodies_after}"
        await expect(stats).to_contain_text(re.compile(r"action\s+pts\s*1/3", re.IGNORECASE), timeout=15000)

        await asyncio.sleep(2)
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


asyncio.run(run_test())