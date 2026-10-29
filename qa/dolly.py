import time, json
from playwright.sync_api import sync_playwright
URL = "http://127.0.0.1:8080/index.html?v=b89&quality=min&stage=dialogue"
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader","--enable-unsafe-swiftshader","--autoplay-policy=no-user-gesture-required","--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width": 420, "height": 260})
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && !!window.__dev && window.__dev.game.state === 'DIALOGUE'", timeout=300000)
    for i in range(5):
        print(i, json.dumps(pg.evaluate("""() => {
          const d = window.__dev, g = d.game;
          return {state: g.state, camZ: +d.world.camera.position.z.toFixed(2), playerZ: +g.player.position.z.toFixed(2),
                  goal: g.dialogue ? [+g.dialogue.goal.x.toFixed(2), +g.dialogue.goal.z.toFixed(2)] : null,
                  compact: g.dialogue ? g.dialogue.compact : null,
                  camTween: !!(window.__camTweenActive), tween: d.game._tween || null,
                  herZ: +d.maigo.root.position.z.toFixed(2), fov: +d.world.camera.fov.toFixed(1)};
        }""")), flush=True)
        time.sleep(1.5)
    b.close()
