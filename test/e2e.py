"""End-to-end test of the full stack (Next.js API + contract V2) against a local test chain.

Start first: `npm run devchain` (repo root), then the web app with
WALLET_PROVIDER=local, ARC_RPC_URL=http://127.0.0.1:8545 and CONTRACT_ADDRESS from test/.devchain.json.

Runs the demo stories in a real browser:
  1. The admin approves the pawn shop as a partner.
  2. Maya adds a watch with a photo; the pawn shop authenticates it.
  3. Maya lists it (deposit locked); Alex pays; Maya ships; Alex disputes;
     the pawn shop decides for the buyer (refund, seller loses deposit).
  4. Maya lists again; Alex pays; Maya ships; Alex confirms (seller paid,
     partner fee, passport moves).
  5. Public passport page, track records, quick-fill sample.
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

    def who(pid):
        page.locator(f'[data-persona="{pid}"]').click()

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
    expect(page.get_by_role("heading", name="Maya's wardrobe")).to_be_visible(timeout=20000)
    addrs = page.evaluate("window.WP.addresses()")
    fund(addrs["maya"], 20); fund(addrs["alex"], 60)
    session = json.load(urllib.request.urlopen("http://127.0.0.1:3000/api/session"))
    treasury = next(u["address"] for u in session["users"] if u["handle"] == "treasury")
    fund(treasury, 50)
    page.evaluate("window.WP.refresh()")
    expect(page.locator(".persona.active .p-bal")).to_have_text("$20.00")

    # Demo money from the treasury wallet, through the API
    who("shop")
    page.get_by_role("button", name="+ Add money").click()
    expect(page.locator(".modal")).to_contain_text("The demo treasury holds $50.00")
    page.get_by_role("button", name="Get $5").click()
    ok_toast("Pawn shop received $5")
    expect(page.locator(".persona.active .p-bal")).to_have_text("$5.00")
    who("maya")
    print("✓ API serves the session and state; the treasury wallet funds a demo person")

    # 1. Partner approval (in the live app this is a MetaMask click by the deployer)
    expect(page.locator(".tip")).to_contain_text("isn't an approved partner yet")
    who("shop")
    expect(page.locator("#view")).to_contain_text("isn't an approved partner yet")
    shot("01-partner-not-approved")
    page.evaluate("""async ([rpc, addr, shop]) => {
        const p = new ethers.JsonRpcProvider(rpc);
        const c = new ethers.Contract(addr, window.WP_ABI, await p.getSigner(0));
        await (await c.addPartner(shop, 'Demo Pawn Shop', 'Atlanta')).wait();
        await window.WP.refresh();
    }""", [RPC, session["config"]["contractAddress"], addrs["shop"]])
    expect(page.get_by_role("heading", name="Demo Pawn Shop · Atlanta")).to_be_visible()
    print("✓ pawn shop approved as a partner; partner desk opens")

    # 2. Maya adds a watch with a photo; the shop authenticates it
    who("maya")
    page.get_by_role("button", name="+ Add a piece").click()
    page.fill("#f-name", "Steel dive watch")
    page.fill("#f-brand", "Rolex")
    page.fill("#f-details", "Serial 87654734")
    page.set_input_files("#f-photo", os.path.join(HERE, "sample-photo.jpg"))
    expect(page.locator("#f-prev img")).to_be_visible()
    page.get_by_role("button", name="Add to wardrobe").click()
    ok_toast("is in your wardrobe")
    expect(page.locator(".card", has_text="Steel dive watch")).to_contain_text("In wardrobe")
    src = page.locator(".card", has_text="Steel dive watch").locator("img").get_attribute("src")
    assert re.match(r"^/api/photo/[0-9a-f]{64}$", src), src
    photo = urllib.request.urlopen("http://127.0.0.1:3000" + src)
    body = photo.read()
    import hashlib
    assert photo.headers["content-type"] == "image/jpeg" and hashlib.sha256(body).hexdigest() == src.rsplit("/", 1)[1], "photo must match its on-chain fingerprint"

    who("shop")
    expect(page.locator(".done.static", has_text="Steel dive watch")).to_be_visible()
    shot("02-partner-desk")
    page.locator(".done.static", has_text="Steel dive watch").get_by_role("button", name="Authenticate").click()
    expect(page.locator(".modal")).to_contain_text("inspected in person")
    page.get_by_role("button", name="Stamp passport as authenticated").click()
    ok_toast("is now authenticated by your shop")
    expect(page.locator(".card", has_text="Steel dive watch")).to_contain_text("✓ Authenticated")
    print("✓ Maya created a passport; the photo is in the database and its SHA-256 on-chain matches; the shop authenticated it")

    # 3. Dispute story
    who("maya")
    page.locator(".card", has_text="Steel dive watch").click()
    expect(page.locator(".modal")).to_contain_text("Authenticated in person by Demo Pawn Shop, Atlanta")
    page.fill("#list-price", "40")
    expect(page.locator("[data-deposit-hint]")).to_contain_text("$4.00 deposit")
    expect(page.locator("[data-deposit-hint]")).to_contain_text("you receive $38.80")
    shot("03-list-with-deposit")
    page.get_by_role("button", name="List for sale").click()
    ok_toast("is now for sale")
    page.keyboard.press("Escape")
    assert near(balance(addrs["maya"]), 16.0), balance(addrs["maya"])
    print("✓ Maya listed for $40 and locked a $4 deposit")

    who("alex"); tab("Shop")
    card = page.locator(".card", has_text="Steel dive watch")
    expect(card).to_contain_text("$40.00"); expect(card).to_contain_text("✓ Authenticated")
    shot("04-shop")
    card.click()
    page.get_by_role("button", name="Buy for $40.00").click()
    expect(page.locator(".modal")).to_contain_text("Demo Pawn Shop settles any dispute")
    shot("05-buy")
    page.get_by_role("button", name="Pay $40.00").click()
    ok_toast("Paid!")
    expect(page.locator(".order", has_text="Steel dive watch")).to_contain_text("waiting for Maya to ship")
    expect(page.get_by_role("button", name="Something's wrong")).to_have_count(0)

    who("maya"); tab("Orders")
    expect(page.locator(".order")).to_contain_text("Alex paid $40.00")
    shot("06-seller-ship")
    page.get_by_role("button", name="Mark as shipped").click()
    ok_toast("Marked as shipped")
    expect(page.locator(".order")).to_contain_text("you can collect from")
    expect(page.get_by_role("button", name="Collect payment")).to_have_count(0)

    who("alex"); tab("Orders")
    expect(page.locator(".order")).to_contain_text("Confirm or open a dispute by")
    shot("07-buyer-confirm-or-dispute")
    page.get_by_role("button", name="Something's wrong").click()
    page.get_by_label("I don't think it's genuine").check()
    page.fill("#d-note", "Dial looks wrong")
    page.get_by_role("button", name="Open dispute").click()
    ok_toast("Dispute opened")
    expect(page.locator(".order")).to_contain_text("Dispute open")

    alex_before, maya_before, shop_before = balance(addrs["alex"]), balance(addrs["maya"]), balance(addrs["shop"])
    who("shop")
    expect(page.locator(".order")).to_contain_text("I don't think it's genuine: Dial looks wrong")
    shot("08-partner-dispute")
    page.get_by_role("button", name="Buyer is right: refund $40.00").click()
    ok_toast("Settled for the buyer")
    assert near(balance(addrs["alex"]) - alex_before, 42.8), balance(addrs["alex"]) - alex_before
    assert near(balance(addrs["maya"]) - maya_before, 0), "seller must not get the deposit back"
    assert near(balance(addrs["shop"]) - shop_before, 1.2), balance(addrs["shop"]) - shop_before
    who("maya"); tab("My wardrobe")
    expect(page.locator(".section-head")).to_contain_text("1 dispute lost")
    expect(page.locator(".card", has_text="Steel dive watch")).to_contain_text("In wardrobe")
    print("✓ Dispute: partner decided for the buyer; Alex got $40 + $2.80, shop $1.20, Maya lost her $4 deposit; record shows it")

    # 4. Happy path
    clear_toasts()
    page.locator(".card", has_text="Steel dive watch").click()
    page.fill("#list-price", "40")
    page.get_by_role("button", name="List for sale").click()
    ok_toast("is now for sale"); page.keyboard.press("Escape")
    who("alex"); tab("Shop")
    expect(page.locator(".card", has_text="Steel dive watch")).to_contain_text("Maya · 0 sold")
    page.locator(".card", has_text="Steel dive watch").click()
    expect(page.locator(".modal")).to_contain_text("1 dispute lost")
    page.get_by_role("button", name="Buy for $40.00").click()
    page.get_by_role("button", name="Pay $40.00").click()
    ok_toast("Paid!")
    who("maya"); tab("Orders")
    page.get_by_role("button", name="Mark as shipped").click()
    ok_toast("Marked as shipped")
    maya_before, shop_before = balance(addrs["maya"]), balance(addrs["shop"])
    who("alex"); tab("Orders")
    page.get_by_role("button", name="I received it").click()
    ok_toast("Done!")
    expect(page.get_by_role("heading", name="Alex's wardrobe")).to_be_visible()
    assert near(balance(addrs["maya"]) - maya_before, 42.8), balance(addrs["maya"]) - maya_before
    assert near(balance(addrs["shop"]) - shop_before, 1.2), balance(addrs["shop"]) - shop_before
    expect(page.locator(".stat", has_text="paid out in 1 sale")).to_contain_text("$40.00")
    expect(page.locator(".stat", has_text="held right now")).to_contain_text("$0.00")
    shot("09-after-sale")
    print("✓ Sale: pay → ship → confirm; Maya got $38.80 + her $4 deposit, shop $1.20, passport moved to Alex")

    # 5. Public passport, records, orders history
    clear_toasts()
    page.locator(".card", has_text="Steel dive watch").click()
    page.get_by_role("button", name="Share passport").click()
    cert = page.locator(".cert")
    expect(cert).to_contain_text("Digital product passport")
    expect(cert).to_contain_text("Authenticated in person by Demo Pawn Shop, Atlanta")
    expect(page.locator(".pp .timeline")).to_contain_text("Maya → Alex for $40.00")
    expect(page.locator(".pp .timeline")).to_contain_text("Authenticated by Demo Pawn Shop")
    expect(page.locator(".cert-qr svg")).to_be_visible()
    expect(cert).to_contain_text("Photo fingerprint (SHA-256)")
    expect(cert).not_to_contain_text("Invalid Date")
    expect(cert).to_contain_text("0 sold · 1 bought · 0 refunds · 0 disputes lost")
    expect(page.locator(".pp .timeline")).not_to_contain_text("Invalid Date")
    shot("10-public-passport", full=True)
    page.get_by_role("button", name="← Back to the app").click()
    tab("Orders")
    expect(page.locator(".done", has_text="Bought Steel dive watch")).to_contain_text("−$40.00")
    who("maya")
    expect(page.locator(".done", has_text="Sold Steel dive watch")).to_contain_text("+$40.00")
    expect(page.locator(".section-head")).to_contain_text("1 sold · 0 bought · 0 refunds · 1 dispute lost")
    shot("11-maya-orders")
    print("✓ Public passport shows the authentication stamp and history; track records and order history are right")

    # Quick-fill sample listed by Alex; its public page leads to buying
    who("alex"); tab("My wardrobe")
    page.get_by_role("button", name="+ Add a piece").click()
    page.get_by_role("button", name="Leather tote").click()
    expect(page.locator("#f-price")).to_have_value("6")
    expect(page.locator("[data-deposit-hint]")).to_contain_text("$0.60 deposit")
    page.get_by_role("button", name="Add to wardrobe").click()
    ok_toast("is now for sale")
    who("maya")
    page.goto(URL + "#passport=2")
    expect(page.locator(".pp-cta")).to_contain_text("protected by Demo Pawn Shop")
    expect(page.locator(".cert")).to_contain_text("Not yet authenticated")
    page.get_by_role("button", name="Buy it in the app").click()
    expect(page.get_by_role("button", name="Pay $6.00")).to_be_visible()
    page.keyboard.press("Escape")
    print("✓ Quick-fill sample lists with a deposit; a listed item's public page links to buying")

    acts = json.load(urllib.request.urlopen("http://127.0.0.1:3000/api/activity"))["activity"]
    kinds = {a["action"] for a in acts}
    assert {"createPassport", "authenticate", "list", "buy", "ship", "dispute", "resolve", "confirm", "fund"} <= kinds, kinds
    print(f"✓ Activity log in Postgres has {len(acts)} entries covering every action")

    # Mobile
    page.set_viewport_size({"width": 390, "height": 844})
    clear_toasts()
    shot("12-mobile-shop")
    who("shop")
    shot("13-mobile-desk", full=True)

    browser.close()

real_errors = [e for e in errors if "fonts.googleapis" not in e and "net::ERR" not in e]
if real_errors:
    print("Page errors:", *real_errors, sep="\n  ")
    sys.exit(1)
print("\nAll end-to-end checks passed.")
