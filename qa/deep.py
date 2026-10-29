"""qa/deep.py — attribute every long frame to an exact function, and watch
   draw calls / frame time for growth during real play."""
import time, json
from playwright.sync_api import sync_playwright

LAUNCH = ["--use-gl=swiftshader","--enable-unsafe-swiftshader",
          "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"]

with sync_playwright() as p:
    b = p.chromium.launch(args=LAUNCH)
    pg = b.new_page(viewport={"width": 460, "height": 290})
    errs=[]
    pg.on("pageerror", lambda e: errs.append(str(e)[:130]))
    pg.on("console", lambda m: errs.append("c:"+m.text[:130]) if m.type=="error" else None)
    pg.goto("http://127.0.0.1:8080/index.html?v=b89&quality=min&stage=follow", wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev && window.__dev.game.state === 'FOLLOW'", timeout=300000)
    pg.evaluate("""() => {
      window.__long = [];
      try {
        new PerformanceObserver((l) => { for (const e of l.getEntries()) {
          if (e.duration < 300) continue;
          window.__long.push({ ms: Math.round(e.duration),
            scripts: (e.scripts || []).map(s => ({ fn: s.sourceFunctionName || 'anon',
              url: (s.sourceURL || '').split('/').pop(), pos: s.sourceCharPosition,
              dur: Math.round(s.duration), inv: s.invoker })).slice(0, 3) });
        }}).observe({ entryTypes: ['long-animation-frame'] });
      } catch (e) {}
      // draw calls measured INSIDE the frame, after the scene pass
      window.__calls = [];
      const w = window.__dev.world, real = w.render.bind(w);
      w.render = () => { real(); window.__calls.push([ Math.round(performance.now()),
        w.renderer.info.render.calls, w.renderer.info.render.triangles ]); };
      window.__ft = []; let last = performance.now();
      const tick = (t) => { window.__ft.push([Math.round(t), Math.round(t - last)]); last = t;
        if (window.__ft.length > 9000) window.__ft.shift(); requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    }""")
    t0 = time.time()
    pg.keyboard.down("w")
    time.sleep(45)
    pg.keyboard.up("w")
    d = pg.evaluate("""() => {
      const ft = window.__ft, cs = window.__calls;
      const mark = window.__ft[0][0];
      const rel = ft.map(([t, d]) => [t - mark, d]).filter(([t]) => t > 8000);
      const ds = rel.map(x => x[1]).sort((a, b) => a - b);
      const q = (p) => ds.length ? ds[Math.floor(ds.length * p)] : -1;
      const calls = cs.filter(([t]) => t > mark + 8000).map(x => x[1]);
      const tris = cs.filter(([t]) => t > mark + 8000).map(x => x[2]);
      const mn = a => a.length ? Math.min(...a) : -1, mx = a => a.length ? Math.max(...a) : -1;
      const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : -1;
      return {
        frames_after_8s: ds.length,
        frame_ms_median: q(0.5), p95: q(0.95), max: mx(ds),
        first10s_median: (() => { const a = rel.filter(([t]) => t < 10000).map(x => x[1]).sort((x,y)=>x-y);
          return a.length ? a[Math.floor(a.length/2)] : -1; })(),
        last10s_median: (() => { const a = rel.filter(([t]) => t > t0 - 10000).map(x => x[1]).sort((x,y)=>x-y);
          return a.length ? a[Math.floor(a.length/2)] : -1; })(),
        calls_min: mn(calls), calls_max: mx(calls), calls_avg: avg(calls),
        tris_min: mn(tris), tris_max: mx(tris),
        state: window.__dev.game.state,
        vis: !!window.__dev.maigo.root.visible,
        dist: +window.__dev.world.camera.position.distanceTo(window.__dev.maigo.root.position).toFixed(2),
        heap: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1,
        long: window.__long.slice(0, 8),
      };
    }""".replace("t0", "window.__t0") if False else """() => {
      const ft = window.__ft, cs = window.__calls;
      const mark = ft[0][0];
      const rel = ft.map(([t, d]) => [t - mark, d]).filter(([t]) => t > 8000);
      const ds = rel.map(x => x[1]).sort((a, b) => a - b);
      const q = (p) => ds.length ? ds[Math.floor(ds.length * p)] : -1;
      const calls = cs.filter(([t]) => t > mark + 8000).map(x => x[1]);
      const tris = cs.filter(([t]) => t > mark + 8000).map(x => x[2]);
      const mn = a => a.length ? Math.min(...a) : -1, mx = a => a.length ? Math.max(...a) : -1;
      const avg = a => a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : -1;
      const last = rel.length ? rel[rel.length - 1][0] : 0;
      return {
        frames_after_8s: ds.length,
        frame_ms_median: q(0.5), p95: q(0.95), max: mx(ds),
        first10s_median: (() => { const a = rel.filter(([t]) => t < 12000).map(x => x[1]).sort((x,y)=>x-y);
          return a.length ? a[Math.floor(a.length/2)] : -1; })(),
        last10s_median: (() => { const a = rel.filter(([t]) => t > last - 10000).map(x => x[1]).sort((x,y)=>x-y);
          return a.length ? a[Math.floor(a.length/2)] : -1; })(),
        calls_min: mn(calls), calls_max: mx(calls), calls_avg: avg(calls),
        tris_min: mn(tris), tris_max: mx(tris),
        state: window.__dev.game.state,
        vis: !!window.__dev.maigo.root.visible,
        dist: +window.__dev.world.camera.position.distanceTo(window.__dev.maigo.root.position).toFixed(2),
        heap_mb: performance.memory ? Math.round(performance.memory.usedJSHeapSize/1048576) : -1,
        long: window.__long.slice(0, 8),
      };
    }""")
    print(json.dumps(d, indent=1), flush=True)
    print("errors:", errs[:3] or "none", flush=True)
    b.close()
