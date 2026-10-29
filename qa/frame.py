"""qa/frame.py — where does she land on screen, and what covers her?"""
import time, json, sys
from playwright.sync_api import sync_playwright
W, H = (int(sys.argv[1]), int(sys.argv[2])) if len(sys.argv) > 2 else (520, 330)
URL = "http://127.0.0.1:8080/index.html?v=b89&quality=min&stage=dialogue"
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader","--enable-unsafe-swiftshader",
                                "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width": W, "height": H})
    errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev && window.__dev.game.state === 'DIALOGUE'", timeout=300000)
    # wait for the dolly to actually arrive (the software rig is frame-starved)
    for _ in range(80):
        time.sleep(0.5)
        if pg.evaluate("() => { const d=window.__dev; return d.world.camera.position.distanceTo(d.maigo.root.position) < 5.2; }"):
            break
    time.sleep(1.0)
    d = pg.evaluate("""() => {
      const cam = window.__dev.world.camera, r = window.__dev.maigo.root;
      r.updateMatrixWorld(true);
      let minX=9,maxX=-9,minY=9,maxY=-9;
      const v = new (cam.position.constructor)();
      r.traverse(o => { if(!o.isMesh||!o.visible) return;
        const g=o.geometry; if(!g.boundingBox) g.computeBoundingBox();
        const bb=g.boundingBox;
        for (const c of [[bb.min.x,bb.min.y,bb.min.z],[bb.max.x,bb.max.y,bb.min.z],[bb.min.x,bb.min.y,bb.max.z],[bb.max.x,bb.max.y,bb.max.z],[bb.min.x,bb.max.y,bb.min.z],[bb.max.x,bb.min.y,bb.max.z]]) {
          v.set(c[0],c[1],c[2]).applyMatrix4(o.matrixWorld).project(cam);
          if(!isFinite(v.x)||!isFinite(v.y)) continue;
          minX=Math.min(minX,v.x);maxX=Math.max(maxX,v.x);minY=Math.min(minY,v.y);maxY=Math.max(maxY,v.y);
        }});
      const rect = s => { const e=document.querySelector(s); if(!e) return null;
        const q=e.getBoundingClientRect(); const cs=getComputedStyle(e);
        if (cs.display==='none'||cs.visibility==='hidden'||q.height===0) return null;
        return {ndcTop:+(1-2*q.top/innerHeight).toFixed(2), ndcBot:+(1-2*q.bottom/innerHeight).toFixed(2)};
      };
      return {herNdc:{x:[+minX.toFixed(2),+maxX.toFixed(2)], y:[+minY.toFixed(2),+maxY.toFixed(2)]},
              dist:+cam.position.distanceTo(r.position).toFixed(2),
              sub:rect('#subtitle'), cho:rect('#dialogue-choices'), vp:[innerWidth,innerHeight],
              fov:+cam.fov.toFixed(1)};
    }""")
    print(json.dumps(d, indent=1), flush=True)
    pg.screenshot(path=f"/home/user/qa/frame_{W}x{H}.png")
    print("errors:", errs or "none", flush=True)
    b.close()
