// Compiles the contract with solc-js and runs the full flow on a local test chain.
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const ganache = require("ganache");
const { ethers } = require("ethers");

function compile(evmVersion) {
  const read = (p) => fs.readFileSync(path.join(__dirname, "..", p), "utf8");
  const input = {
    language: "Solidity",
    sources: {
      "contracts/WardrobePassport.sol": { content: read("contracts/WardrobePassport.sol") },
      "test/Rejector.sol": { content: read("test/Rejector.sol") },
    },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      ...(evmVersion ? { evmVersion } : {}),
      outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
    },
  };
  const out = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (p) => ({ contents: read(p.replace(/^test\/\.\.\//, "")) }),
    })
  );
  const errs = (out.errors || []).filter((e) => e.severity === "error");
  if (errs.length) throw new Error(errs.map((e) => e.formattedMessage).join("\n"));
  const warns = (out.errors || []).filter((e) => e.severity === "warning");
  return { out, warns };
}

let passed = 0;
async function check(name, fn) {
  await fn();
  passed++;
  console.log("  ✓", name);
}
let IFACE; // set after compile so we can decode custom errors
function revertData(e) {
  if (typeof e.data === "string" && e.data.startsWith("0x")) return e.data;
  const r = e?.info?.error?.data?.result || e?.error?.data?.result || e?.info?.error?.data;
  return typeof r === "string" ? r : null;
}
async function expectRevert(promise, errName) {
  try {
    await promise;
  } catch (e) {
    const data = revertData(e);
    let got = "unknown";
    try { got = IFACE.parseError(data).name; } catch (_) {}
    if (errName && got !== errName) throw new Error(`Expected ${errName}, got: ${got} (${data})`);
    return;
  }
  throw new Error(`Expected revert ${errName || ""}`);
}

