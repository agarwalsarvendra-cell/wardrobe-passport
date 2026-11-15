// Server-side settings, read from environment variables.
export const CFG = {
  chainId: Number(process.env.ARC_CHAIN_ID ?? 5042002),
  chainName: "Arc Testnet",
  circleBlockchain: "ARC-TESTNET",
  rpcUrl: process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io",
  contract: process.env.CONTRACT_ADDRESS ?? "",
  explorer: "https://explorer.testnet.arc.io",
  faucet: "https://faucet.circle.com",
  walletProvider: (process.env.WALLET_PROVIDER ?? "local") as "local" | "circle",
};

// The people in the demo. Each gets a managed wallet the first time they are used.
export const DEMO_USERS = [
  { handle: "maya", name: "Maya", role: "member" },
  { handle: "alex", name: "Alex", role: "member" },
  { handle: "shop", name: "Pawn shop", role: "partner", regName: "Demo Pawn Shop", city: "Atlanta" },
  { handle: "treasury", name: "Demo treasury", role: "treasury" },
] as const;
export type Handle = (typeof DEMO_USERS)[number]["handle"];
export const isHandle = (h: unknown): h is Handle => DEMO_USERS.some((u) => u.handle === h);
