"""End-to-end test of the full stack (Next.js API + contract V2) against a local test chain.

Start first: `npm run devchain` (repo root), then the web app with
WALLET_PROVIDER=local, ARC_RPC_URL=http://127.0.0.1:8545 and CONTRACT_ADDRESS from test/.devchain.json.

Runs the demo stories in a real browser:
  0. Sign-in page with three roles: seller, buyer, authenticator.
  1. The admin approves the pawn shop as an authenticator.
  2. Maya (seller) adds a watch with a photo. It cannot be listed yet. She asks
     the pawn shop to authenticate it; the shop declines once, then stamps it.
  3. Maya lists it (deposit locked); Alex (buyer) pays; Maya ships; Alex disputes;
     the pawn shop decides for the buyer (refund, seller loses deposit).
  4. Maya lists again; Alex pays; Maya ships; Alex confirms (seller paid,
     authenticator fee, passport moves).
  5. Public passport page, track records, role dashboards.
Saves screenshots to test/shots/.
"""
import json, os, re, sys, urllib.request
from playwright.sync_api import sync_playwright, expect

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")
os.makedirs(SHOTS, exist_ok=True)
cfg = json.load(open(os.path.join(HERE, ".devchain.json")))
RPC = "http://127.0.0.1:8545"
URL = "http://127.0.0.1:3000/"


def rpc(method, params):
    req = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))["result"]


def fund(addr, dollars):
    rpc("eth_sendTransaction", [{"from": cfg["funder"], "to": addr, "value": hex(dollars * 10**18)}])


def balance(addr):
    return int(rpc("eth_getBalance", [addr, "latest"]), 16) / 10**18


def near(a, b, tol=0.02):
    return abs(a - b) <= tol


errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))

    def who(role):
        """Sign out if needed, then sign in as seller (Maya), buyer (Alex) or auth (pawn shop)."""
        if page.get_by_role("button", name="Sign out").count():
            page.get_by_role("button", name="Sign out").click()
        page.locator(f'[data-role="{role}"]').click()

    def tab(name):
        page.get_by_role("tab", name=re.compile("^" + name)).click()

    def ok_toast(text):
        expect(page.locator(".toast.ok", has_text=text)).to_be_visible(timeout=20000)

    def clear_toasts():
        page.evaluate("document.querySelectorAll('#toast-root .toast').forEach(t => t.remove())")

    def shot(name, full=False):
        page.wait_for_timeout(350)
        page.screenshot(path=f"{SHOTS}/{name}.png", full_page=full)

    page.goto(URL)
    # 0. Sign-in page
    expect(page.get_by_role("heading", name="Sign in")).to_be_visible(timeout=20000)
    expect(page.locator(".role-card")).to_have_count(3)
    expect(page.locator("#hero")).to_contain_text("Seller asks for authentication")
    shot("00-sign-in")
    addrs = page.evaluate("window.WP.addresses()")
    fund(addrs["maya"], 20); fund(addrs["alex"], 60)
    session = json.load(urllib.request.urlopen("http://127.0.0.1:3000/api/session"))
    treasury = next(u["address"] for u in session["users"] if u["handle"] == "treasury")
    fund(treasury, 50)
    page.evaluate("window.WP.refresh()")
    API = "http://127.0.0.1:3000/api/tx"

    def post(body):
        req = urllib.request.Request(API, data=json.dumps(body).encode(), headers={"content-type": "application/json"})
        try:
            return 200, json.load(urllib.request.urlopen(req))
        except urllib.error.HTTPError as e:
            return e.code, json.load(e)

    # Demo money from the treasury wallet, through the API
    who("auth")
    expect(page.locator("#who")).to_contain_text("Authenticator")
    page.get_by_role("button", name="+ Add money").click()
    expect(page.locator(".modal")).to_contain_text("The demo treasury holds $50.00")
    page.get_by_role("button", name="Get $5").click()
    ok_toast("Pawn shop received $5")
    expect(page.locator(".persona.active .p-bal")).to_have_text("$5.00")
    print("✓ Sign-in page shows three roles; the treasury wallet funds an account")

    # 1. Authenticator approval (in the live app this is a MetaMask click by the deployer)
    expect(page.locator("#view")).to_contain_text("isn't an approved authenticator yet")
    shot("01-authenticator-not-approved")
    page.evaluate("""async ([rpc, addr, shop]) => {
        const p = new ethers.JsonRpcProvider(rpc);
        const c = new ethers.Contract(addr, window.WP_ABI, await p.getSigner(0));
        await (await c.addPartner(shop, 'Demo Pawn Shop', 'Atlanta')).wait();
        await window.WP.refresh();
    }""", [RPC, session["config"]["contractAddress"], addrs["shop"]])
    expect(page.get_by_role("heading", name="Demo Pawn Shop · Atlanta")).to_be_visible()
    expect(page.locator("#view")).to_contain_text("Nothing waiting")
    print("✓ pawn shop approved; authenticator desk opens with nothing to verify")

    # 2. Seller: add a piece, ask for authentication
    who("seller")
    expect(page.get_by_role("heading", name="Welcome back, Maya")).to_be_visible()
    expect(page.locator("#view")).to_contain_text("Start with your first piece")
    shot("02-seller-dashboard-empty")
    page.get_by_role("button", name="+ Add a piece").click()
    page.fill("#f-name", "Steel dive watch")
    page.fill("#f-brand", "Seiko")
    page.fill("#f-details", "Serial 87654734")
    page.set_input_files("#f-photo", os.path.join(HERE, "sample-photo.jpg"))
    expect(page.locator("#f-prev img")).to_be_visible()
    page.locator("#f-sell").uncheck()
    page.get_by_role("button", name="Create passport").click()
    ok_toast("now has its passport")
    row = page.locator(".done", has_text="Steel dive watch")
    expect(row).to_contain_text("Ask an authenticator to verify it")
    tab("My pieces")
    card = page.locator(".card", has_text="Steel dive watch")
    expect(card).to_contain_text("Needs authentication")
    src = card.locator("img").get_attribute("src")
    assert re.match(r"^/api/photo/[0-9a-f]{64}$", src), src
    photo = urllib.request.urlopen("http://127.0.0.1:3000" + src)
    data = photo.read()
    import hashlib
    assert photo.headers["content-type"] == "image/jpeg" and hashlib.sha256(data).hexdigest() == src.rsplit("/", 1)[1], "photo must match its on-chain fingerprint"

    # The server refuses to list an unauthenticated piece, whatever the screen shows
    code, res = post({"as": "maya", "action": "list", "id": 1, "price": "40"})
    assert code == 400 and "needs to be authenticated" in res["error"], (code, res)
    # ...and refuses a stamp nobody asked for
    code, res = post({"as": "shop", "action": "authenticate", "id": 1, "note": "x"})
    assert code == 400 and "hasn't asked you" in res["error"], (code, res)

    clear_toasts()
    card.click()
    expect(page.locator(".modal")).to_contain_text("Step 1: get it authenticated")
    expect(page.locator("#list-price")).to_have_count(0)
    shot("03-request-authentication")
    page.get_by_role("button", name="Request authentication").click()
    ok_toast("Request sent")
    expect(page.locator(".modal")).to_contain_text("Waiting for Demo Pawn Shop")
    page.keyboard.press("Escape")
    expect(card).to_contain_text("Waiting for Demo Pawn Shop")
    print("✓ Seller created a passport (photo fingerprint matches); listing is blocked until authentication; request sent")

    # Authenticator declines once, seller asks again, authenticator stamps it
    who("auth")
    expect(page.locator(".tab.active .count")).to_have_text("1")
    req = page.locator(".order", has_text="Steel dive watch")
    expect(req).to_contain_text("Maya asked on")
    shot("04-authenticator-requests")
    req.get_by_role("button", name="Can't verify").click()
    page.fill("#x-note", "Please bring the box and papers.")
    page.get_by_role("button", name="Send to the owner").click()
    ok_toast("couldn't be verified")
    expect(page.locator("#view")).to_contain_text("Nothing waiting")
    who("seller"); tab("My pieces"); clear_toasts()
    expect(card).to_contain_text("Not verified")
    card.click()
    expect(page.locator(".modal")).to_contain_text("Please bring the box and papers.")
    page.get_by_role("button", name="Request authentication").click()
    ok_toast("Request sent"); page.keyboard.press("Escape")
    who("auth"); clear_toasts()
    page.locator(".order", has_text="Steel dive watch").get_by_role("button", name="Authenticate").click()
    expect(page.locator(".modal")).to_contain_text("inspected in person")
    page.get_by_role("button", name="Stamp passport as authenticated").click()
    ok_toast("is now authenticated by your shop")
    expect(page.locator("#view")).to_contain_text("Nothing waiting")
    tab("My record")
    expect(page.locator(".card", has_text="Steel dive watch")).to_contain_text("✓ Verified")
    expect(page.locator(".tile", has_text="pieces authenticated")).to_contain_text("1")
    print("✓ Authenticator declined with a reason, the seller asked again, the authenticator stamped the passport on-chain")

    # 3. Dispute story
    who("seller"); clear_toasts()
    expect(page.locator(".done", has_text="Steel dive watch")).to_contain_text("Verified. Set a price and list it")
    shot("05-seller-dashboard")
    page.locator(".done", has_text="Steel dive watch").click()
    expect(page.locator(".modal")).to_contain_text("Authenticated in person by Demo Pawn Shop, Atlanta")
    page.fill("#list-price", "40")
    expect(page.locator("[data-deposit-hint]")).to_contain_text("$4.00 deposit")
    expect(page.locator("[data-deposit-hint]")).to_contain_text("you receive $38.80")
    shot("06-list-with-deposit")
    page.get_by_role("button", name="List for sale").click()
    ok_toast("is now for sale")
    page.keyboard.press("Escape")
    assert near(balance(addrs["maya"]), 16.0), balance(addrs["maya"])
    print("✓ Seller listed for $40 and locked a $4 deposit")

    who("buyer")
    expect(page.get_by_role("heading", name="Marketplace")).to_be_visible()
    card = page.locator(".card", has_text="Steel dive watch")
    expect(card).to_contain_text("$40.00"); expect(card).to_contain_text("✓ Verified")
    shot("07-marketplace")
    card.click()
    page.get_by_role("button", name="Buy for $40.00").click()
    expect(page.locator(".modal")).to_contain_text("Demo Pawn Shop settles any dispute")
    shot("08-buy")
    page.get_by_role("button", name="Pay $40.00").click()
    ok_toast("Paid!")
    expect(page.locator(".order", has_text="Steel dive watch")).to_contain_text("waiting for Maya to ship")
    expect(page.get_by_role("button", name="Something's wrong")).to_have_count(0)

    who("seller"); tab("Sales")
    expect(page.locator(".order")).to_contain_text("Alex paid $40.00")
    shot("09-seller-ship")
    page.get_by_role("button", name="Mark as shipped").click()
    ok_toast("Marked as shipped")
    expect(page.locator(".order")).to_contain_text("you can collect from")
    expect(page.get_by_role("button", name="Collect payment")).to_have_count(0)

    who("buyer"); tab("My orders")
    expect(page.locator(".order")).to_contain_text("Confirm or open a dispute by")
    shot("10-buyer-confirm-or-dispute")
    page.get_by_role("button", name="Something's wrong").click()
    page.get_by_label("I don't think it's genuine").check()
    page.fill("#d-note", "Dial looks wrong")
    page.get_by_role("button", name="Open dispute").click()
    ok_toast("Dispute opened")
    expect(page.locator(".order")).to_contain_text("Dispute open")

    alex_before, maya_before, shop_before = balance(addrs["alex"]), balance(addrs["maya"]), balance(addrs["shop"])
    who("auth"); tab("Disputes")
    expect(page.locator(".order")).to_contain_text("I don't think it's genuine: Dial looks wrong")
    expect(page.locator(".order")).to_contain_text("You authenticated it on")
    shot("11-authenticator-dispute")
    page.get_by_role("button", name="Buyer is right: refund $40.00").click()
    ok_toast("Settled for the buyer")
    assert near(balance(addrs["alex"]) - alex_before, 42.8), balance(addrs["alex"]) - alex_before
    assert near(balance(addrs["maya"]) - maya_before, 0), "seller must not get the deposit back"
    assert near(balance(addrs["shop"]) - shop_before, 1.2), balance(addrs["shop"]) - shop_before
    who("seller")
    expect(page.locator(".section-head")).to_contain_text("1 dispute lost")
    print("✓ Dispute: the authenticator decided for the buyer; Alex got $40 + $2.80, shop $1.20, Maya lost her $4 deposit")

    # 4. Happy path (still verified: it never changed hands)
    clear_toasts()
    page.locator(".done", has_text="Steel dive watch").click()
    page.fill("#list-price", "40")
    page.get_by_role("button", name="List for sale").click()
    ok_toast("is now for sale"); page.keyboard.press("Escape")
    who("buyer")
    expect(page.locator(".card", has_text="Steel dive watch")).to_contain_text("Maya · 0 sold")
    page.locator(".card", has_text="Steel dive watch").click()
    expect(page.locator(".modal")).to_contain_text("1 dispute lost")
    page.get_by_role("button", name="Buy for $40.00").click()
    page.get_by_role("button", name="Pay $40.00").click()
    ok_toast("Paid!")
    who("seller"); tab("Sales")
    page.get_by_role("button", name="Mark as shipped").click()
    ok_toast("Marked as shipped")
    maya_before, shop_before = balance(addrs["maya"]), balance(addrs["shop"])
    who("buyer"); tab("My orders")
    page.get_by_role("button", name="I received it").click()
    ok_toast("Done!")
    expect(page.get_by_role("heading", name="My purchases")).to_be_visible()
    assert near(balance(addrs["maya"]) - maya_before, 42.8), balance(addrs["maya"]) - maya_before
    assert near(balance(addrs["shop"]) - shop_before, 1.2), balance(addrs["shop"]) - shop_before
    shot("12-buyer-purchases")
    print("✓ Sale: pay → ship → confirm; Maya got $38.80 + her $4 deposit, shop $1.20, passport moved to Alex")

    # 5. Public passport, records, dashboards
    clear_toasts()
    page.locator(".card", has_text="Steel dive watch").click()
    expect(page.locator(".modal")).to_contain_text("This piece is yours")
    expect(page.locator(".modal")).to_contain_text("before it last changed hands")
    page.get_by_role("button", name="Share passport").click()
    cert = page.locator(".cert")
    expect(cert).to_contain_text("Digital product passport")
    expect(page.locator(".pp .timeline")).to_contain_text("Maya → Alex for $40.00")
    expect(page.locator(".pp .timeline")).to_contain_text("Authenticated by Demo Pawn Shop")
    expect(page.locator(".cert-qr svg")).to_be_visible()
    expect(cert).to_contain_text("Photo fingerprint (SHA-256)")
    expect(cert).not_to_contain_text("Invalid Date")
    expect(cert).to_contain_text("0 sold · 1 bought · 0 refunds · 0 disputes lost")
    shot("13-public-passport", full=True)
    page.get_by_role("button", name="← Back to the app").click()
    tab("My orders")
    expect(page.locator(".done", has_text="Bought Steel dive watch")).to_contain_text("−$40.00")
    who("seller")
    expect(page.locator(".tile", has_text="earned from sales")).to_contain_text("$38.80")
    tab("Sales")
    expect(page.locator(".done", has_text="Sold Steel dive watch")).to_contain_text("+$40.00")
    expect(page.locator(".section-head")).to_contain_text("1 sold · 0 bought · 0 refunds · 1 dispute lost")
    shot("14-seller-sales")
    who("auth"); tab("My record")
    expect(page.locator(".tile", has_text="disputes settled")).to_contain_text("1")
    shot("15-authenticator-record", full=True)
    page.get_by_role("button", name="Sign out").click()
    expect(page.locator(".stat", has_text="paid out in 1 sale")).to_contain_text("$40.00")
    expect(page.locator(".stat", has_text="held right now")).to_contain_text("$0.00")
    shot("16-sign-in-after", full=True)
    print("✓ Public passport, track records and each role's dashboard are right")

    # Quick-fill sample with a request in one step
    who("seller")
    page.get_by_role("button", name="+ Add a piece").click()
    page.get_by_role("button", name="Leather tote").click()
    page.get_by_role("button", name="Create passport").click()
    ok_toast("Request sent")
    tab("My pieces")
    expect(page.locator(".card", has_text="Leather tote")).to_contain_text("Waiting for Demo Pawn Shop")
    print("✓ Quick-fill sample creates a passport and asks for authentication in one step")

    acts = json.load(urllib.request.urlopen("http://127.0.0.1:3000/api/activity"))["activity"]
    kinds = {a["action"] for a in acts}
    assert {"createPassport", "authenticate", "list", "buy", "ship", "dispute", "resolve", "confirm", "fund"} <= kinds, kinds
    print(f"✓ Activity log in Postgres has {len(acts)} entries covering every on-chain action")

    # Mobile
    page.set_viewport_size({"width": 390, "height": 844})
    clear_toasts()
    shot("17-mobile-seller", full=True)
    page.get_by_role("button", name="Sign out").click()
    shot("18-mobile-sign-in", full=True)

    browser.close()

real_errors = [e for e in errors if "fonts.googleapis" not in e and "net::ERR" not in e and "status of 400" not in e]
if real_errors:
    print("Page errors:", *real_errors, sep="\n  ")
    sys.exit(1)
print("\nAll end-to-end checks passed.")
