// Contract tests for WardrobePassportV2 on a local chain.
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const ganache = require("ganache");
const { ethers } = require("ethers");

function compile(evmVersion) {
  const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "WardrobePassportV2.sol"), "utf8");
  const rejector = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
contract Rejector2 { bool public accept; function setAccept(bool a) external { accept = a; }
  function call(address t, bytes calldata d) external payable returns (bytes memory) { (bool ok, bytes memory r) = t.call{value: msg.value}(d); require(ok, "call failed"); return r; }
  receive() external payable { require(accept, "no thanks"); } }`;
  const input = {
    language: "Solidity",
    sources: { "V2.sol": { content: src }, "Rejector2.sol": { content: rejector } },
    settings: { optimizer: { enabled: true, runs: 200 }, ...(evmVersion ? { evmVersion } : {}), outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } } },
  };
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  return { out, warns: (out.errors || []).filter((e) => e.severity === "warning") };
}

let passed = 0, IFACE;
async function check(name, fn) { await fn(); passed++; console.log("  ✓", name); }
function revertData(e) {
  const c = [e?.data, e?.info?.error?.data, e?.error?.data, e?.info?.error?.data?.result, e?.info?.error?.data?.data];
  return c.find((d) => typeof d === "string" && d.startsWith("0x")) || null;
}
async function expectRevert(promise, errName) {
  try { await promise; } catch (e) {
    let got = "unknown";
    try { got = IFACE.parseError(revertData(e)).name; } catch (_) {}
    if (got !== errName) throw new Error(`Expected ${errName}, got ${got}`);
    return;
  }
  throw new Error(`Expected revert ${errName}`);
}
const eq = (a, b, msg) => { if (a !== b) throw new Error(`${msg}: expected ${b}, got ${a}`); };

(async () => {
  const arc = compile();
  const size = arc.out.contracts["V2.sol"].WardrobePassportV2.evm.deployedBytecode.object.length / 2;
  console.log(`Compiles for default EVM (Remix/Arc). Warnings: ${arc.warns.length}. Size: ${size} bytes (limit 24576)`);
  arc.warns.forEach((w) => console.log(w.formattedMessage));

  const { out } = compile("paris");
  const art = out.contracts["V2.sol"].WardrobePassportV2;
  const rjArt = out.contracts["Rejector2.sol"].Rejector2;
  IFACE = new ethers.Interface(art.abi);

  const g = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 6, defaultBalance: 1000 } });
  const provider = new ethers.BrowserProvider(g);
  const [admin, seller, buyer, shop, other, shop2] = await Promise.all([0, 1, 2, 3, 4, 5].map((i) => provider.getSigner(i)));
  const A = async (s) => s.getAddress();
  const bal = async (a) => BigInt(await provider.send("eth_getBalance", [a, "latest"]));
  const usd = (n) => ethers.parseUnits(String(n), 18);
  const skip = async (secs) => { await provider.send("evm_increaseTime", [secs]); await provider.send("evm_mine", []); };
  const DAY = 86400;

  const wp = await new ethers.ContractFactory(art.abi, art.evm.bytecode.object, admin).deploy();
  await wp.waitForDeployment();
  const addr = await wp.getAddress();
  const S = wp.connect(seller), B = wp.connect(buyer), P = wp.connect(shop), O = wp.connect(other), AD = wp.connect(admin);
  const sellerA = await A(seller), buyerA = await A(buyer), shopA = await A(shop);
  const go = async (txp) => (await txp).wait();
  // gas-free balance deltas: measure parties who don't send the tx
  const item = (id) => wp.getItem(id);
  const ST = { Owned: 0, Listed: 1, Paid: 2, Shipped: 3, Disputed: 4 };

  // helper: new listed item at price, returns id
  async function listed(price) {
    await go(S.createPassport("Piece", "Brand", "details", "icon:watch"));
    const id = Number(await wp.itemCount());
    await go(S.listForSale(id, usd(price), shopA, { value: usd(price / 10) }));
    return id;
  }

  console.log("\nPartners");
  await check("only the admin can approve partners", () => expectRevert(O.addPartner.staticCall(shopA, "X", "Y"), "NotAdmin"));
  await check("admin approves a pawn shop as partner", async () => {
    await go(AD.addPartner(shopA, "Demo Pawn Shop", "Atlanta"));
    const p = await wp.partners(shopA);
    eq(p.name, "Demo Pawn Shop", "name"); eq(p.active, true, "active");
    eq((await wp.getPartners()).length, 1, "partner list");
  });
  await check("the same partner can't be added twice", () => expectRevert(AD.addPartner.staticCall(shopA, "X", "Y"), "PartnerExists"));

  console.log("\nAuthentication");
  await check("partner authenticates a piece; stamp is stored", async () => {
    await go(S.createPassport("Steel dive watch", "Rolex", "Serial 123", "icon:watch"));
    await go(P.authenticate(1, "Serial and movement checked in store"));
    const it = await item(1);
    eq(it.authBy, shopA, "authBy"); eq(it.authNote, "Serial and movement checked in store", "note");
    eq(Number((await wp.partners(shopA)).authenticated), 1, "count");
  });
  await check("a non-partner can't authenticate", () => expectRevert(O.authenticate.staticCall(1, "ok"), "NotPartner"));

  console.log("\nListing and deposit");
  await check("deposit is 10% of the price", async () => eq(await wp.depositFor(usd(100)), usd(10), "deposit"));
  await check("listing without the exact deposit is rejected", () => expectRevert(S.listForSale.staticCall(1, usd(100), shopA, { value: usd(9) }), "WrongAmount"));
  await check("listing needs an approved partner", () => expectRevert(S.listForSale.staticCall(1, usd(100), buyerA, { value: usd(10) }), "InvalidPartner"));
  await check("seller lists for $100 and locks $10", async () => {
    await go(S.listForSale(1, usd(100), shopA, { value: usd(10) }));
    eq(await bal(addr), usd(10), "contract holds deposit");
    eq(Number((await item(1)).status), ST.Listed, "status");
  });
  await check("taking it off sale returns the deposit", async () => {
    await go(S.cancelListing(1));
    eq(await bal(addr), 0n, "contract empty"); eq(Number((await item(1)).status), ST.Owned, "status");
    await go(S.listForSale(1, usd(100), shopA, { value: usd(10) }));
  });
  await check("the partner on a listing can't be its buyer", () => expectRevert(P.buy.staticCall(1, { value: usd(100) }), "ConflictOfInterest"));

  console.log("\nHappy path: pay, ship, confirm");
  let sellerBefore, shopBefore;
  await check("buyer pays $100; contract holds $110", async () => {
    await go(B.buy(1, { value: usd(100) }));
    eq(await bal(addr), usd(110), "held");
  });
  await check("buyer can't dispute before it ships", () => expectRevert(B.openDispute.staticCall(1, "x"), "WrongStatus"));
  await check("buyer can't cancel as unshipped before 5 days", () => expectRevert(B.buyerCancelUnshipped.staticCall(1), "TooEarly"));
  await check("seller marks shipped", async () => {
    await go(S.markShipped(1));
    eq(Number((await item(1)).status), ST.Shipped, "status");
  });
  await check("seller can't collect before 7 days", () => expectRevert(S.sellerClaim.staticCall(1), "TooEarly"));
  await check("buyer confirms: seller gets $97 + $10 deposit, partner gets $3", async () => {
    sellerBefore = await bal(sellerA); shopBefore = await bal(shopA);
    await go(B.confirmDelivery(1));
    eq((await bal(sellerA)) - sellerBefore, usd(107), "seller gain");
    eq((await bal(shopA)) - shopBefore, usd(3), "partner fee");
    eq(await bal(addr), 0n, "contract empty");
    const it = await item(1);
    eq(it.owner, buyerA, "owner"); eq(Number(it.status), ST.Owned, "status");
    eq(it.authBy, shopA, "authentication stamp stays with the piece");
    eq((await wp.getHistory(1)).length, 2, "history");
    eq(Number((await wp.records(sellerA)).sold), 1, "seller record"); eq(Number((await wp.records(buyerA)).bought), 1, "buyer record");
  });

  console.log("\nBuyer stays silent");
  await check("after 7 days of silence the seller collects", async () => {
    const id = await listed(50);
    await go(B.buy(id, { value: usd(50) }));
    await go(S.markShipped(id));
    await skip(7 * DAY + 1);
    const b0 = await bal(buyerA);
    await go(S.sellerClaim(id));
    eq((await item(id)).owner, buyerA, "passport moved to buyer");
    eq(await bal(buyerA), b0, "buyer not refunded");
    eq(await bal(addr), 0n, "contract empty");
  });

  console.log("\nSeller problems");
  await check("seller cancels before shipping: buyer refunded, noted on record", async () => {
    const id = await listed(20);
    await go(B.buy(id, { value: usd(20) }));
    const b0 = await bal(buyerA);
    await go(S.sellerCancelSale(id));
    eq((await bal(buyerA)) - b0, usd(20), "refund");
    eq(Number((await item(id)).status), ST.Listed, "back on sale");
    eq(Number((await wp.records(sellerA)).refundsGiven), 1, "refundsGiven");
    await go(S.cancelListing(id));
  });
  await check("seller never ships: after 5 days buyer gets refund + seller's deposit", async () => {
    const id = await listed(40);
    const b0 = await bal(buyerA);
    const rc = await go(B.buy(id, { value: usd(40) }));
    await skip(5 * DAY + 1);
    const rc2 = await go(B.buyerCancelUnshipped(id));
    const gas = rc.gasUsed * rc.gasPrice + rc2.gasUsed * rc2.gasPrice;
    eq((await bal(buyerA)) - b0 + gas, usd(4), "buyer nets the $4 deposit");
    const it = await item(id);
    eq(it.owner, sellerA, "seller keeps the piece"); eq(Number(it.status), ST.Owned, "off sale");
    eq(await bal(addr), 0n, "contract empty");
  });

  console.log("\nDisputes");
  await check("only the buyer can open a dispute", async () => {
    const id = await listed(100);
    await go(B.buy(id, { value: usd(100) }));
    await go(S.markShipped(id));
    await expectRevert(O.openDispute.staticCall(id, "x"), "NotBuyer");
    await go(B.openDispute(id, "Not as described"));
    const it = await item(id);
    eq(Number(it.status), ST.Disputed, "status"); eq(it.disputeReason, "Not as described", "reason");
  });
  const dId = Number(await wp.itemCount());
  await check("nobody can confirm or claim while disputed", async () => {
    await expectRevert(B.confirmDelivery.staticCall(dId), "WrongStatus");
    await expectRevert(S.sellerClaim.staticCall(dId), "WrongStatus");
  });
  await check("only the partner on the listing can decide", () => expectRevert(O.resolveDispute.staticCall(dId, true), "NotPartner"));
  await check("buyer wins: refund $100 + $7 of deposit; partner gets $3; seller loses $10", async () => {
    const b0 = await bal(buyerA), s0 = await bal(sellerA), p0 = await bal(shopA);
    const rc = await go(P.resolveDispute(dId, true));
    eq((await bal(buyerA)) - b0, usd(107), "buyer");
    eq(await bal(sellerA), s0, "seller gets nothing back");
    eq((await bal(shopA)) - p0 + rc.gasUsed * rc.gasPrice, usd(3), "partner fee");
    const it = await item(dId);
    eq(it.owner, sellerA, "piece stays with seller"); eq(Number(it.status), ST.Owned, "off sale");
    eq(Number((await wp.records(sellerA)).disputesLost), 1, "seller disputesLost");
    eq(Number((await wp.records(buyerA)).disputesWon), 1, "buyer disputesWon");
    eq(Number((await wp.partners(shopA)).disputesResolved), 1, "partner count");
    eq(await bal(addr), 0n, "contract empty");
  });
  await check("seller wins: sale completes, records updated", async () => {
    const id = await listed(100);
    await go(B.buy(id, { value: usd(100) }));
    await go(S.markShipped(id));
    await go(B.openDispute(id, "Changed my mind"));
    const s0 = await bal(sellerA);
    await go(P.resolveDispute(id, false));
    eq((await bal(sellerA)) - s0, usd(107), "seller paid");
    eq((await item(id)).owner, buyerA, "passport to buyer");
    eq(Number((await wp.records(sellerA)).disputesWon), 1, "seller disputesWon");
    eq(Number((await wp.records(buyerA)).disputesLost), 1, "buyer disputesLost");
    eq(await bal(addr), 0n, "contract empty");
  });

  console.log("\nSafety");
  await check("paused partner can't take new listings or authenticate", async () => {
    await go(AD.setPartnerActive(shopA, false));
    await go(S.createPassport("P", "B", "d", "icon:bag"));
    const id = Number(await wp.itemCount());
    await expectRevert(S.listForSale.staticCall(id, usd(10), shopA, { value: usd(1) }), "InvalidPartner");
    await expectRevert(P.authenticate.staticCall(id, "x"), "NotPartner");
    await go(AD.setPartnerActive(shopA, true));
  });
  await check("a rejected payout is kept safe and can be withdrawn", async () => {
    const rj = await new ethers.ContractFactory(rjArt.abi, rjArt.evm.bytecode.object, admin).deploy();
    await rj.waitForDeployment();
    const rjA = await rj.getAddress();
    await go(rj.call(addr, IFACE.encodeFunctionData("createPassport", ["RJ", "B", "d", ""])));
    const id = Number(await wp.itemCount());
    await go(rj.call(addr, IFACE.encodeFunctionData("listForSale", [id, usd(30), shopA]), { value: usd(3) }));
    await go(B.buy(id, { value: usd(30) }));
    await go(B.confirmDelivery(id));
    eq(await wp.owed(rjA), usd(32.1), "owed = 30 - 0.9 fee + 3 deposit");
    eq((await item(id)).owner, buyerA, "sale still completed");
    await go(rj.setAccept(true));
    await go(rj.call(addr, IFACE.encodeFunctionData("withdraw", [])));
    eq(await bal(rjA), usd(32.1), "withdrawn"); eq(await wp.owed(rjA), 0n, "cleared");
    eq(await bal(addr), 0n, "contract empty");
  });
  await check("unknown item id is rejected", () => expectRevert(wp.getItem.staticCall(999), "NoSuchItem"));

  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error("\nFAILED:", e.message); process.exit(1); });
