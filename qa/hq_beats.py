"""qa/hq_beats.py — the two moments at FULL quality (the path a real player takes).

Swiftshader can only survive high quality at a tiny size, but the code paths
(env map, MSAA, rain, ripples, extra lights) are the same ones a real GPU runs.
"""
import json, time
from playwright.sync_api import sync_playwright
LAUNCH = ["--use-gl=swiftshader","--enable-unsafe-swiftshader",
          "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"]

WATCH = """() => {
  const i = window.__dev.world.renderer.info;
  window.__events = [];
  let lp = i.programs.length, lg = i.memory.geometries, lt = i.memory.textures;
  setInterval(() => {
    if (i.programs.length !== lp || i.memory.geometries !== lg || i.memory.textures !== lt) {
      window.__events.push({ t: Math.round(performance.now()), at: window.__dev.game.state,
        p: i.programs.length, g: i.memory.geometries, tx: i.memory.textures,
        dp: i.programs.length - lp, dg: i.memory.geometries - lg, dt: i.memory.textures - lt });
      lp = i.programs.length; lg = i.memory.geometries; lt = i.memory.textures;
    }
  }, 16);
  window.__long = [];
  try { new PerformanceObserver((l) => { for (const e of l.getEntries())
    if (e.duration > 150) window.__long.push({ ms: Math.round(e.duration), at: window.__dev.game.state,
      fns: (e.scripts||[]).map(s => (s.sourceFunctionName||'anon')+':'+Math.round(s.duration)).slice(0,4) });
  }).observe({ entryTypes: ['long-animation-frame'] }); } catch (e) {}
}"""

with sync_playwright() as p:
    b = p.chromium.launch(args=LAUNCH)
    pg = b.new_page(viewport={"width": 400, "height": 250})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
    pg.on("console", lambda m: errs.append("c:"+m.text[:120]) if m.type == "error" else None)
    pg.goto("http://127.0.0.1:8080/index.html?v=b89&quality=high", wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev", timeout=300000)
    print("quality flags:", pg.evaluate("""() => { const w = window.__dev.world;
        return {software: w.software, minQuality: w.minQuality, lowQuality: w.lowQuality,
                samples: w.composer && w.composer.renderTarget1 ? w.composer.renderTarget1.samples : null,
                rain: !!w.rain, env: !!(w.scene && w.scene.environment)}; }"""), flush=True)
    pg.wait_for_function("() => !document.getElementById('enter-btn').disabled", timeout=300000)
    pg.evaluate(WATCH)
    pg.evaluate("() => document.getElementById('enter-btn').click()")
    time.sleep(0.4)
    pg.evaluate("() => { const c = document.getElementById('intro-card'); if (c) c.click(); }")
    for _ in range(160):
        if pg.evaluate("() => window.__dev.game.state") == "SELECT": break
        time.sleep(0.3)
    pg.evaluate("() => window.__dev.selectClass('student')")
    t = time.time()
    while pg.evaluate("() => window.__dev.game.state") != "EXPLORE" and time.time() - t < 90: time.sleep(0.1)
    print("alley: %.1fs" % (time.time()-t), flush=True)
    time.sleep(2)

    pg.evaluate("() => { window.__events.length = 0; window.__long.length = 0; }")
    pg.evaluate("() => { window.__dev.game.player.position.z = -18.4; }")
    while pg.evaluate("() => window.__dev.game.state") != "DIALOGUE": time.sleep(0.2)
    time.sleep(8)
    print("\nAPPEAR  resource events:", json.dumps(pg.evaluate("() => window.__events"))[:600], flush=True)
    lg = pg.evaluate("() => window.__long"); lg.sort(key=lambda x: -x["ms"])
    print("APPEAR  worst frames  :", json.dumps(lg[:5]), flush=True)

    time.sleep(6)
    pg.evaluate("() => { window.__events.length = 0; window.__long.length = 0; }")
    pg.evaluate("() => window.__dev.answer('yes')")
    for _ in range(80):
        time.sleep(0.3)
        if pg.evaluate("() => window.__dev.game.state") == "FOLLOW": break
    time.sleep(8)
    print("\nYES     resource events:", json.dumps(pg.evaluate("() => window.__events"))[:600], flush=True)
    lg = pg.evaluate("() => window.__long"); lg.sort(key=lambda x: -x["ms"])
    print("YES     worst frames  :", json.dumps(lg[:5]), flush=True)
    print("\nstate:", pg.evaluate("() => window.__dev.game.state"),
          "| vis:", pg.evaluate("() => !!window.__dev.maigo.root.visible"), flush=True)
    print("errors:", errs[:4] or "none", flush=True)
    b.close()
