// Checks that the rates and records the app works out itself match the protection contract exactly.
const { ethers } = require("ethers");
const cfg = require("./.devchain.json");
const abi = require("../web/lib/protectionAbi.json");
(async () => {
  const st = await (await fetch("http://127.0.0.1:3000/api/state")).json();
  const p = new ethers.Contract(cfg.protection, abi, new ethers.JsonRpcProvider("http://127.0.0.1:8545"));
  const W = ethers.encodeBytes32String("watches");
  let n = 0;
  for (const [a, m] of Object.entries(st.protection.members)) {
    const r = await p.rate(a, ethers.ZeroAddress, W);
    const want = [Number(r.feeBps), Number(r.sellerAdj), Number(r.inviterAdj), Number(await p.fakesSoldBy(a)), Number(await p.claimsRejectedOf(a)), (await p.stakeValue(a)).toString()];
    const got = [m.rate.feeBps, m.rate.sellerAdj, m.rate.inviterAdj, m.fakesSold, m.claimsRejected, m.value];
    if (JSON.stringify(want) !== JSON.stringify(got)) throw new Error(`${a}: contract ${want} vs app ${got}`);
    n++;
  }
  for (const [a, s] of Object.entries(st.protection.shops)) for (const [k, v] of Object.entries(s.fakesIn)) {
    if (Number(await p.fakesStampedIn(a, ethers.encodeBytes32String(k))) !== v) throw new Error(`fakesIn ${a} ${k}`);
  }
  for (const it of st.items) {
    const onchain = ethers.decodeBytes32String(await p.categoryOf(it.id));
    if ((st.protection.categoryOf[it.id] || "") !== onchain) throw new Error(`categoryOf ${it.id}: ${onchain} vs ${st.protection.categoryOf[it.id]}`);
  }
  console.log(`rates, records and categories match the contract for ${n} members, ${st.items.length} pieces`);
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
