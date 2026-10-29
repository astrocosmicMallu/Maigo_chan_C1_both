"""qa/beat.py — one honest measurement of the Maigo-chan appearance beat.

    python3 qa/beat.py student
    python3 qa/beat.py adult

Boots the preview, walks title -> board -> alley, fires the manifestation, and
reports (a) the worst main-thread stalls with the function that owned them,
(b) the shader-program count before/after, (c) page errors. Nothing here
touches the game; every value comes from the live page.
"""
import sys, json, time
from playwright.sync_api import sync_playwright

CLS = (sys.argv[1] if len(sys.argv) > 1 else "student").lower()
URL = f"http://127.0.0.1:8080/index.html?v=b89&quality=high"

RECORDER = """
() => {
  window.__worst = [];
  window.__gaps = [];
  let last = performance.now();
  window.__raf = (t) => {
    const d = t - last; last = t;
    window.__gaps.push(Math.round(d));
    if (window.__gaps.length > 6000) window.__gaps.shift();
    requestAnimationFrame(window.__raf);
  };
  requestAnimationFrame(window.__raf);
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        if (e.duration < 120) continue;
        window.__worst.push({
          d: Math.round(e.duration),
          fns: (e.scripts || []).map(s => (s.sourceFunctionName || 'anonymous') + ':' + Math.round(s.duration)).slice(0, 4)
        });
      }
    }).observe({ entryTypes: ['long-animation-frame'] });
  } catch (e) { window.__noLoaf = true; }
}
"""

def worst(pg, n=5):
    try:
        ws = pg.evaluate("() => (window.__worst || []).slice()")
    except Exception:
        ws = []
    ws.sort(key=lambda x: -x["d"])
    return json.dumps(ws[:n])

with sync_playwright() as p:
    b = p.chromium.launch(args=[
        "--use-gl=swiftshader", "--enable-unsafe-swiftshader",
        "--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage",
    ])
    pg = b.new_page(viewport={"width": 560, "height": 360})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:160]))
    pg.on("console", lambda m: errs.append("console:" + m.text[:140]) if m.type == "error" else None)
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true", timeout=300000)
    print("checkShaderErrors:", pg.evaluate("() => window.__dev.world.renderer.debug.checkShaderErrors"), flush=True)
    pg.wait_for_function("() => !document.getElementById('enter-btn').disabled", timeout=240000)
    pg.evaluate(RECORDER)
    progs = pg.evaluate("() => window.__dev.world.renderer.info.programs.length")
    print("programs at title:", progs, flush=True)

    pg.evaluate("() => document.getElementById('enter-btn').click()")
    time.sleep(0.4)
    pg.evaluate("() => { const c = document.getElementById('intro-card'); if (c) c.click(); }")
    for _ in range(80):
        if pg.evaluate("() => window.__dev.game.state") == "SELECT":
            break
        time.sleep(0.35)
    print("state after intro:", pg.evaluate("() => window.__dev.game.state"), flush=True)

    t0 = time.time()
    pg.evaluate(f"() => window.__dev.selectClass('{CLS}')")
    while pg.evaluate("() => window.__dev.game.state") != "EXPLORE" and time.time() - t0 < 40:
        time.sleep(0.1)
    pg.wait_for_timeout(600)
    pre = pg.evaluate("() => window.__dev.world.renderer.info.programs.length")
    print("state in alley:", pg.evaluate("() => window.__dev.game.state"), "| programs:", pre, flush=True)

    pg.evaluate("() => { window.__worst.length = 0; window.__gaps.length = 0; }")
    tm = time.time()
    pg.evaluate("() => window.__dev.game.triggerManifestation()")
    pg.wait_for_timeout(9000)
    print("state after beat:", pg.evaluate("() => window.__dev.game.state"),
          "| manifests in %.1fs" % (time.time() - tm), flush=True)
    print("worst frames:", worst(pg), flush=True)
    print("programs after:", pg.evaluate("() => window.__dev.world.renderer.info.programs.length"), flush=True)
    print("stall badge:", json.dumps(pg.evaluate("() => window.__stalls || []"))[:400], flush=True)
    print("maigo vis:", pg.evaluate("() => !!(window.__dev.maigo.root && window.__dev.maigo.root.visible)"),
          "| vrm:", pg.evaluate("() => !!window.__dev.maigo.isVRM"), flush=True)
    print("errors:", errs[:4], flush=True)
    b.close()
