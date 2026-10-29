"""qa/pending.py — the beat must never wait inside a frame.

Case A: her model is not ready when the walk trigger fires, then arrives 4 s
        later  ->  the alley keeps running, the beat fires when she exists.
Case B: she never arrives            ->  the sculpted stand-in takes the beat
        after ~22 s instead of nothing happening at all.

`maigo.ready` is a getter over `active`, so readiness is simulated by holding a
reference to the real active rig aside and putting it back.
"""
import json, time
from playwright.sync_api import sync_playwright

URL = "http://127.0.0.1:8080/index.html?v=b89&quality=high&stage=explore"


def run(case_b=False):
    with sync_playwright() as p:
        b = p.chromium.launch(args=["--use-gl=swiftshader", "--enable-unsafe-swiftshader",
                                    "--disable-dev-shm-usage"])
        pg = b.new_page(viewport={"width": 400, "height": 250})
        errs = []
        pg.on("pageerror", lambda e: errs.append(str(e)[:150]))
        pg.goto(URL, wait_until="domcontentloaded")
        pg.wait_for_function("window.__maigoReady === true && window.__dev && window.__dev.game.state === 'EXPLORE'", timeout=300000)
        pg.evaluate("""() => {
          window.__held = window.__dev.maigo.active;
          window.__dev.maigo.active = null;                 // "she is not parsed yet"
          window.__st = [];
          try { new PerformanceObserver((l) => { for (const e of l.getEntries()) if (e.duration > 500)
            window.__st.push({d: Math.round(e.duration), fns: (e.scripts||[]).map(s=>(s.sourceFunctionName||'anon')+':'+Math.round(s.duration)).slice(0,3)});
          }).observe({entryTypes: ['long-animation-frame']}); } catch (e) {}
        }""")
        print("  ready now:", pg.evaluate("() => window.__dev.maigo.ready"), flush=True)
        pg.evaluate("() => { window.__dev.game.player.position.set(0, 0, -18.6); window.__dev.mechanics.checkManifestation(); }")
        time.sleep(1.5)
        print("  state 1.5 s after the trigger:", pg.evaluate("() => window.__dev.game.state"), flush=True)
        if case_b:
            time.sleep(24)
            print("  state after 25 s with no avatar:", pg.evaluate("() => window.__dev.game.state"),
                  "| active rig:", pg.evaluate("() => window.__dev.maigo.active === window.__held ? 'vrm' : (window.__dev.maigo.active ? 'stand-in' : 'none')"), flush=True)
        else:
            pg.evaluate("() => { window.__dev.maigo.active = window.__held; }")
            time.sleep(3)
            print("  state 3 s after she arrives:", pg.evaluate("() => window.__dev.game.state"), flush=True)
        st = pg.evaluate("() => window.__st")
        st.sort(key=lambda x: -x["d"])
        print("  worst stalls:", json.dumps(st[:4]), flush=True)
        print("  errors:", errs[:3], flush=True)
        b.close()


print("case A — she arrives a few seconds late")
run(False)
print("case B — she never arrives")
run(True)
