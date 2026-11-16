// Contract tests for WardrobePassportV3 (closed community + dispute panel) on a local chain.
// Run: node test/run-tests-v3.js
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const ganache = require("ganache");
const { ethers } = require("ethers");

function compile(evmVersion) {
  const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "WardrobePassportV3.sol"), "utf8");
  const rejector = `// SPDX-License-Identifier: UNLICENSED
pragma solidity ^0.8.24;
contract Rejector3 { bool public accept; function setAccept(bool a) external { accept = a; }
  function call(address t, bytes calldata d) external payable returns (bytes memory) { (bool ok, bytes memory r) = t.call{value: msg.value}(d); require(ok, "call failed"); return r; }
  receive() external payable { require(accept, "no thanks"); } }`;
  const input = {
    language: "Solidity",
    sources: { "V3.sol": { content: src }, "Rejector3.sol": { content: rejector } },
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
const ok = (c, msg) => { if (!c) throw new Error(msg); };

(async () => {
  const arc = compile();
  const size = arc.out.contracts["V3.sol"].WardrobePassportV3.evm.deployedBytecode.object.length / 2;
  console.log(`Compiles for default EVM (Remix/Arc, optimizer on). Warnings: ${arc.warns.length}. Size: ${size} bytes (limit 24576)`);
  arc.warns.forEach((w) => console.log(w.formattedMessage));

  const { out } = compile("paris");
  const art = out.contracts["V3.sol"].WardrobePassportV3;
  const rjArt = out.contracts["Rejector3.sol"].Rejector3;
  IFACE = new ethers.Interface(art.abi);

  const g = ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 20, defaultBalance: 10000 } });
  const provider = new ethers.BrowserProvider(g);
  const S_ = await Promise.all([...Array(20).keys()].map((i) => provider.getSigner(i)));
  const [admin, shop, f1, f2, seller, buyer, newbie, outsider, ...others] = S_; // others: 12 community members
  const addrOf = async (s) => s.getAddress();
  const bal = async (a) => BigInt(await provider.send("eth_getBalance", [a, "latest"]));
  const usd = (n) => ethers.parseUnits(String(n), 18);
  const skip = async (secs) => { await provider.send("evm_increaseTime", [secs]); await provider.send("evm_mine", []); };
  const DAY = 86400;
  const go = async (txp) => { const tx = await txp; try { return await tx.wait(); } catch (e) { let name = "?"; try { name = IFACE.parseTransaction({ data: tx.data, value: tx.value }).name; } catch (_) {} console.log("tx failed:", name, "gasLimit", tx.gasLimit, "used", e.receipt?.gasUsed); throw e; } };
  const gasOf = (rc) => rc.gasUsed * rc.gasPrice;

  async function deploy() {
    const c = await new ethers.ContractFactory(art.abi, art.evm.bytecode.object, admin).deploy();
    await c.waitForDeployment();
    return c;
  }
  const wp = await deploy();
  const addr = await wp.getAddress();
  const as = (s) => wp.connect(s);
  const A = {};
  for (const [k, s] of Object.entries({ admin, shop, f1, f2, seller, buyer, newbie, outsider })) A[k] = await addrOf(s);
  const O = await Promise.all(others.map(addrOf));
  const ST = { Owned: 0, Listed: 1, Paid: 2, Shipped: 3, Disputed: 4 };
  const item = (id) => wp.getItem(id);

  console.log("\nPlatform setup");
  await check("only the admin can approve partners and operators", async () => {
    await expectRevert(as(outsider).addPartner.staticCall(A.shop, "X", "Y"), "NotAdmin");
    await expectRevert(as(outsider).setOperator.staticCall(A.outsider, true), "NotAdmin");
  });
  await check("admin approves the pawn shop", async () => {
    await go(as(admin).addPartner(A.shop, "Demo Pawn Shop", "Atlanta"));
    eq((await wp.partners(A.shop)).active, true, "active");
  });

  console.log("\nJoining by invitation");
  await check("only an operator can add members", () => expectRevert(as(outsider).registerMember.staticCall(A.outsider, ethers.ZeroAddress), "NotOperator"));
  await check("founding members join without an inviter", async () => {
    await go(as(admin).registerMember(A.f1, ethers.ZeroAddress));
    await go(as(admin).registerMember(A.f2, ethers.ZeroAddress));
    eq((await wp.members(A.f1)).active, true, "f1 active");
  });
  await check("an invite must come from an active member", () => expectRevert(as(admin).registerMember.staticCall(A.seller, A.outsider), "InvalidInviter"));
  await check("invited members record who invited them", async () => {
    await go(as(admin).registerMember(A.seller, A.f1));
    await go(as(admin).registerMember(A.buyer, A.f2));
    await go(as(admin).registerMember(A.newbie, A.f2));
    for (let i = 0; i < O.length; i++) await go(as(admin).registerMember(O[i], i % 2 ? A.f2 : A.f1));
    eq((await wp.members(A.seller)).invitedBy, A.f1, "seller's inviter");
    eq((await wp.getMembers()).length, 5 + O.length, "member count");
  });
  await check("the same person can't join twice", () => expectRevert(as(admin).registerMember.staticCall(A.seller, A.f1), "AlreadyMember"));
  await check("an operator added by the admin can register members", async () => {
    await go(as(admin).setOperator(A.outsider, true));
    await expectRevert(as(outsider).registerMember.staticCall(A.seller, A.f1), "AlreadyMember"); // passes the operator check
    await go(as(admin).setOperator(A.outsider, false));
    await expectRevert(as(outsider).registerMember.staticCall(A.newbie, A.f1), "NotOperator");
  });

  console.log("\nID check at the pawn shop");
  await check("only a partner can verify a member", () => expectRevert(as(f1).verifyMember.staticCall(A.seller), "NotPartner"));
  await check("a non-member can't be verified", () => expectRevert(as(shop).verifyMember.staticCall(A.outsider), "NotMember"));
  await check("the shop verifies members in person", async () => {
    for (const a of [A.f1, A.f2, A.seller, A.buyer, ...O]) await go(as(shop).verifyMember(a));
    eq((await wp.members(A.seller)).verifiedBy, A.shop, "verifiedBy");
    eq(Number((await wp.partners(A.shop)).membersVerified), 4 + O.length, "shop count");
    eq(await wp.isVerified(A.newbie), false, "newbie not verified");
  });
  await check("a member can't be verified twice", () => expectRevert(as(shop).verifyMember.staticCall(A.seller), "AlreadyVerified"));

  console.log("\nWho can do what");
  await check("non-members can't create passports", () => expectRevert(as(outsider).createPassport.staticCall("x", "y", "z", ""), "NotMember"));
  await check("unverified members can create passports but not list", async () => {
    await go(as(newbie).createPassport("Tee", "Brand", "M", "icon:shirt"));
    const id = Number(await wp.itemCount());
    await expectRevert(as(newbie).listForSale.staticCall(id, usd(10), A.shop, { value: usd(1) }), "NotVerified");
  });

  // helper: seller lists a fresh piece
  async function listed(price, who = seller) {
    await go(as(who).createPassport("Piece", "Brand", "details", "icon:watch"));
    const id = Number(await wp.itemCount());
    await go(as(shop).authenticate(id, "Checked in store"));
    await go(as(who).listForSale(id, usd(price), A.shop, { value: usd(price / 10) }));
    return id;
  }

  await check("non-members can't buy", async () => {
    const id = await listed(20);
    await expectRevert(as(outsider).buy.staticCall(id, { value: usd(20) }), "NotMember");
    await go(as(seller).cancelListing(id));
  });
  await check("new members can buy up to $50 until their ID is checked", async () => {
    const big = await listed(60);
    await expectRevert(as(newbie).buy.staticCall(big, { value: usd(60) }), "OverNewMemberCap");
    await go(as(seller).cancelListing(big));
    const small = await listed(40);
    await go(as(newbie).buy(small, { value: usd(40) }));
    await go(as(newbie).confirmDelivery(small));
    eq((await item(small)).owner, A.newbie, "newbie owns it");
  });

  console.log("\nNormal sale");
  await check("pay, ship, confirm: seller $97 + $10 deposit, shop $3", async () => {
    const id = await listed(100);
    await go(as(buyer).buy(id, { value: usd(100) }));
    await go(as(seller).markShipped(id));
    const s0 = await bal(A.seller), p0 = await bal(A.shop);
    await go(as(buyer).confirmDelivery(id));
    eq((await bal(A.seller)) - s0, usd(107), "seller");
    eq((await bal(A.shop)) - p0, usd(3), "shop");
    eq((await item(id)).owner, A.buyer, "owner");
    eq(await bal(addr), 0n, "contract empty");
  });

  console.log("\nOpening a dispute");
  let dId, itemId, panel;
  await check("the buyer must post a 5% bond", async () => {
    itemId = await listed(100);
    await go(as(buyer).buy(itemId, { value: usd(100) }));
    await go(as(seller).markShipped(itemId));
    await expectRevert(as(buyer).openDispute.staticCall(itemId, "Fake", { value: usd(1) }), "WrongAmount");
    await expectRevert(as(f1).openDispute.staticCall(itemId, "Fake", { value: usd(5) }), "NotBuyer");
  });
  await check("a panel of 5 is drawn from verified members", async () => {
    await go(as(buyer).openDispute(itemId, "Stitching doesn't match the brand", { value: usd(5) }));
    dId = Number(await wp.disputeCount());
    panel = await wp.getPanel(dId);
    eq(panel.length, 5, "panel size");
    eq(Number((await item(itemId)).status), ST.Disputed, "status");
    eq(Number((await item(itemId)).disputeId), dId, "item points to dispute");
    eq(await bal(addr), usd(115), "contract holds price + deposit + bond");
  });
  await check("the panel never includes the buyer, seller, their inviters or the shop", async () => {
    for (const p of panel) {
      ok(![A.buyer, A.seller, A.f1, A.f2, A.shop, A.newbie].includes(p), `ineligible panelist ${p}`);
      ok(await wp.isVerified(p), "panelist is verified");
    }
    ok(new Set(panel).size === panel.length, "no duplicates");
  });
  await check("the shop files its inspection report as evidence", async () => {
    await expectRevert(as(f1).fileReport.staticCall(dId, "x"), "NotPartner");
    await go(as(shop).fileReport(dId, "Re-inspected: stitching is factory standard"));
    eq((await wp.getDispute(dId)).report, "Re-inspected: stitching is factory standard", "report");
    eq(Number((await wp.partners(A.shop)).reportsFiled), 1, "reportsFiled");
  });
  await check("the shop can't overrule a working panel", () => expectRevert(as(shop).resolveDispute.staticCall(dId, true), "PanelDecides"));
  await check("only panel members vote, once each", async () => {
    const outsiderOnPanel = O.find((a) => !panel.includes(a));
    const s = others[O.indexOf(outsiderOnPanel)];
    await expectRevert(as(s).castVote.staticCall(dId, true), "NotOnPanel");
    await expectRevert(as(seller).castVote.staticCall(dId, false), "NotOnPanel");
  });

  const sig = (a) => others[O.indexOf(a)];
  console.log("\nPanel decides for the seller (3 of 5)");
  await check("votes are counted on-chain; the 3rd matching vote settles it", async () => {
    await go(as(sig(panel[0])).castVote(dId, false));
    await expectRevert(as(sig(panel[0])).castVote.staticCall(dId, false), "AlreadyVoted");
    await go(as(sig(panel[1])).castVote(dId, true));
    await go(as(sig(panel[2])).castVote(dId, false));
    const s0 = await bal(A.seller), p0 = await bal(A.shop);
    const w0 = await bal(panel[4]), l0 = await bal(panel[1]);
    const rc = await go(as(sig(panel[3])).castVote(dId, false)); // 3rd vote for seller
    const d = await wp.getDispute(dId);
    eq(d.resolved, true, "resolved"); eq(d.buyerWon, false, "seller won"); eq(d.decidedByPanel, true, "by panel");
    // pool $2 split by 3 majority voters; seller gets price - fee + deposit + (bond - pool paid)
    const share = usd(2) / 3n;
    eq((await bal(A.seller)) - s0, usd(107) + usd(5) - share * 3n, "seller paid + bond remainder");
    eq((await bal(A.shop)) - p0, usd(3), "shop fee");
    eq(await bal(panel[4]), w0, "a panelist who didn't vote gets nothing");
    eq(await bal(panel[1]), l0, "the minority voter gets nothing");
    const r3 = await wp.records(panel[3]);
    eq(Number(r3.votesCast), 1, "votesCast"); eq(Number(r3.votesWithMajority), 1, "votesWithMajority");
    eq(Number((await wp.records(panel[1])).votesWithMajority), 0, "minority not counted");
    eq((await item(itemId)).owner, A.buyer, "passport moved to buyer");
    eq(Number((await wp.records(A.buyer)).disputesLost), 1, "buyer lost");
    eq(Number((await wp.records(A.f2)).inviteesDisputesLost), 1, "buyer's inviter is accountable");
    eq(await bal(addr), 0n, "contract empty");
    void rc;
  });
  await check("no more votes after it's settled", () => expectRevert(as(sig(panel[4])).castVote.staticCall(dId, true), "WrongStatus"));

  // helper: dispute on a fresh sale
  async function disputed(price) {
    const id = await listed(price);
    await go(as(buyer).buy(id, { value: usd(price) }));
    await go(as(seller).markShipped(id));
    try { await go(as(buyer).openDispute(id, "Not as described", { value: usd(price / 20) })); } catch (e) { console.log("openDispute failed, gas", e.receipt?.gasUsed); throw e; }
    const did = Number(await wp.disputeCount());
    return { id, did, panel: await wp.getPanel(did) };
  }

  console.log("\nPanel decides for the buyer");
  await check("buyer refunded with bond; seller's deposit pays shop and panel", async () => {
    const { id, did, panel: p } = await disputed(100);
    const b0 = await bal(A.buyer), s0 = await bal(A.seller), sh0 = await bal(A.shop);
    for (const v of p.slice(0, 3)) await go(as(sig(v)).castVote(did, true));
    const share = usd(2) / 3n;
    eq((await bal(A.buyer)) - b0, usd(100) + usd(5) + usd(10) - usd(3) - share * 3n, "buyer");
    eq(await bal(A.seller), s0, "seller gets nothing");
    eq((await bal(A.shop)) - sh0, usd(3), "shop fee");
    const it = await item(id);
    eq(it.owner, A.seller, "piece stays with seller"); eq(Number(it.status), ST.Owned, "off sale");
    eq(Number((await wp.records(A.f1)).inviteesDisputesLost), 1, "seller's inviter is accountable");
    eq(await bal(addr), 0n, "contract empty");
  });

  console.log("\nAfter the 48-hour window");
  await check("can't finalize early", async () => {
    const { did } = await disputed(100);
    await expectRevert(as(outsider).finalizeDispute.staticCall(did), "TooEarly");
  });
  await check("3 votes with a 2-1 split: anyone can close it after the window", async () => {
    const did = Number(await wp.disputeCount());
    const p = await wp.getPanel(did);
    await go(as(sig(p[0])).castVote(did, true));
    await go(as(sig(p[1])).castVote(did, true));
    await go(as(sig(p[2])).castVote(did, false));
    await skip(2 * DAY + 1);
    await expectRevert(as(sig(p[3])).castVote.staticCall(did, true), "TooLate");
    await go(as(outsider).finalizeDispute(did));
    const d = await wp.getDispute(did);
    eq(d.buyerWon, true, "buyer won"); eq(d.decidedByPanel, true, "by panel");
    eq(Number((await wp.records(p[0])).votesWithMajority) >= 1, true, "majority voter credited");
    eq(await bal(addr), 0n, "contract empty");
  });
  await check("fewer than 3 votes: the shop decides, and matching voters are rewarded", async () => {
    const { did, panel: p } = await disputed(100);
    await go(as(sig(p[0])).castVote(did, false));
    await skip(2 * DAY + 1);
    await expectRevert(as(outsider).finalizeDispute.staticCall(did), "PartnerDecides");
    await expectRevert(as(f1).resolveDispute.staticCall(did, false), "NotPartner");
    const v0 = await bal(p[0]);
    await go(as(shop).resolveDispute(did, false));
    eq((await bal(p[0])) - v0, usd(2), "the one matching voter gets the whole $2");
    const d = await wp.getDispute(did);
    eq(d.decidedByPanel, false, "decided by the shop");
    eq(Number((await wp.partners(A.shop)).disputesResolved), 1, "shop count");
    eq(await bal(addr), 0n, "contract empty");
  });
  await check("a 2-2 tie also goes to the shop", async () => {
    const { did, panel: p } = await disputed(100);
    await go(as(sig(p[0])).castVote(did, true));
    await go(as(sig(p[1])).castVote(did, true));
    await go(as(sig(p[2])).castVote(did, false));
    await go(as(sig(p[3])).castVote(did, false));
    await skip(2 * DAY + 1);
    await expectRevert(as(outsider).finalizeDispute.staticCall(did), "PartnerDecides");
    await go(as(shop).resolveDispute(did, true));
    eq((await wp.getDispute(did)).buyerWon, true, "buyer won");
    eq(await bal(addr), 0n, "contract empty");
  });
  await check("the admin can step in if the shop doesn't", async () => {
    const { did } = await disputed(100);
    await skip(2 * DAY + 1);
    await go(as(admin).resolveDispute(did, true));
    eq((await wp.getDispute(did)).resolved, true, "resolved");
    eq(await bal(addr), 0n, "contract empty");
  });

  console.log("\nSmall or changing communities");
  await check("suspended members are skipped for panels and can't buy", async () => {
    await go(as(admin).setMemberActive(O[0], false));
    const id = await listed(10);
    await expectRevert(as(others[0]).buy.staticCall(id, { value: usd(10) }), "NotMember");
    await go(as(buyer).buy(id, { value: usd(10) }));
    await go(as(seller).markShipped(id));
    for (let i = 0; i < 6; i++) { // several draws: O[0] never appears
      if (i) { // fresh dispute each time
        const x = await listed(10);
        await go(as(buyer).buy(x, { value: usd(10) }));
        await go(as(seller).markShipped(x));
        await go(as(buyer).openDispute(x, "r", { value: usd(0.5) }));
      } else await go(as(buyer).openDispute(id, "r", { value: usd(0.5) }));
      const did = Number(await wp.disputeCount());
      ok(!(await wp.getPanel(did)).includes(O[0]), "suspended member drawn");
      await skip(2 * DAY + 1);
      await go(as(shop).resolveDispute(did, i % 2 === 0));
    }
    await go(as(admin).setMemberActive(O[0], true));
    eq(await bal(addr), 0n, "contract empty");
  });
  await check("a community too small for a panel: the shop decides right away", async () => {
    const c2 = await deploy();
    const t = (s) => c2.connect(s);
    await go(t(admin).addPartner(A.shop, "Demo Pawn Shop", "Atlanta"));
    for (const a of [A.f1, A.seller, A.buyer]) { await go(t(admin).registerMember(a, ethers.ZeroAddress)); await go(t(shop).verifyMember(a)); }
    await go(t(seller).createPassport("P", "B", "d", ""));
    await go(t(seller).listForSale(1, usd(10), A.shop, { value: usd(1) }));
    await go(t(buyer).buy(1, { value: usd(10) }));
    await go(t(seller).markShipped(1));
    await go(t(buyer).openDispute(1, "r", { value: usd(0.5) }));
    eq((await c2.getPanel(1)).length, 1, "only f1 is eligible");
    await go(t(shop).resolveDispute(1, true));
    eq(await bal(await c2.getAddress()), 0n, "contract empty");
  });

  console.log("\nSafety");
  await check("a rejected payout is kept safe and can be withdrawn", async () => {
    const rj = await new ethers.ContractFactory(rjArt.abi, rjArt.evm.bytecode.object, admin).deploy();
    await rj.waitForDeployment();
    const rjA = await rj.getAddress();
    await go(as(admin).registerMember(rjA, ethers.ZeroAddress));
    await go(as(shop).verifyMember(rjA));
    await go(rj.call(addr, IFACE.encodeFunctionData("createPassport", ["RJ", "B", "d", ""])));
    const id = Number(await wp.itemCount());
    await go(rj.call(addr, IFACE.encodeFunctionData("listForSale", [id, usd(30), A.shop]), { value: usd(3) }));
    await go(as(buyer).buy(id, { value: usd(30) }));
    await go(as(buyer).confirmDelivery(id));
    eq(await wp.owed(rjA), usd(32.1), "owed = 30 - 0.9 fee + 3 deposit");
    await go(rj.setAccept(true));
    await go(rj.call(addr, IFACE.encodeFunctionData("withdraw", [])));
    eq(await bal(rjA), usd(32.1), "withdrawn");
    eq(await bal(addr), 0n, "contract empty");
  });
  await check("unknown item or dispute ids are rejected", async () => {
    await expectRevert(wp.getItem.staticCall(999), "NoSuchItem");
    await expectRevert(wp.getDispute.staticCall(999), "NoSuchDispute");
  });

  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => { console.error("\nFAILED:", e.transaction?.data?.slice(0,10), e.message.slice(0,200)); process.exit(1); });
