import time
from playwright.sync_api import sync_playwright
LAUNCH = ["--use-gl=swiftshader","--enable-unsafe-swiftshader",
          "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"]
with sync_playwright() as p:
    b = p.chromium.launch(args=LAUNCH)
    pg = b.new_page(viewport={"width": 900, "height": 506})
    errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
    pg.goto("http://127.0.0.1:8080/index.html?v=b89&quality=min", wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev", timeout=300000)
    pg.wait_for_function("() => !document.getElementById('enter-btn').disabled", timeout=300000)
    time.sleep(3)
    pg.screenshot(path="/home/user/qa/shot_title.png")
    print("title ok, state:", pg.evaluate("() => window.__dev.game.state"), flush=True)
    pg.evaluate("() => document.getElementById('enter-btn').click()")
    time.sleep(0.5)
    pg.evaluate("() => { const c = document.getElementById('intro-card'); if (c) c.click(); }")
    for _ in range(120):
        if pg.evaluate("() => window.__dev.game.state") == "SELECT": break
        time.sleep(0.3)
    time.sleep(3)
    pg.screenshot(path="/home/user/qa/shot_board.png")
    print("board ok, state:", pg.evaluate("() => window.__dev.game.state"),
          "| hover:", pg.evaluate("() => { try { return window.__dev.world._hoverKey || 'none'; } catch(e) { return 'n/a'; } }"), flush=True)
    print("errors:", errs or "none", flush=True)
    b.close()