(async () => {
  // 1) Compile for Arc (default EVM version) just to prove it compiles cleanly.
  const arc = compile();
  console.log(`Compiles for default EVM (used by Remix/Arc). Warnings: ${arc.warns.length}`);
  arc.warns.forEach((w) => console.log(w.formattedMessage));

  // 2) Compile for the local test chain.
  const { out } = compile("paris");
  const wpArt = out.contracts["contracts/WardrobePassport.sol"].WardrobePassport;
  const rjArt = out.contracts["test/Rejector.sol"].Rejector;
  IFACE = new ethers.Interface(wpArt.abi);

  const provider = new ethers.BrowserProvider(
    ganache.provider({ logging: { quiet: true }, wallet: { totalAccounts: 4, defaultBalance: 1000 } })
  );
  const [deployer, seller, buyer, buyer2] = await Promise.all([0, 1, 2, 3].map((i) => provider.getSigner(i)));
  // Read balances straight from the node (ethers caches "latest" on this test chain).
  const bal = async (a) => BigInt(await provider.send("eth_getBalance", [a, "latest"]));
  const usd = (n) => ethers.parseUnits(String(n), 18); // native USDC on Arc = 18 decimals

  const wp = await new ethers.ContractFactory(wpArt.abi, wpArt.evm.bytecode.object, deployer).deploy();
  await wp.waitForDeployment();
  const addr = await wp.getAddress();
  const S = wp.connect(seller), B = wp.connect(buyer), B2 = wp.connect(buyer2);

  console.log("\nHappy path");
  await check("seller creates a passport", async () => {
    await (await S.createPassport("Navy wool blazer", "Hugo Boss", "Size 40R, worn twice", "")).wait();
    const it = await wp.getItem(1);
    if (it.owner !== (await seller.getAddress())) throw new Error("owner wrong");
    if ((await wp.getHistory(1)).length !== 1) throw new Error("history should start with 1 entry");
  });
  await check("buyer cannot buy an item that isn't listed", () => expectRevert(B.buy.staticCall(1, { value: usd(40) }), "WrongStatus"));
  await check("only the owner can list", () => expectRevert(B.listForSale.staticCall(1, usd(40)), "NotOwner"));
  await check("price of zero is rejected", () => expectRevert(S.listForSale.staticCall(1, 0), "InvalidPrice"));
  await check("seller lists it for $40", async () => {
    await (await S.listForSale(1, usd(40))).wait();
    if (Number((await wp.getItem(1)).status) !== 1) throw new Error("should be Listed");
  });
  await check("seller cannot buy their own item", () => expectRevert(S.buy.staticCall(1, { value: usd(40) }), "CannotBuyOwnItem"));
  await check("wrong amount is rejected", () => expectRevert(B.buy.staticCall(1, { value: usd(39) }), "WrongAmount"));

  let sellerBefore;
  await check("buyer pays $40 and the contract holds it", async () => {
    sellerBefore = await bal(await seller.getAddress());
    await (await B.buy(1, { value: usd(40) })).wait();
    if ((await bal(addr)) !== usd(40)) throw new Error("contract should hold $40");
    if (Number((await wp.getItem(1)).status) !== 2) throw new Error("should be Pending");
    if ((await bal(await seller.getAddress())) !== sellerBefore) throw new Error("seller paid too early");
  });
  await check("a second buyer cannot buy while payment is held", () => expectRevert(B2.buy.staticCall(1, { value: usd(40) }), "WrongStatus"));
  await check("only the buyer can confirm delivery", () => expectRevert(S.confirmDelivery.staticCall(1), "NotBuyer"));
  await check("buyer can't claim a refund before 14 days", () => expectRevert(B.buyerClaimRefund.staticCall(1), "RefundWindowOpen"));
  await check("buyer confirms: seller gets $40, passport moves to buyer", async () => {
    await (await B.confirmDelivery(1)).wait();
    const it = await wp.getItem(1);
    if (it.owner !== (await buyer.getAddress())) throw new Error("owner should be buyer");
    if (Number(it.status) !== 0) throw new Error("should be Owned");
    const gained = (await bal(await seller.getAddress())) - sellerBefore;
    if (gained !== usd(40)) throw new Error("seller should gain exactly $40, got " + gained);
    if ((await bal(addr)) !== 0n) throw new Error("contract should be empty");
    const h = await wp.getHistory(1);
    if (h.length !== 2 || h[1].price !== usd(40)) throw new Error("history should record the $40 sale");
  });
  await check("old owner can no longer list it", () => expectRevert(S.listForSale.staticCall(1, usd(10)), "NotOwner"));
  await check("item resold: history grows to 3 entries", async () => {
    await (await B.listForSale(1, usd(55))).wait();
    await (await B2.buy(1, { value: usd(55) })).wait();
    await (await B2.confirmDelivery(1)).wait();
    const h = await wp.getHistory(1);
    if (h.length !== 3 || h[2].to !== (await buyer2.getAddress())) throw new Error("bad history");
  });

  console.log("\nWhen things go wrong");
  await check("seller cancels a paid sale: buyer refunded, item back on sale", async () => {
    await (await S.createPassport("Leather loafers", "Cole Haan", "US 9", "")).wait();
    await (await S.listForSale(2, usd(25))).wait();
    await (await B.buy(2, { value: usd(25) })).wait();
    await (await S.sellerCancelSale(2)).wait();
    if ((await bal(addr)) !== 0n) throw new Error("money should be returned");
    if (Number((await wp.getItem(2)).status) !== 1) throw new Error("should be Listed again");
  });
  await check("seller can take an unpaid listing off sale", async () => {
    await (await S.cancelListing(2)).wait();
    if (Number((await wp.getItem(2)).status) !== 0) throw new Error("should be Owned");
  });
  await check("after 14 days, buyer can claim a refund alone", async () => {
    await (await S.listForSale(2, usd(25))).wait();
    await (await B.buy(2, { value: usd(25) })).wait();
    await provider.send("evm_increaseTime", [14 * 24 * 3600 + 1]);
    await provider.send("evm_mine", []);
    await (await B.buyerClaimRefund(2)).wait();
    if ((await bal(addr)) !== 0n) throw new Error("refund missing");
  });
  await check("if a payout is rejected, money is kept safe and can be withdrawn", async () => {
    const rj = await new ethers.ContractFactory(rjArt.abi, rjArt.evm.bytecode.object, deployer).deploy(addr);
    await rj.waitForDeployment();
    await (await rj.createAndList(usd(30))).wait();
    const id = await wp.itemCount();
    await (await B.buy(id, { value: usd(30) })).wait();
    await (await B.confirmDelivery(id)).wait(); // payout to Rejector fails -> deferred
    const rjAddr = await rj.getAddress();
    if ((await wp.owed(rjAddr)) !== usd(30)) throw new Error("should owe $30");
    if ((await wp.getItem(id)).owner !== (await buyer.getAddress())) throw new Error("sale should still complete");
    await (await rj.setAccept(true)).wait();
    await (await rj.doWithdraw()).wait();
    if ((await bal(rjAddr)) !== usd(30)) throw new Error("withdraw failed");
    if ((await wp.owed(rjAddr)) !== 0n) throw new Error("owed not cleared");
  });
  await check("withdraw with nothing owed is rejected", () => expectRevert(B.withdraw.staticCall(), "NothingOwed"));
  await check("unknown item id is rejected", () => expectRevert(wp.getItem.staticCall(999), "NoSuchItem"));

  console.log(`\nAll ${passed} checks passed.`);
  process.exit(0);
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  process.exit(1);
});
