// Server-side settings, read from environment variables.
export const CFG = {
  chainId: Number(process.env.ARC_CHAIN_ID ?? 5042002),
  chainName: "Arc Testnet",
  circleBlockchain: "ARC-TESTNET",
  rpcUrl: process.env.ARC_RPC_URL ?? "https://rpc.testnet.arc.io",
  contract: process.env.CONTRACT_ADDRESS ?? "",
  // WardrobeProtection (bonded authentication + risk-priced cover). Empty: every protection screen stays hidden.
  protection: process.env.PROTECTION_ADDRESS ?? "",
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
  { handle: "shop", name: "Demo Pawn Shop", role: "partner", demo: "Authenticator", city: "Atlanta" },
  { handle: "shop2", name: "Second Opinion Jewelers", role: "partner", demo: "Second authenticator", city: "Atlanta" },
  { handle: "treasury", name: "Platform treasury", role: "treasury" },
] as const;

// Community members seeded for the demo so the ledger and dispute panels have real people.
export const SEED_MEMBERS = ["Priya", "Jordan", "Sam", "Elena", "Marcus", "Aisha", "Tom", "Grace", "Diego", "Kofi"];
/** Who invited each seeded member: the first ones by Maya or Alex, later ones by earlier members, so the invite tree looks real. */
export const SEED_INVITER: Record<string, string> = {
  Priya: "maya", Jordan: "maya", Sam: "alex", Elena: "alex", Marcus: "Priya",
  Aisha: "Jordan", Tom: "Sam", Grace: "Priya", Diego: "Elena", Kofi: "Marcus",
};

/** Categories in the protection contract (bytes32 keys). The icon is used when a piece has no photo. */
export const CATEGORIES = [
  { key: "watches", name: "Watches", icon: "watch" },
  { key: "vintage-watches", name: "Vintage watches", icon: "watch" },
  { key: "jewelry", name: "Jewelry", icon: "ring" },
  { key: "handbags", name: "Handbags", icon: "bag" },
] as const;

/** Which partner is approved for which category, and why. The admin approves these on the protection contract. */
export const SPECIALIST_PLAN = [
  { shop: "shop", category: "watches", credential: "Certified watchmaker, 20 years at the bench" },
  { shop: "shop", category: "jewelry", credential: "GIA-trained jewelry buyer, tests gold and stones in store" },
  { shop: "shop2", category: "watches", credential: "Certified watchmaker (WOSTEP)" },
  { shop: "shop2", category: "vintage-watches", credential: "Vintage watch restorer, movements and dials" },
  { shop: "shop2", category: "jewelry", credential: "Graduate gemologist (GIA)" },
] as const;

