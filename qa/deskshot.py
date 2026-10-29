import time, json
from playwright.sync_api import sync_playwright
URL = "http://127.0.0.1:8080/index.html?quality=high"
W, H = 820, 512
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader","--enable-unsafe-swiftshader",
                                "--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width": W, "height": H})
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true", timeout=300000)
    pg.wait_for_function("() => !document.getElementById('enter-btn').disabled", timeout=300000)
    pg.evaluate("() => document.getElementById('enter-btn').click()")
    time.sleep(0.5)
    pg.evaluate("() => { const c = document.getElementById('intro-card'); if (c) c.click(); }")
    for _ in range(120):
        if pg.evaluate("() => window.__dev.game.state") == "SELECT": break
        time.sleep(0.3)
    pg.evaluate("() => window.__dev.selectClass('student')")
    t = time.time()
    while pg.evaluate("() => window.__dev.game.state") != "EXPLORE" and time.time() - t < 40: time.sleep(0.1)
    pg.keyboard.down("w")
    while pg.evaluate("() => window.__dev.game.state") == "EXPLORE": time.sleep(0.2)
    pg.keyboard.up("w")
    time.sleep(4.5)
    pg.screenshot(path="/home/user/qa/desk_dialogue.png")
    print("dialogue:", pg.evaluate("() => window.__dev.game.state"), flush=True)
    print(json.dumps(pg.evaluate("""() => {
      const c = document.querySelector('#subtitle').getBoundingClientRect();
      const d = document.querySelector('#dialogue-choices').getBoundingClientRect();
      const cam = window.__dev.world.camera, r = window.__dev.maigo.root;
      return {sub:[c.left|0,c.top|0,c.right|0,c.bottom|0], cho:[d.left|0,d.top|0,d.right|0,d.bottom|0],
              dist:+cam.position.distanceTo(r.position).toFixed(2), vw:innerWidth, vh:innerHeight};
    }""")), flush=True)
    pg.evaluate("() => window.__dev.answer('yes')")
    time.sleep(6)
    pg.screenshot(path="/home/user/qa/desk_follow.png")
    print("follow:", pg.evaluate("() => window.__dev.game.state"),
          "| vis:", pg.evaluate("() => !!window.__dev.maigo.root.visible"),
          "| dist:", pg.evaluate("() => +window.__dev.world.camera.position.distanceTo(window.__dev.maigo.root.position).toFixed(2)"), flush=True)
    b.close()
