import time, json
from playwright.sync_api import sync_playwright
LAUNCH = ["--use-gl=swiftshader","--enable-unsafe-swiftshader",
          "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"]
with sync_playwright() as p:
    b = p.chromium.launch(args=LAUNCH)
    ctx = b.new_context(viewport={"width": 390, "height": 780}, has_touch=True, is_mobile=True, device_scale_factor=2,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    pg = ctx.new_page()
    pg.goto("http://127.0.0.1:8080/index.html?v=b89&quality=min&stage=dialogue", wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev && window.__dev.game.state === 'DIALOGUE'", timeout=300000)
    pg.evaluate("""() => { window.__ft=[]; let l=performance.now();
        const k=t=>{ window.__ft.push(t-l); l=t; if(window.__ft.length>200) window.__ft.shift(); requestAnimationFrame(k); };
        requestAnimationFrame(k); }""")
    t0 = time.time()
    seen = None
    for i in range(16):
        time.sleep(1)
        d = pg.evaluate("""() => { const mc = document.getElementById('m-choices');
            return {d: getComputedStyle(mc).display, cls: mc.className,
                    dc: document.getElementById('dialogue-choices').className}; }""")
        print(f"{time.time()-t0:5.1f}s  m-choices={d['d']:5s} cls={d['cls']!r:8s} dialogue-choices={d['dc']!r}", flush=True)
        if d["d"] != "none" and seen is None:
            seen = time.time() - t0
    print("first visible at:", seen, flush=True)
    print("canvas:", pg.evaluate("() => [window.__dev.world.renderer.domElement.width, window.__dev.world.renderer.domElement.height, window.__dev.world.renderer.getPixelRatio()]"), flush=True)
    ft = pg.evaluate("() => window.__ft.slice(3)")
    if ft:
        ft = sorted(ft); print("frame ms: median %.0f max %.0f" % (ft[len(ft)//2], ft[-1]), "=> fps ~%.1f" % (1000/ft[len(ft)//2]), flush=True)
    b.close()
