"""qa/adultbeat.py — adult identity must reach her question with her on screen."""
import time, json
from playwright.sync_api import sync_playwright
LAUNCH = ["--use-gl=swiftshader","--enable-unsafe-swiftshader",
          "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"]
with sync_playwright() as p:
    b = p.chromium.launch(args=LAUNCH)
    pg = b.new_page(viewport={"width": 440, "height": 280})
    errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)[:110]))
    pg.on("console", lambda m: errs.append("c:"+m.text[:110]) if m.type=="error" else None)
    pg.goto("http://127.0.0.1:8080/index.html?v=b89&quality=min", wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev", timeout=300000)
    pg.wait_for_function("() => !document.getElementById('enter-btn').disabled", timeout=300000)
    pg.evaluate("() => document.getElementById('enter-btn').click()")
    time.sleep(0.4)
    pg.evaluate("() => { const c = document.getElementById('intro-card'); if (c) c.click(); }")
    for _ in range(120):
        if pg.evaluate("() => window.__dev.game.state") == "SELECT": break
        time.sleep(0.3)
    pg.evaluate("() => window.__dev.selectClass('adult')")
    t = time.time()
    while pg.evaluate("() => window.__dev.game.state") != "EXPLORE" and time.time() - t < 60: time.sleep(0.1)
    print("alley: %.1fs" % (time.time()-t), flush=True)
    pg.evaluate("() => { window.__dev.game.player.position.z = -18.4; }")
    for _ in range(60):
        time.sleep(0.3)
        if pg.evaluate("() => window.__dev.game.state") == "DIALOGUE": break
    for _ in range(60):
        time.sleep(0.3)
        if pg.evaluate("() => { const d=window.__dev; return d.world.camera.position.distanceTo(d.maigo.root.position) < 5.0; }"): break
    time.sleep(2)
    print("beat:", json.dumps(pg.evaluate("""() => { const d=window.__dev, cam=d.world.camera, r=d.maigo.root;
        return {state:d.game.state, cls:d.game.classType, vis:!!r.visible, isVRM:!!d.maigo.isVRM, nan:d.maigo.nanBones,
                dist:+cam.position.distanceTo(r.position).toFixed(2),
                hud: (() => { const h=document.getElementById('protocol-hud'); return h ? getComputedStyle(h).display : 'absent'; })(),
                path: (document.getElementById('path-tag')||{}).textContent || null}; }""")), flush=True)
    print("errors:", errs[:3] or "none", flush=True)
    b.close()
