"""Renders the studio pictures of the demo pieces (web/public/seed/*.jpg) from the 3D models
in web/public/models3d.js. Run: python test/render-pieces.py"""
import base64, os, shutil, subprocess, sys, time
from playwright.sync_api import sync_playwright
HERE = os.path.dirname(os.path.abspath(__file__)); PUB = os.path.join(HERE, "..", "web", "public")
shutil.copy(os.path.join(HERE, "render-pieces.html"), os.path.join(PUB, "_render.html"))
srv = subprocess.Popen([sys.executable, "-m", "http.server", "3111", "--bind", "127.0.0.1"], cwd=PUB, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
time.sleep(1.5)
try:
    with sync_playwright() as p:
        b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl", "--ignore-gpu-blocklist"])
        pg = b.new_page(viewport={"width": 1000, "height": 1000})
        errs = []; pg.on("pageerror", lambda e: errs.append(str(e))); pg.on("console", lambda m: m.type == "error" and errs.append(m.text))
        pg.goto("http://127.0.0.1:3111/_render.html"); pg.wait_for_function("window.ready === true", timeout=60000)
        import sys as _s
        only = _s.argv[1:]
        for f in pg.evaluate("window.pieceFiles"):
            if only and f not in only: continue
            data = pg.evaluate("f => window.renderPiece(f)", f)
            raw = base64.b64decode(data.split(",")[1])
            open(os.path.join(PUB, "seed", f), "wb").write(raw)
            print(f, len(raw) // 1024, "KB")
        print("errors:", errs)
        b.close()
finally:
    srv.terminate()
    os.remove(os.path.join(PUB, "_render.html"))
