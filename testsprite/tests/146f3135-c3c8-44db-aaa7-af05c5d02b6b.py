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

        await rig()
        # Compact viewport for panning
        await page.set_viewport_size({"width": 960, "height": 560})
        pannable = False
        for _ in range(30):
            pannable = await page.evaluate("() => window.nullrun.renderer.pannable")
            if pannable:
                break
            await asyncio.sleep(0.1)
        assert pannable is True, "camera should be pannable"

        before = await page.evaluate(
            "() => ({ ox: window.nullrun.renderer.originX, oy: window.nullrun.renderer.originY })"
        )
        start = await pos()

        box = await page.locator("#board").bounding_box()
        sx = box["x"] + box["width"] * 0.6
        sy = box["y"] + box["height"] - 25
        await page.mouse.move(sx, sy)
        await page.mouse.down()
        await page.mouse.move(sx - 60, sy - 80, steps=12)
        await page.mouse.up()
        await asyncio.sleep(0.4)

        after = await page.evaluate(
            "() => ({ ox: window.nullrun.renderer.originX, oy: window.nullrun.renderer.originY })"
        )
        assert after["oy"] <= before["oy"] - 50, f"dragging up should pan camera: {before} -> {after}"

        moved = await pos()
        assert moved == start, f"panning must not move operative: {start} -> {moved}"

        await asyncio.sleep(2)
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


asyncio.run(run_test())