// Wardrobe Passport — app settings
window.WP_CONFIG = {
  appName: "Wardrobe Passport",

  // Arc Testnet (Circle's stablecoin-native chain; USDC is the native currency)
  chainId: 5042002,
  chainName: "Arc Testnet",
  rpcUrls: [
    "https://rpc.testnet.arc.io",
    "https://rpc.drpc.testnet.arc.io",
    "https://rpc.quicknode.testnet.arc.io",
    "https://rpc.blockdaemon.testnet.arc.io",
  ],
  explorer: "https://explorer.testnet.arc.io",
  faucet: "https://faucet.circle.com",

  // WardrobePassport contract, deployed + verified on Arc Testnet
  contractAddress: "0x5627949F0F72404DecCABcd639A48cbea243B1F0",

  // How often the app refreshes from the chain (ms)
  refreshMs: 8000,
};

// Local testing only: ?dev=1&rpc=http://127.0.0.1:8545&contract=0x...
(function () {
  const q = new URLSearchParams(location.search);
  if (q.get("dev") !== "1") return;
  if (q.get("rpc")) window.WP_CONFIG.rpcUrls = [q.get("rpc")];
  if (q.get("contract")) window.WP_CONFIG.contractAddress = q.get("contract");
  if (q.get("chainId")) window.WP_CONFIG.chainId = Number(q.get("chainId"));
  window.WP_CONFIG.dev = true;
})();
