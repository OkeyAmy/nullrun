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
        start = await pos()
        target = {"x": start["x"], "y": start["y"] + 3}
        point = await tile_point(target["x"], target["y"])
        await page.mouse.click(point["x"], point["y"])

        reached = None
        for _ in range(50):
            reached = await pos()
            if reached == target:
                break
            await asyncio.sleep(0.1)
        assert reached == target, f"path click should reach the target: {start} -> {reached}"

        # three steps spend all three AP, so the turn auto-ends and AP is refilled
        await expect(stats).to_contain_text(
            re.compile(r"action\s+pts\s*3/3", re.IGNORECASE), timeout=15000
        )
        turn = await turn_number()
        assert turn == 2, f"spending every AP must auto-end the turn (turn={turn})"
        phase = await page.evaluate("() => window.nullrun.game.state.phase")
        assert phase == "playing", f"phase after the auto end-turn: {phase}"

        await asyncio.sleep(2)
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


asyncio.run(run_test())
