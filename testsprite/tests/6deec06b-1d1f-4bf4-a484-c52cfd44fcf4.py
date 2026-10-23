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

        stats = page.locator("#stats")
        bridge_status = page.locator("#bridge-status")

        await rig()

        # Verify bridge status shows connected mode
        await expect(bridge_status).to_contain_text(re.compile(r"connected|native|polyfill", re.IGNORECASE), timeout=15000)

        # Verify tool count is displayed
        tool_count = page.locator("#tool-count")
        await expect(tool_count).to_have_text(re.compile(r"\d+"), timeout=15000)

        await asyncio.sleep(2)
    finally:
        if context:
            await context.close()
        if browser:
            await browser.close()
        if pw:
            await pw.stop()


asyncio.run(run_test())