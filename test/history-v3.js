// Plays the admin "demo history" on the local chain and checks the result.
const { ethers } = require("ethers");
const cfg = require("./.devchain.json");
const URL = "http://127.0.0.1:3000";
(async () => {
  let cookie = "";
  const call = async (path, body) => {
    const r = await fetch(URL + path, { method: body ? "POST" : "GET", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined });
    const sc = r.headers.get("set-cookie"); if (sc) cookie = sc.split(";")[0];
    const d = await r.json(); if (!r.ok) throw new Error(d.error); return d;
  };
  const n = await call("/api/auth", { op: "admin-nonce" });
  await call("/api/auth", { op: "admin", nonce: n.nonce, signature: await new ethers.Wallet(cfg.adminKey).signMessage(n.message) });
  let r;
  if (process.argv.includes("--full")) {
    console.log((await call("/api/admin", { op: "setup" })).message);
    do { r = await call("/api/admin", { op: "seed" }); } while (r.remaining > 0);
    console.log("seeded", r.total);
  }
  do { r = await call("/api/admin", { op: "history" }); console.log(`step ${r.step}/${r.total}:`, r.done.join(" | ")); } while (!r.finished);
  const st = await call("/api/state");
  const sales = st.items.reduce((s, i) => s + st.histories[i.id].filter((t) => !/^0x0{40}$/i.test(t.from)).length, 0);
  console.log("items", st.items.length, "listed", st.items.filter((i) => i.status === 1).length, "disputes", st.disputes.map((d) => ({ resolved: d.resolved, buyerWon: d.buyerWon, byPanel: d.decidedByPanel })), "ledger rows", st.ledger.length, "auth requests", Object.keys(st.authRequests).length);
  const again = await call("/api/admin", { op: "history" });
  console.log("rerun is a no-op:", again.finished && again.done.length === 0);
})().catch((e) => { console.error("FAILED", e.message); process.exit(1); });
