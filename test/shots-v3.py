"""Browser pass over every V3 screen (after test/api-v3.js has populated the local chain). Saves test/shots/v3-*.png."""
import json, os, re, subprocess, random
from playwright.sync_api import sync_playwright, expect

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots"); os.makedirs(SHOTS, exist_ok=True)
URL = "http://127.0.0.1:3000/"
EMAIL = f"joiner{random.randint(1000,9999)}@example.com"
admin_cookie = subprocess.check_output(["node", "-e", """
const {ethers}=require('ethers');const cfg=require('./test/.devchain.json');
(async()=>{const r=await fetch('http://127.0.0.1:3000/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'admin-nonce'})});const n=await r.json();
const sig=await new ethers.Wallet(cfg.adminKey).signMessage(n.message);
const r2=await fetch('http://127.0.0.1:3000/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'admin',nonce:n.nonce,signature:sig})});
console.log(r2.headers.get('set-cookie').split(';')[0].split('=')[1]);})()"""], cwd=os.path.dirname(HERE)).decode().strip()

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    def page_for(cookie=None, w=1280):
        ctx = b.new_context(viewport={"width": w, "height": 900})
        if cookie: ctx.add_cookies([{"name": "wp_session", "value": cookie, "url": URL}])
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and errors.append(m.text))
        return pg
    def shot(pg, name, full=True):
        pg.wait_for_timeout(500); pg.screenshot(path=f"{SHOTS}/v3-{name}.png", full_page=full)

    pg = page_for()
    pg.goto(URL); expect(pg.locator(".intro")).to_be_visible(timeout=30000)
    shot(pg, "01-signin")
    # invite page
    pg.goto(URL + "#invite=doesnotexist"); expect(pg.get_by_text("This invite can't be used")).to_be_visible(timeout=15000)
    # demo sign in as Maya
    pg.goto(URL); expect(pg.locator(".intro")).to_be_visible(timeout=30000); pg.locator('#who [data-action="open-signin"]').click(); pg.locator('[data-demo="maya"]').click()
    expect(pg.locator(".vbtn", has_text="Sell")).to_be_visible(timeout=20000); shot(pg, "03-maya-buy")
    pg.locator(".vbtn", has_text="Sell").click(); pg.wait_for_timeout(300); shot(pg, "02-maya-sell")
    pg.locator(".vbtn", has_text="Community").click(); expect(pg.get_by_role("heading", name="Community ledger")).to_be_visible(); shot(pg, "04-ledger")
    pg.get_by_role("tab", name=re.compile("^Members")).click(); shot(pg, "05-members")
    pg.get_by_role("tab", name=re.compile("^Disputes")).click(); shot(pg, "06-disputes")
    pg.get_by_role("tab", name=re.compile("^Invites")).click(); shot(pg, "07-invites")
    shot(pg, "07a-maya-no-invites-left")
    pg.get_by_role("button", name="Sign out").click(); expect(pg.locator(".intro")).to_be_visible(timeout=15000)
    pg.locator('#who [data-action="open-signin"]').click(); pg.locator(".seed-chip").nth(3).click(); expect(pg.locator(".vbtn", has_text="Community")).to_be_visible(timeout=20000)
    pg.locator(".vbtn", has_text="Community").click(); pg.get_by_role("tab", name=re.compile("^Invites")).click()
    pg.get_by_role("button", name="+ New invite link").click(); expect(pg.locator(".toast.ok")).to_be_visible(timeout=10000)
    pg.wait_for_timeout(800); shot(pg, "07b-invite-created")
    code = re.search(r"#invite=([A-Za-z0-9_-]+)", pg.locator(".mono-inline").first.inner_text()).group(1)
    pg.get_by_role("button", name="Sign out").click(); expect(pg.locator(".intro")).to_be_visible(timeout=15000)
    # join through the invite in the browser
    pg.goto(URL + "#invite=" + code); expect(pg.get_by_text(re.compile("invited you to Wardrobe Passport"))).to_be_visible(timeout=15000); shot(pg, "08-join")
    pg.fill("#j-name", "Browser Joiner"); pg.fill("#j-email", EMAIL); pg.get_by_role("button", name="Join the community").click()
    expect(pg.locator(".p-name", has_text="Browser Joiner")).to_be_visible(timeout=60000); shot(pg, "09-new-member-sell")
    pg.get_by_role("button", name="Sign out").click()
    # email code sign-in
    pg.locator('#who [data-action="open-signin"]').click(); pg.fill("#si-email", EMAIL); pg.locator('[data-action="send-code"]').click()
    expect(pg.locator("#si-code")).to_be_visible(); shot(pg, "10-code"); pg.locator('[data-action="verify-code"]').click()
    expect(pg.locator(".p-name", has_text="Browser Joiner")).to_be_visible(timeout=15000)
    # shop desk
    pg2 = page_for(); pg2.goto(URL); expect(pg2.locator(".intro")).to_be_visible(timeout=30000); pg2.locator('#who [data-action="open-signin"]').click(); pg2.locator('[data-demo="shop"]').click()
    expect(pg2.get_by_role("heading", name=re.compile("Demo Pawn Shop"))).to_be_visible(timeout=20000); shot(pg2, "11-shop-front-desk")
    pg2.locator('[data-action="fd-check"]').first.click(); pg2.wait_for_timeout(300); shot(pg2, "12-check-id", full=False)
    pg2.check("#cid-ok"); pg2.get_by_role("button", name="Record the ID check on Arc").click(); expect(pg2.locator(".toast.ok", has_text="verified member")).to_be_visible(timeout=20000)
    pg2.get_by_role("tab", name=re.compile("^Disputes")).click(); shot(pg2, "13-shop-disputes")
    pg2.get_by_role("tab", name=re.compile("^Record")).click(); shot(pg2, "14-shop-record")
    # admin
    pa = page_for(admin_cookie); pa.goto(URL); expect(pa.get_by_role("heading", name="Admin overview")).to_be_visible(timeout=20000); shot(pa, "15-admin-overview")
    pa.get_by_role("tab", name=re.compile("^Side by side")).click(); shot(pa, "16-admin-side")
    pa.get_by_role("tab", name=re.compile("^Members")).click(); shot(pa, "17-admin-members")
    pa.get_by_role("tab", name=re.compile("^Setup")).click(); shot(pa, "18-admin-setup")
    pa.get_by_role("tab", name=re.compile("^Members")).click(); pa.locator('[data-action="view-as"]').first.click()
    expect(pa.locator(".asbanner")).to_be_visible(); shot(pa, "19-admin-view-as")
    # mobile
    pm = page_for(admin_cookie, 390); pm.goto(URL); pm.wait_for_timeout(3000); pm.get_by_role("tab", name=re.compile("^Side by side")).click(); shot(pm, "20-mobile-side")
    b.close()
print("errors:", errors[:10])
print("done")
