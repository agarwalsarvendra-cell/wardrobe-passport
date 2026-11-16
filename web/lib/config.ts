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
  // Email codes: sent through SMTP when SMTP_URL is set (e.g. smtps://you%40gmail.com:app-password@smtp.gmail.com:465).
  // Without it, the code is shown on screen and the app says so (demo mode).
  smtpUrl: process.env.SMTP_URL ?? "",
  mailFrom: process.env.MAIL_FROM ?? "Wardrobe Passport <no-reply@wardrobe-passport.app>",
  // "Try the demo" accounts for the video. Set DEMO_SIGNIN=off to hide them.
  demoSignin: (process.env.DEMO_SIGNIN ?? "on") !== "off",
  // Test dollars a new member gets for network fees (demo only).
  welcomeGasDollars: Number(process.env.WELCOME_GAS_DOLLARS ?? 1),
};

// Community rules that live in the app (the contract enforces the rest).
export const RULES = {
  startInvites: 3,
  maxOpenInvites: 10,
  welcomeShippingCredit: 10, // dollars: first delivery free, on a first order of $15 or more
  welcomeMinOrder: 15,
  inviterReward: 5,          // dollars of credit after the invitee's first confirmed delivery
  inviterYearlyCap: 100,
  creditDays: 90,
  flagsToPause: 3,
};

// Built-in accounts. Each gets a managed wallet the first time it's used.
// maya/alex/shop are the "Try the demo" accounts; treasury pays for setup and is the contract operator.
export const SYSTEM_USERS = [
  { handle: "maya", name: "Maya", role: "member", demo: "Seller" },
  { handle: "alex", name: "Alex", role: "member", demo: "Buyer", invitedBy: "maya" },
  { handle: "shop", name: "Demo Pawn Shop", role: "partner", demo: "Pawn shop", city: "Atlanta" },
  { handle: "treasury", name: "Platform treasury", role: "treasury" },
] as const;

// Community members seeded for the demo so the ledger and dispute panels have real people.
export const SEED_MEMBERS = [
  "Priya", "Jordan", "Sam", "Elena", "Marcus", "Aisha", "Tom", "Grace", "Diego", "Hannah", "Kofi", "Lena",
];
