// Writes web/lib/protectionAbi.json from contracts/WardrobeProtection.sol (run after changing the contract).
const fs = require("fs");
const path = require("path");
const solc = require("solc");
const read = (f) => fs.readFileSync(path.join(__dirname, "..", "contracts", f), "utf8");
const out = JSON.parse(solc.compile(JSON.stringify({
  language: "Solidity",
  sources: { "P.sol": { content: read("WardrobeProtection.sol") } },
  settings: { optimizer: { enabled: true, runs: 200 }, outputSelection: { "*": { "*": ["abi"] } } },
})));
const abi = out.contracts["P.sol"].WardrobeProtection.abi;
fs.writeFileSync(path.join(__dirname, "..", "web", "lib", "protectionAbi.json"), JSON.stringify(abi, null, 1) + "\n");
console.log("protectionAbi.json:", abi.length, "entries");
