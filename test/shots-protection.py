"""Browser walkthrough of the protection screens, clicking through a real protected purchase,
a fake claim and a second opinion on the local chain (after history-v3.js --full --protection).
Saves test/shots/p-*.png and fails on any page error."""
import os, re, subprocess
from playwright.sync_api import sync_playwright, expect

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots"); os.makedirs(SHOTS, exist_ok=True)
URL = "http://127.0.0.1:3000/"
admin_cookie = subprocess.check_output(["node", "-e", """
const {ethers}=require('ethers');const cfg=require('./test/.devchain.json');
(async()=>{const r=await fetch('http://127.0.0.1:3000/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'admin-nonce'})});const n=await r.json();
const sig=await new ethers.Wallet(cfg.adminKey).signMessage(n.message);
const r2=await fetch('http://127.0.0.1:3000/api/auth',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({op:'admin',nonce:n.nonce,signature:sig})});
console.log(r2.headers.get('set-cookie').split(';')[0].split('=')[1]);})()"""], cwd=os.path.dirname(HERE)).decode().strip()

errors = []
with sync_playwright() as p:
    b = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox", "--use-gl=swiftshader", "--enable-webgl"])

    def page_for(cookie=None, w=1280):
        ctx = b.new_context(viewport={"width": w, "height": 900})
        if cookie: ctx.add_cookies([{"name": "wp_session", "value": cookie, "url": URL}])
        pg = ctx.new_page()
        pg.on("pageerror", lambda e: errors.append(str(e)))
        pg.on("console", lambda m: m.type == "error" and "favicon" not in m.text and errors.append(m.text))
        return pg

    def shot(pg, name, full=True):
        pg.wait_for_timeout(600); pg.screenshot(path=f"{SHOTS}/p-{name}.png", full_page=full)

    def sign_in(pg, who):
        pg.goto(URL); expect(pg.locator(".intro, .vbtn").first).to_be_visible(timeout=30000)
        if pg.locator('#who [data-action="sign-out"]').count():
            pg.locator('#who [data-action="sign-out"]').click(); expect(pg.locator(".intro")).to_be_visible(timeout=15000)
        pg.locator('#who [data-action="open-signin"]').click()
        btn = pg.locator(f'.modal [data-demo="{who}"]') if who in ("maya", "alex", "shop", "shop2") else pg.locator(".seed-chip", has_text=who)
        btn.first.click()
        expect(pg.locator('#who [data-action="sign-out"]')).to_be_visible(timeout=20000)
        pg.wait_for_timeout(800)

    def tab(pg, tid):
        try: pg.wait_for_selector(f'[data-tab="{tid}"]', state="attached", timeout=20000)
        except Exception:
            pg.screenshot(path=f"{SHOTS}/p-fail.png"); print("STATE", pg.evaluate("JSON.stringify({v:WP.state.view,t:WP.state.tab,l:WP.state.loaded,p:!!WP.state.protection,me:WP.state.me&&WP.state.me.handle})")); raise
        pg.evaluate(f"document.querySelector('[data-tab={tid}]').click()"); pg.wait_for_timeout(500)

    def view(pg, vid):
        pg.wait_for_selector(f'[data-view="{vid}"]', state="attached", timeout=20000)
        pg.evaluate(f"document.querySelector('[data-view={vid}]').click()"); pg.wait_for_timeout(500)

    def ok_toast(pg, text, timeout=60000):
        expect(pg.locator(".toast.ok", has_text=text).last).to_be_visible(timeout=timeout)

    # 1. Landing, signed out
    pg = page_for()
    pg.goto(URL); expect(pg.locator(".intro")).to_be_visible(timeout=30000)
    expect(pg.locator(".lbadge.bond").first).to_be_visible(timeout=20000)
    shot(pg, "01-landing")
    pg.locator(".pitch").scroll_into_view_if_needed(); shot(pg, "01b-pitch", full=False)
    # Listing detail with "Why this price?"
    pg.locator(".lcard", has_text="Speedmaster").first.click()
    expect(pg.locator(".prot-quote")).to_be_visible(timeout=10000)
    pg.locator(".why-price summary").click(); shot(pg, "02-detail-why", full=False)
    pg.keyboard.press("Escape")
    pg.locator('.cat[data-cat="jewelry"]').click(); pg.wait_for_timeout(300); shot(pg, "02b-jewelry-filter", full=False)

    # 2. Jordan buys the gold chain with protection
    sign_in(pg, "Jordan")
    pg.locator('[data-action="add-money"]').first.click(); pg.locator('[data-action="fund"][data-amount="10"]').click(); ok_toast(pg, "You received $10")
    pg.wait_for_function("() => { const s = window.WP.state; const a = (s.me.address||'').toLowerCase(); return BigInt(s.balances[a]||0) >= 5n*10n**18n; }", timeout=20000)
    view(pg, "buy"); tab(pg, "shop")
    pg.locator(".lcard", has_text="Gold chain necklace").first.click()
    pg.locator('[data-action="buy"]').click()
    expect(pg.locator("#b-protect")).to_be_checked(); shot(pg, "03-buy-modal", full=False)
    pg.locator('[data-action="pay"]').click()
    ok_toast(pg, "Protected", 120000)
    tab(pg, "orders"); expect(pg.locator(".prot-status").first).to_be_visible(); shot(pg, "04-order-protected")

    # 3. Elena ships, Jordan confirms, then files a claim
    sign_in(pg, "Elena")
    view(pg, "sell"); tab(pg, "sales")
    pg.locator('.order', has_text="Gold chain").locator('[data-action="ship"]').click(); ok_toast(pg, "Marked as shipped")
    sign_in(pg, "Jordan")
    view(pg, "buy"); tab(pg, "orders")
    pg.locator('.order', has_text="Gold chain").locator('[data-action="confirm"]').first.click(); ok_toast(pg, "Done!", 120000)
    pg.wait_for_timeout(1500)
    tab(pg, "mine")
    expect(pg.locator(".prot-status", has_text="Protected for").first).to_be_visible(timeout=20000); shot(pg, "05-purchases-active")
    pg.locator('[data-action="claim-fake"]').first.click()
    pg.fill("#c-ev", "A jeweler's acid test shows it's plated brass, not 14k gold."); shot(pg, "06-claim-modal", full=False)
    pg.locator('[data-action="claim-send"]').click(); ok_toast(pg, "Claim filed")

    # 4. Second Opinion Jewelers rules it fake (Demo Pawn Shop stamped it)
    sign_in(pg, "shop2")
    tab(pg, "opinions")
    expect(pg.locator('[data-action="decide-claim"]').first).to_be_visible(timeout=10000)
    pg.locator("input[id^=rule-]").first.fill("Acid test fails for 14k. Plated. Fake."); shot(pg, "07-second-opinion")
    pg.locator('[data-action="decide-claim"][data-fake="1"]').first.click(); ok_toast(pg, "Ruled fake")
    pg.reload(); expect(pg.locator('#who [data-action="sign-out"]')).to_be_visible(timeout=20000); pg.wait_for_timeout(800)
    pg.wait_for_timeout(1500)
    tab(pg, "bond"); shot(pg, "08-shop2-bond")

    # 5. Jordan sees the refund; Demo Pawn Shop's bond took the hit
    sign_in(pg, "Jordan")
    view(pg, "buy"); tab(pg, "mine")
    expect(pg.locator(".prot-status.ok").first).to_be_visible(timeout=20000); shot(pg, "09-refunded")
    view(pg, "community"); tab(pg, "protection"); shot(pg, "10-community-protection")
    pg.locator("#pool-amt").fill("1"); pg.locator('[data-action="pool-deposit"]').click(); ok_toast(pg, "is in the pool")
    tab(pg, "people"); shot(pg, "11-members-rates")
    tab(pg, "ledger"); shot(pg, "12-ledger", full=False)
    sign_in(pg, "shop")
    view(pg, "desk"); tab(pg, "bond"); shot(pg, "13-shop-bond")
    # Seller side: Tom's rate after selling a fake
    sign_in(pg, "Tom")
    view(pg, "sell"); tab(pg, "home"); shot(pg, "14-tom-seller", full=False)
    # Add a piece: category picker and specialist list
    pg.locator('[data-action="add-item"]').first.click(); pg.locator("#cat-vintage-watches").check(force=True); shot(pg, "15-add-piece", full=False)
    pg.keyboard.press("Escape")

    # 6. Admin
    pa = page_for(admin_cookie)
    pa.goto(URL); expect(pa.locator(".vbtn", has_text="Admin")).to_be_visible(timeout=30000)
    tab(pa, "specialists"); shot(pa, "16-admin-specialists")
    tab(pa, "setup"); shot(pa, "17-admin-setup")
    tab(pa, "overview"); shot(pa, "18-admin-overview", full=False)

    # 7. Mobile landing
    pm = page_for(w=390); pm.goto(URL); expect(pm.locator(".intro")).to_be_visible(timeout=30000); shot(pm, "19-mobile")
    b.close()

print("errors:", errors)
if errors: raise SystemExit(1)
print("protection walkthrough passed")
