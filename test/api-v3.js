// End-to-end API test of the V3 app against a local chain.
// Start first: `node test/devchain-v3.js`, then the web app (WALLET_PROVIDER=local,
// ARC_RPC_URL=http://127.0.0.1:8545, CONTRACT_ADDRESS from test/.devchain.json).
// Every person gets their own cookie jar, so each step runs as that person.
const { ethers } = require("ethers");
const cfg = require("./.devchain.json");
const URL = process.env.APP_URL || "http://127.0.0.1:3000";

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("  ✓", name); }
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); };
const ok = (c, msg) => { if (!c) throw new Error(msg); };

function person() {
  let cookie = "";
  const call = async (path, body) => {
    const res = await fetch(URL + path, {
      method: body ? "POST" : "GET",
      headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    const set = res.headers.get("set-cookie");
    if (set) cookie = set.split(";")[0];
    const data = await res.json();
    if (!res.ok) throw Object.assign(new Error(data.error || res.status), { status: res.status, data });
    return data;
  };
  return { call, tx: (body) => call("/api/tx", body), state: () => call("/api/state"), session: () => call("/api/session") };
}
async function expectError(p, text) {
  try { await p; } catch (e) { if (!String(e.message).includes(text)) throw new Error(`Expected "${text}", got "${e.message}"`); return; }
  throw new Error(`Expected an error containing "${text}"`);
}
const rpc = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
const bal = async (a) => rpc.getBalance(a);
const usd = (n) => ethers.parseUnits(String(n), 18);

(async () => {
  const admin = person(), maya = person(), alex = person(), shop = person(), newbie = person(), anon = person();
  const adminWallet = new ethers.Wallet(cfg.adminKey);

  console.log("\nSigned out");
  await check("the public sees chain data but no ledger or names", async () => {
    const s = await anon.session();
    eq(s.me, null, "no user"); eq(s.directory.length, 0, "no directory");
    const st = await anon.state();
    eq(st.ledger.length, 0, "no ledger");
  });
  await check("joining needs a valid invite", () => expectError(anon.call("/api/auth", { op: "check-invite", code: "nope" }), "isn't valid"));
  await check("members-only actions need a session", () => expectError(anon.tx({ action: "createPassport", name: "x" }), "sign in"));

  console.log("\nAdmin signs in with the contract's admin wallet");
  await check("a different wallet is refused", async () => {
    const n = await anon.call("/api/auth", { op: "admin-nonce" });
    const sig = await ethers.Wallet.createRandom().signMessage(n.message);
    await expectError(anon.call("/api/auth", { op: "admin", nonce: n.nonce, signature: sig }), "isn't the contract's admin");
  });
  await check("the deployer's signature signs in as admin", async () => {
    const n = await admin.call("/api/auth", { op: "admin-nonce" });
    await admin.call("/api/auth", { op: "admin", nonce: n.nonce, signature: await adminWallet.signMessage(n.message) });
    const s = await admin.session();
    eq(s.isAdmin, true, "isAdmin");
  });
  await check("a nonce can't be reused", async () => {
    const n = await anon.call("/api/auth", { op: "admin-nonce" });
    const sig = await adminWallet.signMessage(n.message);
    await anon.call("/api/auth", { op: "admin", nonce: n.nonce, signature: sig });
    await expectError(person().call("/api/auth", { op: "admin", nonce: n.nonce, signature: sig }), "expired");
  });

  console.log("\nAdmin setup");
  await check("setup: Maya and Alex join on-chain and the shop checks their IDs", async () => {
    const r = await admin.call("/api/admin", { op: "setup" });
    ok(/Maya's ID checked/.test(r.message), r.message);
    const st = await admin.state();
    eq(st.members.length, 2, "2 members");
    ok(st.members.every((m) => m.verifiedBy), "both verified");
    const alexM = st.members[1];
    eq(alexM.invitedBy.toLowerCase(), st.members[0].addr.toLowerCase(), "Alex invited by Maya on-chain");
  });
  await check("seeding adds 12 community members, invited, ID-checked, funded", async () => {
    let r;
    do { r = await admin.call("/api/admin", { op: "seed" }); } while (r.remaining > 0);
    eq(r.total, 12, "12 seeded");
    const st = await admin.state();
    eq(st.members.length, 14, "14 members");
    eq(st.members.filter((m) => m.verifiedBy).length, 14, "all verified");
  });
  await check("non-admins can't run setup", () => expectError(person().call("/api/admin", { op: "seed" }), "Only the admin"));

  console.log("\nInvites");
  await maya.call("/api/auth", { op: "demo", handle: "maya" });
  await alex.call("/api/auth", { op: "demo", handle: "alex" });
  await shop.call("/api/auth", { op: "demo", handle: "shop" });
  let code;
  await check("Maya has 3 invites and creates one", async () => {
    const s = await maya.session();
    eq(s.me.allowance.left, 3, "3 left");
    code = (await maya.call("/api/invites", {})).code;
    eq((await maya.session()).me.allowance.left, 2, "2 left");
  });
  await check("the invite shows who sent it", async () => eq((await anon.call("/api/auth", { op: "check-invite", code })).inviterName, "Maya", "inviter"));
  await check("joining creates a wallet, an on-chain membership and a welcome credit", async () => {
    await newbie.call("/api/auth", { op: "join", code, name: "Riya Test", email: "riya@example.com" });
    const s = await newbie.session();
    eq(s.me.name, "Riya Test", "name");
    eq(s.me.credits[0].kind, "welcome_shipping", "welcome credit");
    const st = await newbie.state();
    const m = st.members.find((x) => x.addr.toLowerCase() === s.me.address.toLowerCase());
    ok(m, "member on-chain");
    eq(m.verifiedBy, null, "not verified yet");
    ok((await bal(s.me.address)) >= usd(1), "welcome gas");
  });
  await check("an invite works only once", () => expectError(person().call("/api/auth", { op: "join", code, name: "Other", email: "o@example.com" }), "already been used"));
  await check("one membership per email", async () => {
    const c2 = (await maya.call("/api/invites", {})).code;
    await expectError(person().call("/api/auth", { op: "join", code: c2, name: "Dup", email: "RIYA@example.com" }), "already has a membership");
  });
  await check("signing in again with an email code (demo mode shows the code)", async () => {
    const p = person();
    const r = await p.call("/api/auth", { op: "send-code", email: "riya@example.com" });
    ok(/^\d{6}$/.test(r.demoCode), "demo code");
    await expectError(p.call("/api/auth", { op: "verify", email: "riya@example.com", code: "000000" === r.demoCode ? "111111" : "000000" }), "isn't right");
    await p.call("/api/auth", { op: "verify", email: "riya@example.com", code: r.demoCode });
    eq((await p.session()).me.name, "Riya Test", "signed in");
  });
  await check("unknown emails are told membership is by invitation", () => expectError(person().call("/api/auth", { op: "send-code", email: "who@example.com" }), "by invitation"));

  console.log("\nSelling needs an ID check");
  const newbieAddr = (await newbie.session()).me.address;
  const newbieHandle = (await newbie.session()).me.handle;
  await check("an unverified member can create a passport but not list", async () => {
    await newbie.call("/api/fund", { dollars: 5 });
    const r = await newbie.tx({ action: "createPassport", name: "Silk scarf", brand: "Hermès", details: "90cm", icon: "other" });
    const st = await newbie.state();
    await newbie.tx({ action: "requestAuth", id: r.id, partner: st.partners[0].addr });
    await shop.tx({ action: "authenticate", id: r.id, note: "Checked" });
    await expectError(newbie.tx({ action: "list", id: r.id, price: "10" }), "ID needs to be checked");
  });
  await check("the shop checks the member's ID at the front desk; now they can list", async () => {
    await shop.tx({ action: "verifyMember", member: newbieHandle });
    const st = await newbie.state();
    ok(st.members.find((m) => m.addr.toLowerCase() === newbieAddr.toLowerCase()).verifiedBy, "verified");
    const id = st.items.find((i) => i.name === "Silk scarf").id;
    await newbie.tx({ action: "list", id, price: "10" });
  });
  await check("only a pawn shop can check IDs", () => expectError(maya.tx({ action: "verifyMember", member: newbieHandle }), "pawn shop"));

  console.log("\nSale with a dispute decided by the panel");
  let itemId, did;
  await check("Maya lists a watch; Alex buys; Maya ships", async () => {
    const r = await maya.tx({ action: "createPassport", name: "Dive watch", brand: "Seiko", details: "Box and papers", icon: "watch" });
    itemId = r.id;
    const st = await maya.state();
    await maya.tx({ action: "requestAuth", id: itemId, partner: st.partners[0].addr });
    await shop.tx({ action: "authenticate", id: itemId, note: "Serial checked" });
    await maya.tx({ action: "list", id: itemId, price: "20" });
    await alex.call("/api/fund", { dollars: 20 });
    await alex.tx({ action: "buy", id: itemId });
    await maya.tx({ action: "ship", id: itemId });
  });
  await check("Alex opens a dispute with a $1 bond; a panel of 5 is drawn", async () => {
    await alex.tx({ action: "dispute", id: itemId, reason: "Not as described: strap replaced" });
    const st = await alex.state();
    const d = st.disputes[st.disputes.length - 1];
    did = d.id;
    eq(d.bond, usd(1).toString(), "bond");
    eq(d.panel.length, 5, "panel size");
    const s = await admin.session();
    const byAddr = Object.fromEntries(s.directory.map((u) => [u.address.toLowerCase(), u.handle]));
    for (const p of d.panel) ok(!["maya", "alex", "shop", newbieHandle].includes(byAddr[p.addr.toLowerCase()]), "ineligible panelist");
  });
  await check("the shop files an inspection report; it can't decide while the panel works", async () => {
    await shop.tx({ action: "report", did, report: "Re-inspected: strap is original" });
    await expectError(shop.tx({ action: "resolve", did, buyerWins: true }), "panel is deciding");
  });
  await check("non-panelists can't vote", () => expectError(maya.tx({ action: "vote", did, buyerWins: false }), "not on the panel"));
  await check("3 panel votes for the seller settle it; voters are paid; Alex's inviter is accountable", async () => {
    const st = await admin.state();
    const s = await admin.session();
    const d = st.disputes.find((x) => x.id === did);
    const handles = d.panel.map((p) => s.directory.find((u) => u.address.toLowerCase() === p.addr.toLowerCase()).handle);
    const voters = [];
    for (const h of handles.slice(0, 3)) { const v = person(); await v.call("/api/auth", { op: "demo", handle: h }); voters.push(v); }
    const v0 = await bal(d.panel[0].addr);
    const mayaBefore = await bal((await maya.session()).me.address);
    for (const v of voters) await v.tx({ action: "vote", did, buyerWins: false });
    const st2 = await admin.state();
    const d2 = st2.disputes.find((x) => x.id === did);
    eq(d2.resolved, true, "resolved"); eq(d2.buyerWon, false, "seller won"); eq(d2.decidedByPanel, true, "by panel");
    const share = usd(0.4) / 3n;
    ok((await bal(d.panel[0].addr)) > v0 + share - usd(0.01), "panelist rewarded (minus gas)");
    ok((await bal((await maya.session()).me.address)) > mayaBefore + usd(21), "Maya paid price - fee + deposit + bond remainder");
    eq(st2.items.find((i) => i.id === itemId).owner.toLowerCase(), (await alex.session()).me.address.toLowerCase(), "Alex owns it");
    const mayaAddr = (await maya.session()).me.address.toLowerCase();
    eq(st2.records[mayaAddr].inviteesDisputesLost, 1, "Maya's invitee (Alex) lost a dispute");
  });

  console.log("\nFlags, credits and the ledger");
  await check("3 members flag a listing; it's paused; the shop clears it", async () => {
    const st = await maya.state();
    const scarf = st.items.find((i) => i.name === "Silk scarf");
    for (const h of ["maya", "alex"]) await (h === "maya" ? maya : alex).tx({ action: "flag", id: scarf.id, reason: "Looks off" });
    const s = await admin.session();
    const v = person(); await v.call("/api/auth", { op: "demo", handle: s.directory.find((u) => u.seeded).handle });
    await v.tx({ action: "flag", id: scarf.id, reason: "Price too low" });
    await expectError(alex.tx({ action: "buy", id: scarf.id }), "paused");
    await expectError(newbie.tx({ action: "flag", id: scarf.id }), "own listing");
    await shop.tx({ action: "clearFlags", id: scarf.id });
    eq(Object.keys((await alex.state()).flags).length, 0, "flags cleared");
  });
  await check("too little money gives a clear message, not a generic error", async () => {
    const st = await maya.state();
    const id = st.items.find((i) => i.name === "Silk scarf").id;
    const poor = person();
    const c = (await maya.call("/api/invites", {})).code;
    await poor.call("/api/auth", { op: "join", code: c, name: "Low Balance", email: "low@example.com" });
    await expectError(poor.tx({ action: "buy", id }), "Not enough test dollars");
  });
  await check("no invite reward when the inviter is also the seller (self-dealing)", async () => {
    const st = await maya.state();
    const r = await maya.tx({ action: "createPassport", name: "Leather tote", brand: "Coach", details: "Tan", icon: "bag" });
    await maya.tx({ action: "requestAuth", id: r.id, partner: st.partners[0].addr });
    await shop.tx({ action: "authenticate", id: r.id, note: "ok" });
    await maya.tx({ action: "list", id: r.id, price: "1" });
    await newbie.tx({ action: "buy", id: r.id });
    await maya.tx({ action: "ship", id: r.id });
    await newbie.tx({ action: "confirm", id: r.id });
    // Maya is the seller here, so this is self-dealing: no reward.
    eq((await maya.session()).me.credits.length, 0, "no reward when the inviter is the seller");
    const st2 = await alex.state();
    const id2 = st2.items.find((i) => i.name === "Dive watch").id;
    void id2;
  });
  await check("members see the ledger with Arc transaction hashes", async () => {
    const st = await alex.state();
    ok(st.ledger.length > 20, "ledger rows");
    ok(st.ledger.every((r) => /^0x[0-9a-f]{64}$/i.test(r.hash)), "tx hashes");
    ok(st.ledger.some((r) => r.action === "vote"), "votes in ledger");
  });
  await check("members see only their own balance; the admin sees all", async () => {
    eq(Object.keys((await alex.state()).balances).length, 2, "own + treasury");
    ok(Object.keys((await admin.state()).balances).length > 10, "admin sees all");
  });
  await check("sign out ends the session", async () => {
    await alex.call("/api/auth", { op: "sign-out" });
    eq((await alex.session()).me, null, "signed out");
  });

  console.log(`\nAll ${passed} API checks passed.`);
})().catch((e) => { console.error("\nFAILED:", e.message, e.data || ""); process.exit(1); });
