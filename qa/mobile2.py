"""qa/mobile2.py — a phone player must be able to answer the question."""
import time, json
from playwright.sync_api import sync_playwright
LAUNCH = ["--use-gl=swiftshader","--enable-unsafe-swiftshader",
          "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"]
with sync_playwright() as p:
    b = p.chromium.launch(args=LAUNCH)
    ctx = b.new_context(viewport={"width": 390, "height": 780}, has_touch=True, is_mobile=True,
        device_scale_factor=2,
        user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
    pg = ctx.new_page()
    errs = []
    pg.on("pageerror", lambda e: errs.append(str(e)[:120]))
    pg.goto("http://127.0.0.1:8080/index.html?v=b89&quality=min&stage=dialogue", wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev && window.__dev.game.state === 'DIALOGUE'", timeout=300000)
    time.sleep(7)   # past the choice reveal
    info = pg.evaluate("""() => {
      const mc = document.getElementById('m-choices');
      const dc = document.getElementById('dialogue-choices');
      const cs = mc ? getComputedStyle(mc) : null;
      const btns = mc ? [...mc.querySelectorAll('button')].map(x => ({t: x.textContent.trim().slice(0,22),
          vis: getComputedStyle(x).display !== 'none', h: Math.round(x.getBoundingClientRect().height)})) : [];
      return {state: window.__dev.game.state,
              m_display: cs ? cs.display : 'absent', m_cls: mc ? mc.className : '',
              m_rect: mc ? (r => [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)])(mc.getBoundingClientRect()) : null,
              dialogue_choices_display: dc ? getComputedStyle(dc).display : 'absent',
              buttons: btns};
    }""")
    print("state", info["state"], "| m-choices display:", info["m_display"], "| class:", info["m_cls"])
    print("m-choices rect:", info["m_rect"])
    print("desktop choices display:", info["dialogue_choices_display"])
    for bt in info["buttons"]:
        print("  button", bt)
    flush = True
    pg.screenshot(path="/home/user/qa/mobile_choices.png")
    # tap the yes button, as a player would
    r = pg.evaluate("""() => { const mc = document.getElementById('m-choices');
        const btn = mc && mc.querySelector('.yes, [data-act=yes], button');
        if (!btn) return null; const q = btn.getBoundingClientRect();
        return [Math.round(q.left + q.width/2), Math.round(q.top + q.height/2)]; }""")
    print("yes button at:", r, flush=True)
    if r:
        pg.touchscreen.tap(r[0], r[1])
        for _ in range(40):
            time.sleep(0.4)
            if pg.evaluate("() => window.__dev.game.state") != "DIALOGUE":
                break
        print("after tap:", pg.evaluate("() => window.__dev.game.state"), flush=True)
    print("errors:", errs[:3] or "none", flush=True)
    b.close()
