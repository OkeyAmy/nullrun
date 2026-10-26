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
        start = await pos()
        # Toggle sprint with Shift
        await page.keyboard.press("Shift")
        await asyncio.sleep(0.25)

        # Click 3 tiles ahead with sprint
        target = {"x": start["x"], "y": start["y"] + 3}
        pt = await tile_point(target["x"], target["y"])
        await page.mouse.click(pt["x"], pt["y"])

        reached = None
        for _ in range(50):
            reached = await pos()
            if reached == target:
                break
            await asyncio.sleep(0.1)
        assert reached == target, f"sprint click should cover 3 tiles: {start} -> {reached}"
        await expect(stats).to_contain_text(re.compile(r"action\s+pts\s*1/3", re.IGNORECASE), timeout=15000)
        await expect(stats).to_contain_text(re.compile(r"turn\s*1", re.IGNORECASE), timeout=15000)

        await asyncio.sleep(2)
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


asyncio.run(run_test())