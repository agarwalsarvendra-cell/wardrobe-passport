"""End-to-end test of the app against the local test chain.

Runs the full demo story in a real browser: Maya adds a blazer with a photo
and lists it, Alex buys it (money held), Maya sees it's paid, Alex confirms
delivery, money and passport move; then the public passport page, order
history and resale. Saves screenshots to test/shots/.
"""
import json, os, re, sys, time, urllib.request
from playwright.sync_api import sync_playwright, expect

HERE = os.path.dirname(os.path.abspath(__file__))
SHOTS = os.path.join(HERE, "shots")
os.makedirs(SHOTS, exist_ok=True)
cfg = json.load(open(os.path.join(HERE, ".devchain.json")))
RPC = "http://127.0.0.1:8545"
URL = f"http://127.0.0.1:8080/index.html?dev=1&rpc={RPC}&contract={cfg['address']}"


def rpc(method, params):
    req = urllib.request.Request(RPC, data=json.dumps({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}).encode(),
                                 headers={"content-type": "application/json"})
    return json.load(urllib.request.urlopen(req))["result"]


def fund(addr, dollars):
    rpc("eth_sendTransaction", [{"from": cfg["funder"], "to": addr, "value": hex(dollars * 10**18)}])


def balance(addr):
    return int(rpc("eth_getBalance", [addr, "latest"]), 16) / 10**18


