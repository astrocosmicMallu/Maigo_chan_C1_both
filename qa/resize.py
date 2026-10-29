"""qa/resize.py — does anything resize the frame while she is on stage?

Counts renderer.setSize / composer.setSize calls by game state. The old
governor fired every 1.8 s under 46 fps; that is the hitch being fixed.
"""
import json, time
from playwright.sync_api import sync_playwright
LAUNCH = ["--use-gl=swiftshader","--enable-unsafe-swiftshader",
          "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"]
with sync_playwright() as p:
    b = p.chromium.launch(args=LAUNCH)
    pg = b.new_page(viewport={"width": 420, "height": 260})
    pg.goto("http://127.0.0.1:8080/index.html?v=b89&quality=high", wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev", timeout=300000)
    pg.evaluate("""() => {
      const d = window.__dev, r = d.world.renderer, c = d.world.composer;
      window.__resizes = [];
      const wrap = (obj, name, tag) => { const f = obj[name].bind(obj);
        obj[name] = (...a) => { window.__resizes.push({ tag, at: d.game.state, t: Math.round(performance.now()) }); return f(...a); }; };
      wrap(r, 'setSize', 'renderer.setSize');
      wrap(c, 'setSize', 'composer.setSize');
      wrap(r, 'setPixelRatio', 'setPixelRatio');
    }""")
    pg.wait_for_function("() => !document.getElementById('enter-btn').disabled", timeout=300000)
    pg.evaluate("() => document.getElementById('enter-btn').click()")
    time.sleep(0.4)
    pg.evaluate("() => { const c = document.getElementById('intro-card'); if (c) c.click(); }")
    for _ in range(160):
        if pg.evaluate("() => window.__dev.game.state") == "SELECT": break
        time.sleep(0.3)
    pg.evaluate("() => window.__dev.selectClass('student')")
    t = time.time()
    while pg.evaluate("() => window.__dev.game.state") != "EXPLORE" and time.time() - t < 90: time.sleep(0.1)
    pg.evaluate("() => { window.__resizes.length = 0; }")
    # 12 s of exploration (the governor is allowed to act here)
    pg.keyboard.down("w"); time.sleep(12); pg.keyboard.up("w")
    print("EXPLORE 12 s  :", json.dumps(pg.evaluate("() => window.__resizes.map(x => x.tag+'@'+x.at)")), flush=True)
    pg.evaluate("() => { window.__resizes.length = 0; window.__dev.game.player.position.z = -18.4; }")
    while pg.evaluate("() => window.__dev.game.state") != "DIALOGUE": time.sleep(0.2)
    time.sleep(8)
    print("SHE APPEARS   :", json.dumps(pg.evaluate("() => window.__resizes.map(x => x.tag+'@'+x.at)")), flush=True)
    pg.evaluate("() => { window.__resizes.length = 0; }")
    pg.evaluate("() => window.__dev.answer('yes')")
    for _ in range(80):
        time.sleep(0.3)
        if pg.evaluate("() => window.__dev.game.state") == "FOLLOW": break
    pg.keyboard.down("w"); time.sleep(12); pg.keyboard.up("w")
    print("FOLLOW 12 s   :", json.dumps(pg.evaluate("() => window.__resizes.map(x => x.tag+'@'+x.at)")), flush=True)
    print("state:", pg.evaluate("() => window.__dev.game.state"), flush=True)
    b.close()
