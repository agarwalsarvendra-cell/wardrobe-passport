// Plays QuickNode Streams locally: reads every block (with receipts) from the local chain,
// runs streams/filter.js on them exactly as QuickNode would, and posts the result to
// /api/streams with a QuickNode-style HMAC signature. Checks storage, dedupe, bad
// signatures, and that ledger rows come back "confirmed by the chain feed".
// Needs QN_STREAM_SECRET=local-test-secret in web/.env.local.
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { ethers } = require("ethers");
const cfg = require("./.devchain.json");
const URL = process.env.APP_URL || "http://127.0.0.1:3000";
const SECRET = "local-test-secret";
const rpc = new ethers.JsonRpcProvider("http://127.0.0.1:8545");

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log("  ✓", name); }
const ok = (c, msg) => { if (!c) throw new Error(msg); };

const src = fs.readFileSync(path.join(__dirname, "..", "streams", "filter.js"), "utf8")
  .replace("PROTECTION_ADDRESS_LOWERCASE", (cfg.protection || "0x0").toLowerCase())
  .replace("0xf3ef3709c7d14e5b86b1c9e2b4a37ad97d7b9ccf", cfg.address.toLowerCase());
const main = new Function(`${src}; return main;`)();

async function post(body, secret = SECRET) {
  const raw = JSON.stringify(body);
  const nonce = crypto.randomBytes(8).toString("hex"), ts = String(Math.floor(Date.now() / 1000));
  const sig = crypto.createHmac("sha256", secret).update(nonce + ts + raw).digest("hex");
  const r = await fetch(URL + "/api/streams", { method: "POST", headers: { "content-type": "application/json", "x-qn-nonce": nonce, "x-qn-timestamp": ts, "x-qn-signature": sig }, body: raw });
  return { status: r.status, body: r.status === 200 ? await r.json() : await r.text() };
}

(async () => {
  const latest = await rpc.getBlockNumber();
  const data = [];
  for (let n = 0; n <= latest; n++) {
    const block = await rpc.send("eth_getBlockByNumber", ["0x" + n.toString(16), false]);
    const receipts = await Promise.all(block.transactions.map((h) => rpc.send("eth_getTransactionReceipt", [h])));
    data.push({ block, receipts });
  }
  const payload = main({ data });
  console.log(`\nQuickNode Streams, simulated over ${latest + 1} blocks`);
  await check("the filter keeps only our two contracts' logs, and returns null for an empty block", async () => {
    ok(payload && payload.events.length > 10, "events");
    ok(payload.events.every((e) => [cfg.address.toLowerCase(), (cfg.protection || "").toLowerCase()].includes(e.address)), "only our contracts");
    eq(main({ data: [{ block: data[0].block, receipts: [] }] }), null, "empty block");
  });
  await check("a bad signature is refused", async () => { eq((await post(payload, "wrong")).status, 401, "status"); });
  await check("a signed delivery is stored and decoded with both ABIs; a repeat stores nothing", async () => {
    // Deliver in batches, like QuickNode does.
    let stored = 0;
    for (let i = 0; i < payload.events.length; i += 50) stored += (await post({ ...payload, events: payload.events.slice(i, i + 50) })).body.stored;
    eq(stored, payload.events.length, "stored all");
    eq((await post(payload)).body.stored, 0, "dedupe");
  });
  await check("the ledger shows actions confirmed by the chain feed", async () => {
    let cookie = "";
    const n = await (await fetch(URL + "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "admin-nonce" }) })).json();
    const r = await fetch(URL + "/api/auth", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ op: "admin", nonce: n.nonce, signature: await new ethers.Wallet(cfg.adminKey).signMessage(n.message) }) });
    cookie = r.headers.get("set-cookie").split(";")[0];
    const st = await (await fetch(URL + "/api/state", { headers: { cookie } })).json();
    ok(st.streamStatus && st.streamStatus.count === payload.events.length, "status count");
    const contractRows = st.ledger.filter((x) => x.action !== "fund");
    const confirmed = contractRows.filter((x) => st.streamed[x.hash.toLowerCase()]);
    ok(confirmed.length === contractRows.length, `all contract actions confirmed (${confirmed.length}/${contractRows.length})`);
    const names = new Set(st.chainFeed.map((e) => e.event));
    ok(!names.has("Unknown"), "every event decoded");
    if (cfg.protection) ok(st.chainFeed.some((e) => e.contract === "protection"), "protection events decoded");
    console.log("     events seen:", [...new Set(Object.values(st.streamed).flat())].join(", "));
  });
  console.log(`\nAll ${passed} streams checks passed.`);
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
function eq(a, b, msg) { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); }
