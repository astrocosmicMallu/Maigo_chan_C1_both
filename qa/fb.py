import time, json
from playwright.sync_api import sync_playwright
URL = "http://127.0.0.1:8080/index.html?v=b89&quality=high&stage=explore"
with sync_playwright() as p:
    b = p.chromium.launch(args=["--use-gl=swiftshader","--enable-unsafe-swiftshader","--disable-dev-shm-usage"])
    pg = b.new_page(viewport={"width": 360, "height": 230})
    logs=[]
    pg.on("console", lambda m: logs.append(m.type+":"+m.text[:120]))
    pg.on("pageerror", lambda e: logs.append("ERR:"+str(e)[:120]))
    pg.goto(URL, wait_until="domcontentloaded")
    pg.wait_for_function("window.__maigoReady === true && window.__dev && window.__dev.game.state === 'EXPLORE'", timeout=300000)
    print("held ok:", pg.evaluate("""() => { window.__held = window.__dev.maigo.active; window.__dev.maigo.active = null; return !!window.__held; }"""), flush=True)
    print("useFallback ->", pg.evaluate("""() => { try { const s = window.__dev.maigo.useFallback(); return {active: !!window.__dev.maigo.active, same: window.__dev.maigo.active === window.__held, vis: !!(window.__dev.maigo.active && window.__dev.maigo.active.root && window.__dev.maigo.active.root.visible)}; } catch(e) { return {err: String(e)} } }"""), flush=True)
    print("ready:", pg.evaluate("() => window.__dev.maigo.ready"), flush=True)
    print("logs:", logs[-6:], flush=True)
    b.close()
