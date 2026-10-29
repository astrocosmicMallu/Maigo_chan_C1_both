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
    for t in (2, 5, 9):
        time.sleep(t if t == 2 else t - 2 if t == 5 else 4)
        print(t, json.dumps(pg.evaluate("""() => {
          const d = window.__dev, dc = document.getElementById('dialogue-choices'), mc = document.getElementById('m-choices');
          return {isMobile: d.game.isMobile, state: d.game.state,
                  dcClass: dc.className, dcHidden: dc.classList.contains('hidden'),
                  dcDisplay: getComputedStyle(dc).display,
                  mcClass: mc.className, mcDisplay: getComputedStyle(mc).display,
                  answered: !!d.game._answered};
        }""")), flush=True)
    print("forcing syncMobile…", flush=True)
    pg.evaluate("() => { window.__forceSync = true; }")
    time.sleep(1)
    print("after:", json.dumps(pg.evaluate("""() => {
        const mc = document.getElementById('m-choices');
        return {mcClass: mc.className, mcDisplay: getComputedStyle(mc).display}; }""")), flush=True)
    b.close()
