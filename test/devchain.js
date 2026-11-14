// Local test chain for the app: starts a chain with Arc's chain id, deploys the
// contract, writes its address to test/.devchain.json, and keeps running.
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const ganache = require("ganache");
const { ethers } = require("ethers");

(async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "contracts", "WardrobePassport.sol"), "utf8");
  const out = JSON.parse(solc.compile(JSON.stringify({
    language: "Solidity",
    sources: { "WardrobePassport.sol": { content: src } },
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris", outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } } },
  })));
  const art = out.contracts["WardrobePassport.sol"].WardrobePassport;

  const server = ganache.server({
    chain: { chainId: 5042002 },
    wallet: { totalAccounts: 3, defaultBalance: 1000 },
    logging: { quiet: true },
  });
  await new Promise((res) => server.listen(8545, res));

  const provider = new ethers.JsonRpcProvider("http://127.0.0.1:8545");
  const signer = await provider.getSigner(0);
  const c = await new ethers.ContractFactory(art.abi, art.evm.bytecode.object, signer).deploy();
  await c.waitForDeployment();
  const address = await c.getAddress();
  const funder = await signer.getAddress();
  fs.writeFileSync(path.join(__dirname, ".devchain.json"), JSON.stringify({ address, funder }));
  console.log("devchain ready", address);
})();