/** Demo history, run by the admin once: real transactions on Arc so the community isn't empty. */
export const SEED_HISTORY = [
  { key: "A", photo: "seiko.jpg", seller: "Priya", buyer: "Jordan", name: "Seiko 5 automatic", brand: "Seiko", details: "SNK809, new strap", icon: "watch", category: "watches", price: 6, end: "confirm" },
  { key: "B", photo: "bangle.jpg", seller: "Sam", buyer: "Elena", name: "Sterling silver bangle", brand: "Tiffany & Co.", details: "With pouch and box", icon: "ring", category: "jewelry", price: 7, end: "confirm" },
  { key: "C", photo: "khaki-field.jpg", seller: "Marcus", buyer: "Aisha", name: "Khaki Field mechanical", brand: "Hamilton", details: "38 mm, box and papers", icon: "watch", category: "watches", price: 5, end: "dispute" },
  { key: "D", photo: "seamaster.jpg", seller: "Grace", buyer: null, name: "Seamaster De Ville (1968)", brand: "Omega", details: "Calibre 565, serviced 2024", icon: "watch", category: "vintage-watches", price: 9, end: "list" },
  { key: "E", photo: "prx.jpg", seller: "Tom", buyer: null, name: "PRX quartz", brand: "Tissot", details: "40 mm, steel bracelet", icon: "watch", category: "watches", price: 6, end: "list" },
  { key: "F", photo: "pearls.jpg", seller: "Kofi", buyer: null, name: "Pearl stud earrings", brand: "Mikimoto", details: "Akoya, 7 mm, with box", icon: "ring", category: "jewelry", price: 0, end: "request" },
  { key: "G", photo: "chain.jpg", seller: "Elena", buyer: null, name: "Gold chain necklace", brand: "Mejuri", details: "14k, 18 inch", icon: "ring", category: "jewelry", price: 5, end: "list" },
  { key: "H", photo: "conquest.jpg", seller: "Diego", buyer: null, name: "Conquest automatic (1972)", brand: "Longines", details: "Original dial and crown", icon: "watch", category: "vintage-watches", price: 8, end: "list" },
  { key: "I", photo: "pendant.jpg", seller: "Jordan", buyer: null, name: "Solitaire pendant", brand: "Blue Nile", details: "0.25 ct, with grading report", icon: "ring", category: "jewelry", price: 7, end: "list" },
  { key: "J", photo: "signet.jpg", seller: "Aisha", buyer: null, name: "Signet ring", brand: "Monica Vinader", details: "Gold vermeil, size 8", icon: "ring", category: "jewelry", price: 4, end: "list" },
  { key: "K", photo: "timex.jpg", seller: "Sam", buyer: null, name: "Expedition field watch", brand: "Timex", details: "Khaki, 38 mm", icon: "watch", category: "watches", price: 4, end: "list" },
  { key: "L", photo: "bracelet.jpg", seller: "Priya", buyer: null, name: "Tennis bracelet", brand: "Pandora", details: "Silver, 7 inch", icon: "ring", category: "jewelry", price: 5, end: "list" },
  { key: "M", photo: "promaster.jpg", seller: "Kofi", buyer: null, name: "Promaster diver", brand: "Citizen", details: "Eco-Drive, 44 mm", icon: "watch", category: "watches", price: 6, end: "list" },
  { key: "N", photo: "gshock.jpg", seller: "Marcus", buyer: null, name: "G-Shock DW-5600", brand: "Casio", details: "Black resin, like new", icon: "watch", category: "watches", price: 2, end: "list" },
  { key: "O", photo: "speedmaster.jpg", seller: "Tom", buyer: null, name: "Speedmaster Professional (1979)", brand: "Omega", details: "Hesalite crystal, calibre 861", icon: "watch", category: "vintage-watches", price: 10, end: "list" },
] as const;

/**
 * Protection demo (Admin → Setup → "Play protection demo"): bonds, a member-funded pool,
 * one covered piece proven fake, one claim rejected as genuine, and one live cover.
 * Prices are small so the demo runs on faucet money.
 */
export const PROTECTION_DEMO = {
  bonds: { shop: 10, shop2: 10 },                  // dollars each authenticator stakes
  stakers: [["Grace", 3], ["Diego", 3], ["Kofi", 3]] as [string, number][],
  sales: [
    // Proven fake: stamped by Demo Pawn Shop, re-inspected by Second Opinion Jewelers.
    { key: "P1", seller: "Tom", buyer: "Grace", shop: "shop", name: "Submariner-style diver", brand: "Unbranded", details: "Sold as a Seiko mod, 40 mm", icon: "watch", category: "watches", price: 4,
      claim: "A watchmaker opened the caseback: the movement is a clone, not the one listed.", fake: true, ruling: "Movement is a copy of the NH35. Not what was authenticated. Fake." },
    // Rejected claim: stamped by Second Opinion Jewelers, Demo Pawn Shop rules it genuine.
    { key: "P2", seller: "Elena", buyer: "Diego", shop: "shop2", name: "Gold hoop earrings", brand: "Mejuri", details: "14k solid gold", icon: "ring", category: "jewelry", price: 3,
      claim: "The clasp looks plated to me.", fake: false, ruling: "Acid test and hallmark match 14k solid gold. Genuine." },
    // Live cover with days left.
    { key: "P3", seller: "Sam", buyer: "Priya", shop: "shop", name: "Seiko Presage cocktail", brand: "Seiko", details: "SRPB43, 40 mm", icon: "watch", category: "watches", price: 3 },
  ],
} as const;
