// Local test chain for the V3 app: Arc's chain id, deploys WardrobePassportV3, then does the
// two admin steps done in Remix on Arc (setOperator for the treasury, addPartner for the shop),
// funds the treasury and shop, and writes test/.devchain.json. Keeps running.
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const ganache = require("ganache");
const { ethers } = require("ethers");

(async () => {
  const read = (f) => fs.readFileSync(path.join(__dirname, "..", "contracts", f), "utf8");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity", sources: { "V3.sol": { content: read("WardrobePassportV3.sol") }, "P.sol": { content: read("WardrobeProtection.sol") } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const art = out.contracts["V3.sol"].WardrobePassportV3;
  const server = ganache.server({ chain: { chainId: 5042002 }, wallet: { totalAccounts: 3, defaultBalance: 10000 }, logging: { quiet: true } });
  await new Promise((res) => server.listen(8545, res));
  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const signer = await provider.getSigner(0);
  const c = await new ethers.ContractFactory(art.abi, art.evm.bytecode.object, signer).deploy();
  await c.waitForDeployment();
  const address = await c.getAddress();
  // Same keys the app's "local" wallet provider derives.
  const seed = process.env.LOCAL_WALLET_SEED || "dev-only-seed";
  const key = (label) => ethers.id(`${seed}:${label}`);
  const treasury = new ethers.Wallet(key("treasury")).address;
  const shop = new ethers.Wallet(key("shop")).address;
  await (await c.setOperator(treasury, true)).wait();
  await (await c.addPartner(shop, "Demo Pawn Shop", "Atlanta")).wait();
  await (await signer.sendTransaction({ to: treasury, value: ethers.parseUnits("500", 18) })).wait();
  await (await signer.sendTransaction({ to: shop, value: ethers.parseUnits("5", 18) })).wait();
  // Protection (the Remix steps on Arc): deploy next to V3, approve the second shop, approve specialists.
  let protection = "";
  if (process.env.NO_PROTECTION !== "1") {
    const pArt = out.contracts["P.sol"].WardrobeProtection;
    const p = await new ethers.ContractFactory(pArt.abi, pArt.evm.bytecode.object, signer).deploy(address);
    await p.waitForDeployment();
    protection = await p.getAddress();
    const shop2 = new ethers.Wallet(key("shop2")).address;
    await (await c.addPartner(shop2, "Second Opinion Jewelers", "Atlanta")).wait();
    await (await signer.sendTransaction({ to: shop2, value: ethers.parseUnits("5", 18) })).wait();
    if (process.env.NO_SPECIALISTS !== "1") {
      const plan = [["shop", "watches", "Certified watchmaker, 20 years at the bench"], ["shop", "jewelry", "GIA-trained jewelry buyer, tests gold and stones in store"],
        ["shop2", "watches", "Certified watchmaker (WOSTEP)"], ["shop2", "vintage-watches", "Vintage watch restorer, movements and dials"], ["shop2", "jewelry", "Graduate gemologist (GIA)"]];
      for (const [h, cat, cred] of plan) await (await p.setSpecialist(new ethers.Wallet(key(h)).address, ethers.encodeBytes32String(cat), true, cred)).wait();
    }
  }
  const accounts = await provider.send("eth_accounts", []);
  const initial = server.provider.getInitialAccounts();
  fs.writeFileSync(path.join(__dirname, ".devchain.json"), JSON.stringify({ address, protection, funder: accounts[0], adminKey: initial[accounts[0].toLowerCase()].secretKey }));
  console.log("devchain v3 ready", address, "protection", protection);
})();
