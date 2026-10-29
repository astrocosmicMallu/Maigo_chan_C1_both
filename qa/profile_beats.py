"""qa/profile_beats.py — CPU-profile the two moments the player feels.

Samples the JS engine at high resolution across (a) her appearance and
(b) the turn-and-walk, then reports the functions that actually consumed the
main thread, plus any shader-program / texture / geometry created in-frame.
"""
import sys, json, time
from playwright.sync_api import sync_playwright

LAUNCH = ["--use-gl=swiftshader", "--enable-unsafe-swiftshader",
          "--autoplay-policy=no-user-gesture-required", "--disable-dev-shm-usage"]

COUNT = """() => { const i = window.__dev.world.renderer.info;
  return { p: i.programs.length, g: i.memory.geometries, t: i.memory.textures }; }"""


def top_nodes(profile, n=16):
    nodes = {x["id"]: x for x in profile["nodes"]}
    self_time = {}
    for s in profile["samples"]:
        self_time[s] = self_time.get(s, 0) + 1
    total = sum(self_time.values()) or 1
    rows = []
    for nid, cnt in self_time.items():
        nd = nodes.get(nid) or {}
        cf = nd.get("callFrame") or {}
        name = cf.get("functionName") or "(anonymous)"
        url = (cf.get("url") or "").split("/")[-1]
        line = cf.get("lineNumber", -1) + 1
        rows.append((cnt / total * 100, name, url, line))
    rows.sort(reverse=True)
    return rows[:n]


def run(pg, label, act, settle=4.0):
    before = pg.evaluate(COUNT)
    cdp = pg.context.new_cdp_session(pg)
    cdp.send("Profiler.enable")
    cdp.send("Profiler.setSamplingInterval", {"interval": 200})
    cdp.send("Profiler.start")
    act()
    time.sleep(settle)
    prof = cdp.send("Profiler.stop")["profile"]
    after = pg.evaluate(COUNT)
    cdp.send("Profiler.disable")
    print(f"\n--- {label} ---", flush=True)
    print("  resources: programs %d->%d  geometries %d->%d  textures %d->%d"
          % (before["p"], after["p"], before["g"], after["g"], before["t"], after["t"]), flush=True)
    for pct, name, url, line in top_nodes(prof):
        if pct < 1.0:
            continue
        print(f"  {pct:5.1f}%  {name[:38]:38s} {url}:{line}", flush=True)


with sync_playwright() as p:
    b = p.chromium.launch(args=LAUNCH)
    pg = b.new_page(viewport={"width": 520, "height": 330})
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
    pg.goto("http://127.0.0.1:8080/index.html?v=b89&quality=min", wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev", timeout=300000)
    pg.wait_for_function("() => !document.getElementById('enter-btn').disabled", timeout=300000)
    pg.evaluate("() => document.getElementById('enter-btn').click()")
    time.sleep(0.4)
    pg.evaluate("() => { const c = document.getElementById('intro-card'); if (c) c.click(); }")
    for _ in range(120):
        if pg.evaluate("() => window.__dev.game.state") == "SELECT":
            break
        time.sleep(0.3)
    pg.evaluate("() => window.__dev.selectClass('student')")
    t = time.time()
    while pg.evaluate("() => window.__dev.game.state") != "EXPLORE" and time.time() - t < 60:
        time.sleep(0.1)
    time.sleep(2)

    run(pg, "SHE APPEARS", lambda: pg.evaluate("() => { window.__dev.game.player.position.z = -18.4; }"), settle=8)
    while pg.evaluate("() => window.__dev.game.state") != "DIALOGUE":
        time.sleep(0.2)
    time.sleep(6)

    run(pg, "YES -> TURN AND WALK", lambda: pg.evaluate("() => window.__dev.answer('yes')"), settle=9)
    print("\n  state:", pg.evaluate("() => window.__dev.game.state"),
          "| vis:", pg.evaluate("() => !!window.__dev.maigo.root.visible"), flush=True)
    print("  errors:", errs[:3] or "none", flush=True)
    b.close()
