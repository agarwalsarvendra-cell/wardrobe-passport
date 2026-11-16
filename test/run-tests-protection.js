// Contract tests for WardrobeProtection (shop bond, risk-priced cover, claims) next to
// WardrobePassportV3 on a local chain.
// Run: node test/run-tests-protection.js
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const ganache = require("ganache");
const { ethers } = require("ethers");

function compile(evmVersion) {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "contracts", f), "utf8");
  const input = {
    language: "Solidity",
    sources: { "V3.sol": { content: read("WardrobePassportV3.sol") }, "P.sol": { content: read("WardrobeProtection.sol") } },
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
  const size = arc.out.contracts["P.sol"].WardrobeProtection.evm.deployedBytecode.object.length / 2;
  console.log(`Compiles for default EVM (Remix/Arc, optimizer on). Warnings: ${arc.warns.length}. Size: ${size} bytes (limit 24576)`);
  arc.warns.forEach((w) => console.log(w.formattedMessage));

  const { out } = compile("paris");
  const v3Art = out.contracts["V3.sol"].WardrobePassportV3;
  const pArt = out.contracts["P.sol"].WardrobeProtection;
  IFACE = new ethers.Interface(pArt.abi);

  const g = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 12, defaultBalance: 10000 } });
  // cacheTimeout -1: ethers otherwise reuses an identical call's answer for 250 ms, which is wrong on an instant local chain.
  const provider = new ethers.BrowserProvider(g, undefined, { cacheTimeout: -1 });
  const S = await Promise.all([...Array(12).keys()].map((i) => provider.getSigner(i)));
  const [admin, shop, shop2, founder, seller, buyer, staker, staker2, seller2, outsider, risky, shop3] = S;
  const A = {};
  for (const [k, s] of Object.entries({ admin, shop, shop2, founder, seller, buyer, staker, staker2, seller2, outsider, risky, shop3 })) A[k] = await s.getAddress();
  const bal = async (a) => BigInt(await provider.send("eth_getBalance", [a, "latest"]));
  const usd = (n) => ethers.parseUnits(String(n), 18);
  const skip = async (secs) => { await provider.send("evm_increaseTime", [secs]); await provider.send("evm_mine", []); };
  const DAY = 86400;
  const go = async (txp) => { const tx = await txp; try { return await tx.wait(); } catch (e) { console.log("tx failed: selector", tx.data.slice(0, 10), "gasLimit", tx.gasLimit, "used", e.receipt?.gasUsed); throw e; } };
  // Re-stamping a piece: ganache's gas estimate can come out a little low when the stored
  // timestamp changes between the estimate and the block, so give these calls a fixed limit.
  const GAS = { gasLimit: 300000 };
  const gasOf = (rc) => rc.gasUsed * rc.gasPrice;

  const v3 = await new ethers.ContractFactory(v3Art.abi, v3Art.evm.bytecode.object, admin).deploy();
  await v3.waitForDeployment();
  const P = await new ethers.ContractFactory(pArt.abi, pArt.evm.bytecode.object, admin).deploy(await v3.getAddress());
  await P.waitForDeployment();

  // Community: two shops; founder invited seller, buyer, staker, staker2, seller2 and risky.
  await go(v3.addPartner(A.shop, "Demo Pawn Shop", "Atlanta"));
  await go(v3.addPartner(A.shop2, "Second Opinion Jewelers", "Atlanta"));
  await go(v3.addPartner(A.shop3, "Peachtree Handbags", "Atlanta")); // a partner with no watch specialty
  const cat = (s) => ethers.encodeBytes32String(s);
  const W = cat("watches"), VW = cat("vintage-watches"), J = cat("jewelry"), HB = cat("handbags");
  await go(v3.registerMember(A.founder, ethers.ZeroAddress));
  for (const m of ["seller", "buyer", "staker", "staker2", "seller2", "risky"]) await go(v3.registerMember(A[m], A.founder));
  for (const m of ["seller", "buyer", "seller2", "risky"]) await go(v3.connect(shop).verifyMember(A[m]));

  // Helper: seller creates, shop authenticates, seller lists, buyer buys. Returns the item id.
  async function saleTo(sellerS, buyerS, price, authShop = shop) {
    const id = Number(await v3.itemCount()) + 1;
    await go(v3.connect(sellerS).createPassport("Steel dive watch", "Seiko", "Box and papers", "icon:watch"));
    await go(v3.connect(authShop).authenticate(id, "Serial checked", GAS));
    await go(P.connect(authShop).certify(id, W));
    await go(v3.connect(sellerS).listForSale(id, usd(price), await authShop.getAddress(), { value: usd(price) / 10n }));
    await go(v3.connect(buyerS).buy(id, { value: usd(price) }));
    return id;
  }
  const feeOf = async (id) => (await P.quote(id)).fee;

  console.log("\nCategories and specialists");
  await check("launch categories exist, and vintage watches start at a higher base rate", async () => {
    eq((await P.getCategories()).length, 4, "four categories");
    eq((await P.categories(W)).baseBps, 300n, "watches"); eq((await P.categories(VW)).baseBps, 400n, "vintage watches");
  });
  await check("only the admin approves specialists, and only for real categories and partners", async () => {
    await expectRevert(P.connect(shop).setSpecialist(A.shop, W, true, "me"), "NotAdmin");
    await expectRevert(P.setSpecialist(A.shop, cat("yachts"), true, "x"), "NoSuchCategory");
    await expectRevert(P.setSpecialist(A.outsider, W, true, "x"), "NotPartner");
    await go(P.setSpecialist(A.shop, W, true, "Certified watchmaker, 20 years at the bench"));
    await go(P.setSpecialist(A.shop2, W, true, "Certified watchmaker"));
    await go(P.setSpecialist(A.shop2, J, true, "Graduate gemologist"));
    await go(P.setSpecialist(A.shop3, HB, true, "Luxury handbag authenticator"));
    eq(await P.specialistIn(A.shop, W), true, "shop is a watch specialist"); eq(await P.specialistIn(A.shop, J), false, "not jewelry");
    eq(await P.credentialOf(A.shop, W), "Certified watchmaker, 20 years at the bench", "credential");
  });
  await check("the admin can add a category later (clothing), within the rate limits", async () => {
    await expectRevert(P.connect(outsider).setCategory(cat("clothing"), "Clothing", 200, true), "NotAdmin");
    await expectRevert(P.setCategory(cat("clothing"), "Clothing", 50, true), "InvalidRate");
    await go(P.setCategory(cat("clothing"), "Clothing", 200, true));
    eq((await P.getCategories()).length, 5, "five categories");
  });

  console.log("\nShop bond and pool");
  await check("only an approved shop can stake a bond", async () => {
    await expectRevert(P.connect(outsider).stakeBond({ value: usd(10) }), "NotPartner");
    await go(P.connect(shop).stakeBond({ value: usd(100) }));
    eq(await P.bondOf(A.shop), usd(100), "bond");
  });
  await check("only members can fund the pool; first staker gets 1 share per dollar", async () => {
    await expectRevert(P.connect(outsider).depositToPool({ value: usd(10) }), "NotMember");
    await go(P.connect(staker).depositToPool({ value: usd(100) }));
    eq(await P.sharesOf(A.staker), usd(100), "shares");
    eq(await P.stakeValue(A.staker), usd(100), "value");
  });

  console.log("\nPricing from the records");
  let item1;
  await check("a new seller pays the base rate plus the new-seller loading (5%)", async () => {
    const r = await P.rate(A.seller, A.shop, W);
    eq(r.feeBps, 500n, "bps"); eq(r.base, 300n, "base"); eq(r.sellerAdj, 200n, "seller"); eq(r.inviterAdj, 0n, "inviter"); eq(r.shopAdj, 0n, "shop");
  });
  await check("cover can't be bought before a sale, by someone else, or for the wrong fee", async () => {
    const id = Number(await v3.itemCount()) + 1;
    await go(v3.connect(seller).createPassport("Navy blazer", "Hugo Boss", "40R", "icon:jacket"));
    await go(v3.connect(shop).authenticate(id, "Labels checked", GAS));
    eq((await P.quote(id)).available, false, "no cover until a specialist certifies it");
    await expectRevert(P.connect(shop2).certify(id, W), "NotPartner");      // didn't stamp this piece
    await expectRevert(P.connect(shop).certify(id, J), "NotSpecialist");    // not a jewelry specialist
    await go(P.connect(shop).certify(id, W));
    await go(v3.connect(seller).listForSale(id, usd(100), A.shop, { value: usd(10) }));
    const q = await P.quote(id);
    eq(q.fee, usd(5), "quoted fee on a listing"); eq(q.available, true, "available");
    await expectRevert(P.connect(buyer).buyCover(id, { value: usd(5) }), "NotInSale");
    await go(v3.connect(buyer).buy(id, { value: usd(100) }));
    await expectRevert(P.connect(outsider).buyCover(id, { value: usd(5) }), "NotBuyer");
    await expectRevert(P.connect(buyer).buyCover(id, { value: usd(4) }), "WrongAmount");
    item1 = id;
  });
  await check("buying cover locks half the price plus the review fee from the shop's bond, and half from the pool", async () => {
    await go(P.connect(buyer).buyCover(item1, { value: usd(5) }));
    const c = await P.getCover(1);
    eq(c.amount, usd(100), "amount"); eq(c.fee, usd(5), "fee"); eq(c.state, 0n, "pending");
    eq(await P.bondLocked(A.shop), usd(52), "shop lock"); eq(await P.poolLocked(), usd(50), "pool lock");
    eq(await P.poolAssets(), usd(105), "pool assets include the fee");
    await expectRevert(P.connect(buyer).buyCover(item1, { value: usd(5) }), "AlreadyCovered");
  });
  await check("locked money can't leave: the shop's bond and the stakers' pool", async () => {
    await expectRevert(P.connect(shop).withdrawBond(usd(49)), "FundsLocked");
    await go(P.connect(shop).withdrawBond(usd(8)));
    await go(P.connect(shop).stakeBond({ value: usd(8) }));
    await expectRevert(P.connect(staker).withdrawFromPool(usd(60)), "FundsLocked");
  });
  await check("fees raise the value of pool shares, and a later staker gets fewer shares per dollar", async () => {
    eq(await P.stakeValue(A.staker), usd(105), "staker value");
    await go(P.connect(staker2).depositToPool({ value: usd(105) }));
    eq(await P.sharesOf(A.staker2), usd(100), "second staker shares");
  });

  console.log("\nCover after delivery, and a fake");
  await check("the 90 days start when the sale completes, not before", async () => {
    await expectRevert(P.activate(1), "NotDelivered");
    await go(v3.connect(seller).markShipped(item1));
    await go(v3.connect(buyer).confirmDelivery(item1));
    await go(P.activate(1));
    const c = await P.getCover(1);
    eq(c.state, 1n, "active");
    if (c.deliveredAt === 0n) throw new Error("deliveredAt not set");
  });
  await check("a claim needs the 5% deposit and comes from the covered buyer", async () => {
    await skip(20 * DAY); // discovered three weeks later, long after escrow released
    await expectRevert(P.connect(outsider).fileClaim(1, "x", { value: usd(5) }), "NotBuyer");
    await expectRevert(P.connect(buyer).fileClaim(1, "x", { value: usd(1) }), "WrongAmount");
    await go(P.connect(buyer).fileClaim(1, "Watchmaker says the movement is not Seiko", { value: usd(5) }));
    eq((await P.getCover(1)).state, 2n, "claimed");
  });
  await check("the shop that stamped it can't rule on its own stamp; neither can the admin yet, the buyer or an outsider", async () => {
    await expectRevert(P.connect(shop).decideClaim(1, false, "it's fine"), "NotReviewer");
    await expectRevert(P.connect(admin).decideClaim(1, true, "admin"), "NotReviewer");
    await expectRevert(P.connect(buyer).decideClaim(1, true, "me"), "NotReviewer");
    await expectRevert(P.connect(outsider).decideClaim(1, true, "me"), "NotReviewer");
    await expectRevert(P.connect(shop3).decideClaim(1, true, "handbag shop"), "NotReviewer"); // a partner, but not a watch specialist
  });
  await check("a second shop rules it fake: buyer gets the full price back, the first shop's bond pays half, the pool pays half", async () => {
    const [b0, r0] = [await bal(A.buyer), await bal(A.shop2)];
    const rc = await go(P.connect(shop2).decideClaim(1, true, "Movement is a clone. Not genuine."));
    eq((await bal(A.buyer)) - b0, usd(105), "buyer: price + deposit back");
    eq((await bal(A.shop2)) - r0 + gasOf(rc), usd(2), "reviewer fee");
    eq(await P.bondOf(A.shop), usd(48), "bond after"); eq(await P.bondLocked(A.shop), 0n, "bond lock released");
    eq(await P.poolAssets(), usd(160), "pool after: 210 - 50"); eq(await P.poolLocked(), 0n, "pool lock released");
    eq(await P.claimsPaid(), usd(100), "claims paid");
    eq(await P.fakesStampedBy(A.shop), 1n, "shop record"); eq(await P.fakesSoldBy(A.seller), 1n, "seller record");
    eq(await P.fakesStampedIn(A.shop, W), 1n, "shop record in watches"); eq(await P.fakesStampedIn(A.shop, J), 0n, "none in jewelry");
    eq((await P.getCover(1)).state, 3n, "paid");
  });
  await check("the records now cost them: the seller and the shop both pay more next time", async () => {
    const r = await P.rate(A.seller, A.shop, W);
    // base 300; seller: 1 sale (-25) + 1 fake (+500) = 475; shop: 1 fake = 400
    eq(r.sellerAdj, 475n, "seller"); eq(r.shopAdj, 400n, "shop"); eq(r.feeBps, 1175n, "bps");
    const clean = await P.rate(A.seller2, A.shop2, W);
    eq(clean.feeBps, 500n, "a new seller behind a clean shop still pays 5%");
  });
  await check("category matters: the same new seller pays 6% on a vintage watch, and a shop's fake counts in its own category", async () => {
    const v = await P.rate(A.seller2, A.shop2, VW);
    eq(v.base, 400n, "vintage base"); eq(v.feeBps, 600n, "vintage fee");
    eq((await P.rate(A.seller2, A.shop, W)).shopAdj, 400n, "shop's fake counts in watches");
    eq((await P.rate(A.seller2, A.shop, J)).shopAdj, 0n, "no loading in jewelry, and no clean credit either");
    await expectRevert(P.rate(A.seller2, A.shop, cat("yachts")), "NoSuchCategory");
  });
  await check("a piece with no specialist certificate can't be covered, and a removed specialist's stamp stops being coverable", async () => {
    const id = Number(await v3.itemCount()) + 1;
    await go(v3.connect(seller).createPassport("Gold chain", "Unbranded", "18k", "icon:other"));
    await go(v3.connect(shop3).authenticate(id, "Looks fine", GAS)); // handbag shop stamping jewelry
    await expectRevert(P.connect(shop3).certify(id, J), "NotSpecialist");
    await go(v3.connect(seller).listForSale(id, usd(20), A.shop3, { value: usd(2) }));
    await go(v3.connect(buyer).buy(id, { value: usd(20) }));
    await expectRevert(P.connect(buyer).buyCover(id, { value: 0 }), "NotCertified");
    await go(v3.connect(seller).sellerCancelSale(id));
    await go(v3.connect(seller).cancelListing(id));
    // shop2 certifies a watch, then loses its watch specialty before the sale
    const id2 = Number(await v3.itemCount()) + 1;
    await go(v3.connect(seller).createPassport("Field watch", "Hamilton", "38mm", "icon:watch"));
    await go(v3.connect(shop2).authenticate(id2, "Serial checked", GAS));
    await go(P.connect(shop2).certify(id2, W));
    await go(P.setSpecialist(A.shop2, W, false, ""));
    await go(v3.connect(seller).listForSale(id2, usd(20), A.shop2, { value: usd(2) }));
    eq((await P.quote(id2)).available, false, "quote says unavailable");
    await go(v3.connect(buyer).buy(id2, { value: usd(20) }));
    await expectRevert(P.connect(buyer).buyCover(id2, { value: usd(1) }), "NotSpecialist");
    await go(v3.connect(seller).sellerCancelSale(id2));
    await go(v3.connect(seller).cancelListing(id2));
    await go(P.setSpecialist(A.shop2, W, true, "Certified watchmaker"));
  });

  console.log("\nA genuine piece, a cancelled sale, and expiry");
  await go(P.connect(shop2).stakeBond({ value: usd(100) }));
  let item2;
  await check("a claim on a genuine piece is rejected: the deposit pays the reviewer and the pool", async () => {
    item2 = await saleTo(seller2, buyer, 100, shop2);
    await go(P.connect(buyer).buyCover(item2, { value: await feeOf(item2) }));
    await go(v3.connect(seller2).markShipped(item2));
    await go(v3.connect(buyer).confirmDelivery(item2));
    await go(P.connect(buyer).fileClaim(2, "I think the strap is aftermarket", { value: usd(5) })); // activates too
    const pool0 = await P.poolAssets();
    const r0 = await bal(A.shop);
    const rc = await go(P.connect(shop).decideClaim(2, false, "Genuine. Strap is original."));
    eq((await bal(A.shop)) - r0 + gasOf(rc), usd(2), "reviewer fee from the deposit");
    eq((await P.poolAssets()) - pool0, usd(3), "rest of the deposit to the pool");
    eq(await P.bondLocked(A.shop2), 0n, "lock released"); eq(await P.poolLocked(), 0n, "pool lock released");
    eq(await P.claimsRejectedOf(A.buyer), 1n, "buyer record"); eq(await P.fakesStampedBy(A.shop2), 0n, "shop2 clean");
    eq((await P.getCover(2)).state, 4n, "rejected");
    await expectRevert(P.connect(buyer).fileClaim(2, "again", { value: usd(5) }), "WrongState");
  });
  await check("if the sale is cancelled, the cover is cancelled and the fee comes back", async () => {
    const id = await saleTo(seller2, buyer, 40, shop2);
    const fee = await feeOf(id);
    await go(P.connect(buyer).buyCover(id, { value: fee }));
    await expectRevert(P.voidCover(3), "StillInSale");
    await go(v3.connect(seller2).sellerCancelSale(id));
    const [b0, pool0] = [await bal(A.buyer), await P.poolAssets()];
    await go(P.connect(outsider).voidCover(3));
    eq((await bal(A.buyer)) - b0, fee, "fee refunded"); eq(pool0 - (await P.poolAssets()), fee, "pool gave it back");
    eq(await P.bondLocked(A.shop2), 0n, "lock released"); eq((await P.getCover(3)).state, 6n, "void");
    await expectRevert(P.activate(3), "WrongState");
  });
  let item4;
  await check("after 90 days the cover ends, the locks are freed, and a late claim is refused", async () => {
    item4 = await saleTo(seller2, buyer, 60, shop2);
    await go(P.connect(buyer).buyCover(item4, { value: await feeOf(item4) }));
    await go(v3.connect(seller2).markShipped(item4));
    await go(v3.connect(buyer).confirmDelivery(item4));
    await expectRevert(P.expire(4), "NotExpired");
    await skip(91 * DAY);
    await expectRevert(P.connect(buyer).fileClaim(4, "late", { value: usd(3) }), "CoverEnded");
    await go(P.expireMany([4]));
    eq(await P.bondLocked(A.shop2), 0n, "lock released"); eq(await P.poolLocked(), 0n, "pool lock released");
    eq((await P.getCover(4)).state, 5n, "expired");
  });
  await check("a buyer who has put the piece back on sale can't claim", async () => {
    const id = await saleTo(seller2, buyer, 20, shop2);
    await go(P.connect(buyer).buyCover(id, { value: await feeOf(id) }));
    await go(v3.connect(seller2).markShipped(id));
    await go(v3.connect(buyer).confirmDelivery(id));
    await go(v3.connect(shop2).authenticate(id, "Rechecked", GAS));
    await go(v3.connect(buyer).listForSale(id, usd(25), A.shop2, { value: usd(2.5) }));
    await expectRevert(P.connect(buyer).fileClaim(5, "fake", { value: usd(1) }), "NoLongerOwner");
    await go(v3.connect(buyer).cancelListing(id));
  });
  await check("if no second shop rules in 3 days, the admin can", async () => {
    await go(P.connect(buyer).fileClaim(5, "Stitching is wrong", { value: usd(1) }));
    await expectRevert(P.connect(admin).decideClaim(5, false, "early"), "NotReviewer");
    await skip(3 * DAY + 60);
    await go(P.connect(admin).decideClaim(5, false, "Genuine on inspection."));
    eq((await P.getCover(5)).state, 4n, "rejected");
  });

  console.log("\nMore of the rating table");
  await check("experience earns a credit: 3 completed sales and 1 refund take a seller from 5% to 3.25%", async () => {
    const r = await P.rate(A.seller2, A.shop2, W);
    // seller2 has completed 3 sales (items 2, 4, 5) and gave 1 refund: 300 - 75 + 100 = 325
    eq(r.sellerAdj, 25n, "seller adj (-75 credit, +100 refund)"); eq(r.feeBps, 325n, "bps");
  });
  await check("the vouching chain is priced: a dispute lost by one invitee raises the fee for everyone that inviter brought in", async () => {
    // risky sells to buyer; buyer disputes; too few eligible panel members, so the shop decides for the buyer.
    const id = await saleTo(risky, buyer, 30, shop2);
    await go(v3.connect(risky).markShipped(id));
    await go(v3.connect(buyer).openDispute(id, "Not as described", { value: usd(1.5) }));
    const did = await v3.disputeCount();
    const panel = await v3.getPanel(did);
    if (panel.length >= 3) { for (const s of [seller, seller2, staker]) { try { await go(v3.connect(s).castVote(did, true)); } catch (_) {} } }
    if (!(await v3.getDispute(did)).resolved) await go(v3.connect(shop2).resolveDispute(did, true));
    eq((await v3.records(A.founder)).inviteesDisputesLost, 1n, "founder's record in V3");
    const r = await P.rate(A.seller2, A.shop2, W);
    eq(r.inviterAdj, 100n, "inviter loading on a different seller the founder invited");
    const rr = await P.rate(A.risky, A.shop2, W);
    eq(rr.sellerAdj, 500n, "risky: new seller 200 + dispute lost 300"); eq(rr.feeBps, 900n, "risky pays 9%");
    const f = await P.rate(A.founder, A.shop2, W);
    eq(f.inviterAdj, 0n, "a founding member has no inviter");
  });
  await check("a shop with 10+ stamps and no fakes earns a credit; the fee never leaves 1% to 20%", async () => {
    const id = await saleTo(seller2, buyer, 10, shop2);
    for (let i = 0; i < 6; i++) await go(v3.connect(shop2).authenticate(id, "again", GAS));
    const p = await v3.partners(A.shop2);
    if (p.authenticated < 10n) throw new Error("need 10 stamps, have " + p.authenticated);
    eq((await P.rate(A.seller2, A.shop2, W)).shopAdj, -50n, "clean shop credit");
    eq((await P.rate(A.seller2, A.shop, W)).shopAdj, 400n, "a shop with a fake gets no credit");
    // Pile fakes on a seller to hit the cap.
    for (let k = 0; k < 4; k++) {
      const it = await saleTo(seller, buyer, 10, shop2);
      await go(P.connect(buyer).buyCover(it, { value: await feeOf(it) }));
      await go(v3.connect(seller).markShipped(it));
      await go(v3.connect(buyer).confirmDelivery(it));
      const cid = await P.coverCount();
      await go(P.connect(buyer).fileClaim(cid, "fake", { value: usd(0.5) }));
      await go(P.connect(shop).decideClaim(cid, true, "Fake."));
    }
    eq((await P.rate(A.seller, A.shop2, W)).feeBps, 2000n, "capped at 20%");
  });

  console.log("\nCapacity");
  await check("no cover without a bond behind the stamp, or without room in the pool", async () => {
    await go(P.connect(shop).withdrawBond(await P.freeBond(A.shop)));
    const id = await saleTo(seller2, buyer, 50, shop);
    eq((await P.quote(id)).available, false, "quote says unavailable");
    await expectRevert(P.connect(buyer).buyCover(id, { value: await feeOf(id) }), "ShopBondTooLow");
    await go(P.connect(shop).stakeBond({ value: usd(1000) }));
    for (const [s, a] of [[staker, A.staker], [staker2, A.staker2]]) await go(P.connect(s).withdrawFromPool(await P.sharesOf(a)));
    eq(await P.totalShares(), 0n, "pool emptied");
    await expectRevert(P.connect(buyer).buyCover(id, { value: await feeOf(id) }), "PoolTooSmall");
  });
  await check("the books balance: the contract holds exactly bonds + pool + open deposits", async () => {
    const held = await bal(await P.getAddress());
    const bonds = (await P.bondOf(A.shop)) + (await P.bondOf(A.shop2));
    eq(held, bonds + (await P.poolAssets()), "balance = bonds + pool");
  });

  console.log(`\n${passed} checks passed`);
  process.exit(0);
})().catch((e) => { console.error("\nFAILED:", e.message || e); process.exit(1); });