errors = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path="/usr/bin/google-chrome", args=["--no-sandbox"])
    page = browser.new_page(viewport={"width": 1280, "height": 860})
    page.on("pageerror", lambda e: errors.append(str(e)))
    page.on("console", lambda m: m.type == "error" and errors.append(m.text))

    page.goto(URL)
    expect(page.get_by_role("heading", name="Maya's wardrobe")).to_be_visible(timeout=20000)
    addrs = page.evaluate("window.WP.addresses()")
    fund(addrs["maya"], 20)
    fund(addrs["alex"], 60)
    page.evaluate("window.WP.refresh()")
    expect(page.locator(".persona.active .p-bal")).to_have_text("$20.00")
    page.screenshot(path=f"{SHOTS}/01-empty-wardrobe.png")
    page.get_by_role("button", name="How it works on Arc").click()
    expect(page.locator(".modal")).to_contain_text("Payment is held, not sent")
    page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOTS}/01b-how-it-works.png")
    page.get_by_role("button", name="Got it").click()
    expect(page.locator(".modal")).to_have_count(0)
    print("✓ app loads, personas funded, 'How it works' explainer opens")

    # Maya adds a blazer and lists it for $40
    page.get_by_role("button", name="+ Add a piece").click()
    page.fill("#f-name", "Navy wool blazer")
    page.fill("#f-brand", "Hugo Boss")
    page.fill("#f-details", "Size 40R, worn twice")
    page.set_input_files("#f-photo", os.path.join(HERE, "sample-photo.jpg"))
    expect(page.locator("#f-prev img")).to_be_visible()
    expect(page.locator("#f-photo-hint")).to_contain_text("Saved inside the passport on Arc")
    page.check("#f-sell")
    page.fill("#f-price", "40")
    page.screenshot(path=f"{SHOTS}/02-add-form.png")
    page.get_by_role("button", name="Add to wardrobe").click()
    expect(page.locator(".toast.ok", has_text="is now for sale")).to_be_visible(timeout=20000)
    expect(page.locator(".card", has_text="Navy wool blazer")).to_contain_text("For sale · $40.00")
    expect(page.locator(".card", has_text="Navy wool blazer").locator("img")).to_have_attribute("src", re.compile(r"^data:image/(webp|jpeg);base64,"))
    expect(page.locator(".toast.ok", has_text="Network fee")).to_have_count(2)
    page.screenshot(path=f"{SHOTS}/03-maya-listed.png")
    print("✓ Maya created the passport with a photo stored on-chain and listed it for $40 (fees shown)")

    # Alex finds it in the shop and pays
    page.locator('[data-persona="alex"]').click()
    page.get_by_role("tab", name="Shop pre-owned").click()
    expect(page.locator(".card", has_text="Navy wool blazer")).to_contain_text("$40.00")
    page.screenshot(path=f"{SHOTS}/04-alex-shop.png")
    page.locator(".card", has_text="Navy wool blazer").click()
    expect(page.locator(".modal")).to_contain_text("Passport issued to Maya")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{SHOTS}/05-passport-before.png")
    page.get_by_role("button", name="Buy for $40.00").click()
    expect(page.locator(".modal")).to_contain_text("held safely")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{SHOTS}/06-buy-confirm.png")
    maya_before = balance(addrs["maya"])
    page.get_by_role("button", name="Pay $40.00").click()
    expect(page.locator(".toast.ok", has_text="Paid!")).to_be_visible(timeout=20000)
    expect(page.locator(".order", has_text="Navy wool blazer")).to_be_visible()
    assert abs(balance(addrs["maya"]) - maya_before) < 1e-9, "seller must not be paid before delivery"
    page.screenshot(path=f"{SHOTS}/07-alex-order.png")
    print("✓ Alex paid; money held (Maya not paid yet)")

    # Maya sees it's sold and the money is held
    page.locator('[data-persona="maya"]').click()
    page.get_by_role("tab", name="My wardrobe").click()
    expect(page.locator(".card", has_text="Navy wool blazer")).to_contain_text("held until delivery")
    page.locator(".card", has_text="Navy wool blazer").click()
    expect(page.locator(".modal")).to_contain_text("Alex paid $40.00")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{SHOTS}/08-maya-sold.png")
    page.keyboard.press("Escape")
    page.get_by_role("tab", name="Orders").click()
    expect(page.locator(".order", has_text="Navy wool blazer")).to_contain_text("paid to you when they confirm delivery")
    expect(page.locator(".stat", has_text="held right now")).to_contain_text("$40.00")
    print("✓ Maya sees the sale and that the money is held")

    # Alex confirms delivery
    page.locator('[data-persona="alex"]').click()
    page.get_by_role("tab", name="Orders").click()
    page.get_by_role("button", name="I received it").click()
    expect(page.locator(".toast.ok", has_text="Done!")).to_be_visible(timeout=20000)
    expect(page.get_by_role("heading", name="Alex's wardrobe")).to_be_visible()
    expect(page.locator(".card", has_text="Navy wool blazer")).to_contain_text("In wardrobe")
    gained = balance(addrs["maya"]) - maya_before
    assert abs(gained - 40) < 1e-9, f"Maya should gain exactly $40, got {gained}"
    page.locator(".card", has_text="Navy wool blazer").click()
    expect(page.locator(".modal")).to_contain_text("Maya → Alex for $40.00")
    page.wait_for_timeout(400)
    page.screenshot(path=f"{SHOTS}/09-passport-after.png", full_page=True)
    page.keyboard.press("Escape")
    expect(page.locator(".stat", has_text="sales completed")).to_contain_text("1")
    expect(page.locator(".stat", has_text="paid out safely")).to_contain_text("$40.00")
    print("✓ Alex confirmed: Maya received exactly $40, passport + history moved to Alex, live stats updated")

    # Public passport page (what a QR code / shared link opens)
    page.locator(".card", has_text="Navy wool blazer").click()
    page.get_by_role("button", name="Share passport").click()
    expect(page.locator(".cert")).to_contain_text("Digital product passport")
    expect(page.locator(".cert")).to_contain_text("No. 000001")
    expect(page.locator(".cert")).to_contain_text("$40.00")
    expect(page.locator(".pp .timeline")).to_contain_text("Maya → Alex for $40.00")
    expect(page.locator(".cert-qr svg")).to_be_visible()
    assert page.url.endswith("#passport=1"), page.url
    page.wait_for_timeout(300)
    page.screenshot(path=f"{SHOTS}/11-public-passport.png", full_page=True)
    page.get_by_role("button", name="← Back to the app").click()
    expect(page.get_by_role("heading", name="Alex's wardrobe")).to_be_visible()
    print("✓ Public passport page: certificate, QR code, history, shareable link")

    # Order history
    page.get_by_role("tab", name="Orders").click()
    expect(page.locator(".done", has_text="Bought Navy wool blazer")).to_contain_text("−$40.00")
    page.locator('[data-persona="maya"]').click()
    expect(page.locator(".done", has_text="Sold Navy wool blazer")).to_contain_text("+$40.00")
    page.screenshot(path=f"{SHOTS}/12-maya-orders.png")
    page.locator('[data-persona="alex"]').click()
    page.get_by_role("tab", name="My wardrobe").click()
    print("✓ Orders tab shows completed purchase (Alex) and sale (Maya)")

    # Resale: Alex lists it again from the passport screen
    page.locator(".card", has_text="Navy wool blazer").click()
    page.fill("#list-price", "55")
    page.get_by_role("button", name="List for sale").click()
    expect(page.locator(".toast.ok", has_text="is now for sale")).to_be_visible(timeout=20000)
    page.keyboard.press("Escape")
    page.locator('[data-persona="maya"]').click()
    page.get_by_role("tab", name="Shop pre-owned").click()
    expect(page.locator(".card", has_text="Navy wool blazer")).to_contain_text("$55.00")
    print("✓ Resale: Alex relisted it for $55 and Maya can see it in the shop")

    # Quick-fill sample piece (icon instead of photo), listed straight away by Alex
    page.locator('[data-persona="alex"]').click()
    page.get_by_role("tab", name="My wardrobe").click()
    page.get_by_role("button", name="+ Add a piece").click()
    page.get_by_role("button", name="Steel dive watch").click()
    expect(page.locator("#f-price")).to_have_value("12")
    page.get_by_role("button", name="Add to wardrobe").click()
    expect(page.locator(".toast.ok", has_text="is now for sale")).to_be_visible(timeout=20000)
    expect(page.locator(".card", has_text="Steel dive watch")).to_contain_text("For sale · $12.00")
    page.locator('[data-persona="maya"]').click()
    page.goto(URL + "#passport=2")
    expect(page.locator(".pp-cta")).to_contain_text("$12.00")
    page.get_by_role("button", name="Buy it in the app").click()
    expect(page.get_by_role("button", name="Pay $12.00")).to_be_visible()
    page.keyboard.press("Escape")
    print("✓ Quick-fill sample works; a listed item's public page links straight to buying")

    # Mobile layout check
    page.set_viewport_size({"width": 390, "height": 844})
    page.evaluate("document.querySelectorAll('#toast-root .toast').forEach(t => t.remove())")
    page.screenshot(path=f"{SHOTS}/10-mobile-shop.png")
    page.goto(URL + "#passport=1")
    expect(page.locator(".cert")).to_be_visible()
    page.screenshot(path=f"{SHOTS}/13-mobile-passport.png", full_page=True)

    browser.close()

real_errors = [e for e in errors if "fonts.googleapis" not in e and "net::ERR" not in e]
if real_errors:
    print("Page errors:", *real_errors, sep="\n  ")
    sys.exit(1)
print("\nAll end-to-end checks passed.")
