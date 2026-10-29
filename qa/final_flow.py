"""qa/final_flow.py — both classes, real walk-in, YES -> follow. She must be on screen."""
import sys, json, time
from playwright.sync_api import sync_playwright

CLS = sys.argv[1]
URL = "http://127.0.0.1:8080/index.html?v=b89&quality=min"
errs, warns = [], []
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader","--enable-unsafe-swiftshader",
                                "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width": 520, "height": 330})
    pg.on("pageerror", lambda e: errs.append(str(e)[:130]))
    pg.on("console", lambda m: (errs if m.type == "error" else warns).append(m.text[:130]))
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true", timeout=300000)
    pg.wait_for_function("() => !document.getElementById('enter-btn').disabled", timeout=300000)
    pg.evaluate("() => document.getElementById('enter-btn').click()")
    time.sleep(0.4)
    pg.evaluate("() => { const c = document.getElementById('intro-card'); if (c) c.click(); }")
    for _ in range(120):
        if pg.evaluate("() => window.__dev.game.state") == "SELECT": break
        time.sleep(0.3)
    pg.evaluate(f"() => window.__dev.selectClass('{CLS}')")
    t = time.time()
    while pg.evaluate("() => window.__dev.game.state") != "EXPLORE" and time.time() - t < 45: time.sleep(0.1)
    print(f"[{CLS}] alley in %.1fs" % (time.time() - t), flush=True)

    pg.keyboard.down("w")
    t2 = time.time()
    while pg.evaluate("() => window.__dev.game.state") == "EXPLORE" and time.time() - t2 < 70: time.sleep(0.2)
    pg.keyboard.up("w")
    st = pg.evaluate("() => window.__dev.game.state")
    print(f"[{CLS}] after walking: {st} (%.1fs)" % (time.time() - t2), flush=True)

    # the beat: is she actually on screen?
    for _ in range(50):
        time.sleep(0.4)
        if pg.evaluate("() => { const d=window.__dev; return d.world.camera.position.distanceTo(d.maigo.root.position) < 5.0; }"): break
    time.sleep(1.5)
    rep = pg.evaluate("""() => {
      const d = window.__dev, cam = d.world.camera, r = d.maigo.root; r.updateMatrixWorld(true);
      let mnY=9,mxY=-9,mnX=9,mxX=-9; const v = new (cam.position.constructor)();
      r.traverse(o => { if (!o.isMesh || !o.visible) return; const g = o.geometry;
        if (!g.boundingBox) g.computeBoundingBox(); const bb = g.boundingBox;
        for (const c of [[bb.min.x,bb.min.y,bb.min.z],[bb.max.x,bb.max.y,bb.max.z],[bb.min.x,bb.max.y,bb.max.z],[bb.max.x,bb.min.y,bb.max.z]]) {
          v.set(c[0],c[1],c[2]).applyMatrix4(o.matrixWorld).project(cam);
          if (!isFinite(v.x)) continue; mnX=Math.min(mnX,v.x);mxX=Math.max(mxX,v.x);mnY=Math.min(mnY,v.y);mxY=Math.max(mxY,v.y); } });
      return { state: d.game.state, vis: !!r.visible, isVRM: !!d.maigo.isVRM, nan: d.maigo.nanBones,
               dist: +cam.position.distanceTo(r.position).toFixed(2),
               ndcY: [+mnY.toFixed(2), +mxY.toFixed(2)], ndcX: [+mnX.toFixed(2), +mxX.toFixed(2)],
               yawFinite: Number.isFinite(d.game.player.yaw) };
    }""")
    print(f"[{CLS}] beat: {json.dumps(rep)}", flush=True)
    pg.screenshot(path=f"/home/user/qa/flow_{CLS}_beat.png")

    pg.evaluate("() => window.__dev.answer('yes')")
    for _ in range(40):
        time.sleep(0.5)
        if pg.evaluate("() => window.__dev.game.state") == "FOLLOW": break
    time.sleep(2)
    fol = pg.evaluate("""() => { const d = window.__dev;
      return { state: d.game.state, vis: !!d.maigo.root.visible, mode: d.maigo.active ? d.maigo.active.mode : null,
               dist: +d.world.camera.position.distanceTo(d.maigo.root.position).toFixed(2),
               nan: d.maigo.nanBones }; }""")
    print(f"[{CLS}] after YES: {json.dumps(fol)}", flush=True)
    pg.screenshot(path=f"/home/user/qa/flow_{CLS}_follow.png")
    print(f"[{CLS}] errors: {errs[:4] or 'none'}", flush=True)
    print(f"[{CLS}] maigo warnings: {[w for w in warns if 'Maigo' in w][:3] or 'none'}", flush=True)
    b.close()
