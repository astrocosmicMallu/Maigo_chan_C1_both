"""qa/nantest.py — does a poisoned skeleton get repaired, or does she vanish?

Injects NaN into a bone high in the hierarchy (the way a driver-dependent pose
solve can), then checks whether she is still drawn and whether the new guard
puts her back.
"""
import time, json
from playwright.sync_api import sync_playwright
URL = "http://127.0.0.1:8080/index.html?v=b89&quality=high&stage=dialogue"
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader","--enable-unsafe-swiftshader",
                                "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width": 520, "height": 330})
    logs=[]
    pg.on("console", lambda m: logs.append(m.type+": "+m.text[:110]))
    pg.on("pageerror", lambda e: logs.append("ERR: "+str(e)[:110]))
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev && window.__dev.game.state === 'DIALOGUE'", timeout=300000)
    time.sleep(2)
    print("bones watched:", pg.evaluate("() => (window.__dev.maigo.active._sanitizeBones||[]).length"), flush=True)
    print("report before:", json.dumps(pg.evaluate("() => { const m=window.__dev.maigo, c=window.__dev.world.camera; const h=m.headWorldPosition().project(c); return [+h.x.toFixed(2),+h.y.toFixed(2),+h.z.toFixed(2)]; }")), flush=True)
    # poison the hips (root of the whole body hierarchy)
    out = pg.evaluate("""() => {
      const v = window.__dev.maigo.active;
      const bones = v._sanitizeBones || [];
      const hips = bones.find(b => /hips/i.test(b.name)) || bones[0];
      hips.quaternion.w = NaN;
      return {poisoned: hips.name, total: bones.length};
    }""")
    print("poisoned:", out, flush=True)
    time.sleep(0.4)
    print("bones repaired after 1 frame:", pg.evaluate("() => window.__dev.maigo.active._nanBones"), flush=True)
    time.sleep(1.2)
    print("report after:", json.dumps(pg.evaluate("() => { const m=window.__dev.maigo, c=window.__dev.world.camera; const h=m.headWorldPosition(); const fin = Number.isFinite(h.x)&&Number.isFinite(h.y); const p=h.clone().project(c); return {finite: fin, ndc:[+p.x.toFixed(2),+p.y.toFixed(2),+p.z.toFixed(2)], vis: !!m.root.visible}; }")), flush=True)
    print("yaw finite:", pg.evaluate("() => Number.isFinite(window.__dev.game.player.yaw)"), flush=True)
    print("log:", [l for l in logs if 'Maigo' in l or 'nan' in l.lower()][:4], flush=True)
    pg.screenshot(path="/home/user/qa/nan_after.png")
    b.close()
