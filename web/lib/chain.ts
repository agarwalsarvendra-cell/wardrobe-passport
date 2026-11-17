import { ethers } from "ethers";
import abi from "./abi.json";
import pabi from "./protectionAbi.json";
import { CFG } from "./config";

const g = globalThis as unknown as { __wpRpc?: ethers.JsonRpcProvider };

export function rpc(): ethers.JsonRpcProvider {
  if (!g.__wpRpc) {
    const network = new ethers.Network(CFG.chainName, CFG.chainId);
    // cacheTimeout -1: always read fresh balances and status
    g.__wpRpc = new ethers.JsonRpcProvider(CFG.rpcUrl, network, { staticNetwork: network, batchMaxCount: 1, cacheTimeout: -1 });
  }
  return g.__wpRpc;
}
export const iface = new ethers.Interface(abi as any);
export const piface = new ethers.Interface(pabi as any);
export function contract(): ethers.Contract {
  if (!ethers.isAddress(CFG.contract)) throw new Error("CONTRACT_ADDRESS is not set.");
  return new ethers.Contract(CFG.contract, abi as any, rpc());
}
/** True when PROTECTION_ADDRESS is set. Every protection screen and action checks this. */
export const protectionOn = () => ethers.isAddress(CFG.protection);
export function protection(): ethers.Contract {
  if (!protectionOn()) throw new Error("PROTECTION_ADDRESS is not set.");
  return new ethers.Contract(CFG.protection, pabi as any, rpc());
}
export const catKey = (k: string) => ethers.encodeBytes32String(k);
export const catName = (b: string) => { try { return ethers.decodeBytes32String(b); } catch { return ""; } };

const FRIENDLY: Record<string, string> = {
  NotAdmin: "Only the contract's admin can do that.",
  NotOperator: "The platform wallet isn't approved to add members yet.",
  NotOwner: "Only the owner can do that.",
  NotBuyer: "Only the buyer can do that.",
  NotPartner: "Only an approved authenticator can do that.",
  NotMember: "Only community members can do that.",
  NotVerified: "Your ID needs to be checked at a partner shop before you can sell.",
  NotOnPanel: "You're not on the panel for this dispute.",
  AlreadyMember: "That person is already a member.",
  AlreadyVerified: "That member's ID has already been checked.",
  AlreadyVoted: "You've already voted on this dispute.",
  InvalidInviter: "That invite isn't valid.",
  WrongStatus: "This just changed. The page has been refreshed.",
  WrongAmount: "The amount changed. The page has been refreshed.",
  InvalidPrice: "Please enter a price above $0.",
  InvalidPartner: "That authenticator isn't approved.",
  PartnerExists: "That authenticator is already approved.",
  ConflictOfInterest: "An authenticator can't take part in a sale it stands behind.",
  CannotBuyOwnItem: "You can't buy your own item.",
  OverNewMemberCap: "New members can buy items up to $50. Get your ID checked at a partner shop to lift the limit.",
  TooEarly: "It's too early for that. Check the date shown.",
  TooLate: "Voting on this dispute has closed.",
  PanelDecides: "The community panel is deciding this one.",
  PartnerDecides: "The panel didn't reach a decision, so the authenticator decides.",
  NothingOwed: "There's nothing to collect.",
  TransferFailed: "The payment couldn't be sent. Please try again.",
  NoSuchItem: "That item doesn't exist.",
  NoSuchDispute: "That dispute doesn't exist.",
  // Protection contract
  NotSpecialist: "That authenticator isn't approved for this category.",
  NotCertified: "This piece wasn't certified by a specialist, so it can't be protected.",
  NoSuchCategory: "That category isn't open.",
  InSale: "The piece is in a sale right now. Try again after it settles.",
  NotReviewer: "Only a second specialist in this category can rule on this claim.",
  NotInSale: "Protection can only be added while your payment is held.",
  NotAuthenticated: "This piece hasn't been authenticated.",
  AlreadyCovered: "This purchase is already protected.",
  WrongState: "This just changed. The page has been refreshed.",
  ShopBondTooLow: "The authenticator's bond can't cover this piece right now.",
  PoolTooSmall: "The protection pool is too small for this piece right now.",
  FundsLocked: "That money is held behind live protection and can't be withdrawn yet.",
  NotDelivered: "Protection starts once the sale completes.",
  StillInSale: "The sale is still going.",
  CoverEnded: "The 90 days of protection have ended.",
  NotExpired: "This protection hasn't ended yet.",
  NoLongerOwner: "You can only claim on a piece you still own and haven't put back on sale.",
  NoSuchCover: "That protection doesn't exist.",
  InvalidRate: "That rate is outside 1% to 20%.",
};

function revertData(e: any): string | null {
  const c = [e?.data, e?.info?.error?.data, e?.error?.data, e?.info?.error?.data?.data, e?.info?.error?.data?.result];
  return c.find((d) => typeof d === "string" && d.startsWith("0x")) ?? null;
}
/** Turn a contract or network error into a sentence a person can act on. */
export function friendly(e: any): string {
  const data = revertData(e);
  if (data) {
    for (const f of [iface, piface]) {
      try {
        const parsed = f.parseError(data);
        if (parsed && FRIENDLY[parsed.name]) return FRIENDLY[parsed.name];
      } catch { /* not one of ours */ }
    }
  }
  const msg = `${e?.shortMessage ?? ""} ${e?.message ?? ""} ${e?.info?.error?.message ?? ""} ${e?.error?.message ?? ""}`.toLowerCase();
  if (e?.code === "INSUFFICIENT_FUNDS" || msg.includes("insufficient funds") || msg.includes("insufficient balance")) {
    return "Not enough test dollars. Tap “Add money” and try again.";
  }
  if (msg.includes("circle is not configured")) return "Wallets aren't set up yet on the server.";
  return "Something went wrong. Please try again.";
}

const big = (v: bigint) => v.toString();
const ZERO = /^0x0{40}$/i;

/** Limit parallel RPC calls so a public node doesn't rate-limit us. */
export async function pool<T, R>(list: T[], fn: (x: T) => Promise<R>, n = 8): Promise<R[]> {
  const out: R[] = new Array(list.length);
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, list.length) }, async () => {
    while (i < list.length) { const k = i++; out[k] = await fn(list[k]); }
  }));
  return out;
}

/** Everything the screens need, read straight from Arc. BigInts travel as strings. */
export async function readState(addresses: string[]) {
  const c = contract();
  const [countRaw, disputeCountRaw, partnerAddrs, memberAddrs, adminAddr] = await Promise.all([
    c.itemCount(), c.disputeCount(), c.getPartners(), c.getMembers(), c.admin(),
  ]);
  const ids = Array.from({ length: Number(countRaw) }, (_, i) => i + 1);
  const dids = Array.from({ length: Number(disputeCountRaw) }, (_, i) => i + 1);

  const [rows, hists, partnerRows, memberRows, disputeRows, panels, bals] = await Promise.all([
    pool(ids, (id) => c.getItem(id)),
    pool(ids, (id) => c.getHistory(id)),
    pool(partnerAddrs as string[], (a) => c.partners(a)),
    pool(memberAddrs as string[], (a) => c.members(a)),
    pool(dids, (d) => c.getDispute(d)),
    pool(dids, (d) => c.getPanel(d)),
    pool(addresses, (a) => rpc().getBalance(a)),
  ]);

  const items = rows.map((r: any, i: number) => ({
    id: ids[i], name: r.name, brand: r.brand, details: r.details, imageUrl: r.imageUrl,
    owner: r.owner, buyer: r.buyer, partner: r.partner, authBy: r.authBy,
    price: big(r.price), deposit: big(r.deposit),
    paidAt: Number(r.paidAt), shippedAt: Number(r.shippedAt), authAt: Number(r.authAt),
    status: Number(r.status), authNote: r.authNote, disputeId: Number(r.disputeId),
  }));
  const histories: Record<number, any[]> = {};
  hists.forEach((h: any, i: number) => {
    histories[ids[i]] = h.map((t: any) => ({ from: t[0], to: t[1], price: big(t[2]), at: Number(t[3]) }));
  });
  const partners = partnerRows.map((p: any, i: number) => ({
    addr: (partnerAddrs as string[])[i], name: p.name, city: p.city, active: p.active,
    authenticated: Number(p.authenticated), disputesResolved: Number(p.disputesResolved),
    reportsFiled: Number(p.reportsFiled), membersVerified: Number(p.membersVerified),
  }));
  const members = memberRows.map((m: any, i: number) => ({
    addr: (memberAddrs as string[])[i], invitedBy: ZERO.test(m.invitedBy) ? null : m.invitedBy,
    verifiedBy: ZERO.test(m.verifiedBy) ? null : m.verifiedBy, joinedAt: Number(m.joinedAt), verifiedAt: Number(m.verifiedAt), active: m.active,
  }));

  // Votes: read each panelist's vote (0 none, 1 buyer, 2 seller).
  const voteKeys: [number, string][] = [];
  panels.forEach((p: any, i: number) => (p as string[]).forEach((a) => voteKeys.push([dids[i], a])));
  const voteVals = await pool(voteKeys, ([d, a]) => c.voteOf(d, a));
  const votes: Record<string, number> = {};
  voteKeys.forEach(([d, a], i) => (votes[`${d}:${a.toLowerCase()}`] = Number(voteVals[i])));

  const disputes = disputeRows.map((d: any, i: number) => ({
    id: dids[i], itemId: Number(d.itemId), buyer: d.buyer, seller: d.seller, partner: d.partner, bond: big(d.bond),
    openedAt: Number(d.openedAt), deadline: Number(d.deadline), votesBuyer: Number(d.votesBuyer), votesSeller: Number(d.votesSeller),
    resolved: d.resolved, buyerWon: d.buyerWon, decidedByPanel: d.decidedByPanel, reason: d.reason, report: d.report,
    panel: (panels[i] as string[]).map((a) => ({ addr: a, vote: votes[`${dids[i]}:${a.toLowerCase()}`] ?? 0 })),
  }));

  const people = new Set(addresses.map((a) => a.toLowerCase()));
  for (const m of members) people.add(m.addr.toLowerCase());
  for (const it of items) { people.add(it.owner.toLowerCase()); if (!ZERO.test(it.buyer)) people.add(it.buyer.toLowerCase()); }
  const list = [...people];
  const recRows = await pool(list, (a) => c.records(a));
  const records: Record<string, any> = {};
  recRows.forEach((r: any, i: number) => {
    records[list[i]] = {
      sold: Number(r.sold), bought: Number(r.bought), refundsGiven: Number(r.refundsGiven), disputesWon: Number(r.disputesWon),
      disputesLost: Number(r.disputesLost), votesCast: Number(r.votesCast), votesWithMajority: Number(r.votesWithMajority),
      inviteesDisputesLost: Number(r.inviteesDisputesLost),
    };
  });
  const balances: Record<string, string> = {};
  addresses.forEach((a, i) => (balances[a.toLowerCase()] = big(bals[i])));
  return { admin: adminAddr as string, items, histories, partners, members, disputes, records, balances };
}

// ------------------------------------------------------------- protection
const g2 = globalThis as unknown as { __wpPCache?: { at: number; key: string; data: any } };

/** Categories and specialists change rarely (admin transactions), so they're cached for 20 seconds. */
async function protectionSetup(partnerAddrs: string[]) {
  const key = partnerAddrs.join(",").toLowerCase();
  const c = g2.__wpPCache;
  if (c && c.key === key && Date.now() - c.at < 20_000) return c.data;
  const p = protection();
  const keys: string[] = await p.getCategories();
  const cats = await gentle(keys, (k) => p.categories(k));
  const categories = keys.map((k, i) => ({ key: catName(k), name: cats[i].name, baseBps: Number(cats[i].baseBps), active: cats[i].active }));
  const pairs: [string, string][] = [];
  for (const a of partnerAddrs) for (const k of keys) pairs.push([a, k]);
  const isSpec = await gentle(pairs, ([a, k]) => p.specialistIn(a, k));
  const specPairs = pairs.filter((_, i) => isSpec[i]);
  const creds = await gentle(specPairs, ([a, k]) => p.credentialOf(a, k));
  const specialists: Record<string, Record<string, { credential: string }>> = {};
  specPairs.forEach(([a, k], i) => { (specialists[a.toLowerCase()] ??= {})[catName(k)] = { credential: creds[i] }; });
  const data = { categories, specialists };
  g2.__wpPCache = { at: Date.now(), key, data };
  return data;
}
export const forgetProtectionCache = () => { g2.__wpPCache = undefined; };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A contract revert carries data; anything else (rate limit, timeout, network) is worth another try. */
const isRevert = (e: any) => e?.code === "CALL_EXCEPTION" || !!e?.data || !!e?.info?.error?.data;
async function retry<R>(fn: () => Promise<R>, orNull = false): Promise<R> {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (isRevert(e)) { if (orNull) return null as R; throw e; }
      if (i >= 3) throw e;
      await sleep(250 * (i + 1));
    }
  }
}
const gentle = <T, R>(list: T[], fn: (x: T) => Promise<R>, orNull = false) => pool(list, (x) => retry(() => fn(x), orNull), 4);

const g3 = globalThis as unknown as { __wpProt?: { at: number; data: any } };
/**
 * readProtection, but it never breaks the page: a result is reused for a few seconds
 * (the screens poll), and if Arc refuses the read the last good result is shown.
 */
export async function readProtectionSafe(chain: { items: any[]; partners: any[]; members: any[]; records: Record<string, any> }, people: string[], meta: Record<number, string> = {}) {
  if (!protectionOn()) return null;
  const c = g3.__wpProt;
  if (c && Date.now() - c.at < 4_000) return c.data;
  try {
    const data = await readProtection(chain, people, meta);
    g3.__wpProt = { at: Date.now(), data };
    return data;
  } catch (e) {
    console.error("protection read failed", e);
    return c?.data ?? null;
  }
}
/** After an action, the next read must be fresh. */
export const forgetProtection = () => { g3.__wpProt = undefined; };

const COVER_STATES = ["pending", "active", "claimed", "paid", "rejected", "expired", "void"];

/** Bonds, the pool, covers, quotes and each member's rate, read from the protection contract. */
export async function readProtection(
  chain: { items: any[]; partners: any[]; members: any[]; records: Record<string, any> },
  people: string[],
  meta: Record<number, string> = {},
) {
  if (!protectionOn()) return null;
  const p = protection();
  const partnerAddrs = chain.partners.map((x) => x.addr as string);
  const [setup, countRaw, poolRaw] = await Promise.all([protectionSetup(partnerAddrs), retry(() => p.coverCount()), retry(() => p.poolStats())]);
  // Only pieces added with a category can be certified, so older pieces cost no reads.
  const withCat = chain.items.filter((i) => meta[i.id]);
  const quoteIds = withCat.filter((i) => [1, 2, 3].includes(i.status)).map((i) => i.id as number);
  const ids = withCat.filter((i) => !quoteIds.includes(i.id)).map((i) => i.id as number); // a quote already carries the category
  const coverIds = Array.from({ length: Number(countRaw) }, (_, i) => i + 1);
  const memberAddrs = [...new Set([...chain.members.map((m) => m.addr as string), ...people])];
  const specCats: [string, string][] = [];
  for (const [a, cats] of Object.entries(setup.specialists as Record<string, any>)) for (const k of Object.keys(cats)) specCats.push([a, k]);

  // Few calls, a few at a time, each retried: the public Arc RPC refuses bursts, and one
  // refused call must not take the page down. Everything that can be worked out from
  // the covers and the marketplace records is worked out here instead of read.
  const catOfRest = await gentle(ids, (id) => p.categoryOf(id));
  const quotes = await gentle(quoteIds, (id) => p.quote(id));
  const covers = await gentle(coverIds, (id) => p.getCover(id));
  const shopRows = await gentle(partnerAddrs, (a) => p.shopStats(a));
  const anyStake = BigInt(poolRaw[5]) > 0n;
  const shares: bigint[] = anyStake ? await gentle(memberAddrs, (a) => p.sharesOf(a)) : memberAddrs.map(() => 0n);
  // What a stake is worth = its share of the pool (the same sum as the contract's stakeValue).
  const values = shares.map((sh) => (anyStake ? (sh * BigInt(poolRaw[0])) / BigInt(poolRaw[5]) : 0n));

  // Records the contract keeps as counters, recounted from the covers (state 3 = paid as fake, 4 = rejected).
  const count = (pred: (c: any) => boolean) => covers.filter(pred).length;
  const lcEq = (x: string, y: string) => x.toLowerCase() === y.toLowerCase();
  const fakesSold = memberAddrs.map((a) => count((c) => Number(c.state) === 3 && lcEq(c.seller, a)));
  const rejected = memberAddrs.map((a) => count((c) => Number(c.state) === 4 && lcEq(c.buyer, a)));
  const fakesIn = specCats.map(([a, k]) => count((c) => Number(c.state) === 3 && lcEq(c.shop, a) && catName(c.category) === k));

  // A member's own rate as a seller of a watch (no authenticator part): the contract's rate() formula.
  const watchBase = setup.categories.find((c: any) => c.key === "watches")?.baseBps ?? 300;
  const rec = (a: string | null) => (a ? chain.records[a.toLowerCase()] ?? chain.records[a] : null) ?? {};
  const rates = memberAddrs.map((a, i) => {
    const r = rec(a);
    const sold = Number(r.sold ?? 0);
    let sellerAdj = sold === 0 ? 200 : 0;
    sellerAdj -= Math.min(150, sold * 25);
    sellerAdj += Number(r.disputesLost ?? 0) * 300 + Number(r.refundsGiven ?? 0) * 100 + fakesSold[i] * 500;
    const inviter = chain.members.find((m) => lcEq(m.addr, a))?.invitedBy ?? null;
    const inviterAdj = inviter ? Math.min(300, Number(rec(inviter).inviteesDisputesLost ?? 0) * 100) : 0;
    const feeBps = Math.max(100, Math.min(2000, watchBase + sellerAdj + inviterAdj));
    return { feeBps, base: watchBase, sellerAdj, inviterAdj };
  });
  const catOf = [...catOfRest, ...quotes.map((q: any) => q.category)];
  const catIds = [...ids, ...quoteIds];

  const categoryOf: Record<number, string> = {};
  catOf.forEach((k: string, i: number) => { const n = catName(k); if (n) categoryOf[catIds[i]] = n; });
  const quote: Record<number, any> = {};
  quotes.forEach((q: any, i: number) => {
    quote[quoteIds[i]] = {
      fee: big(q.fee), feeBps: Number(q.feeBps), base: Number(q.base), sellerAdj: Number(q.sellerAdj), inviterAdj: Number(q.inviterAdj),
      shopAdj: Number(q.shopAdj), available: q.available, category: catName(q.category),
    };
  });
  const coverList = covers.map((c: any, i: number) => ({
    id: coverIds[i], itemId: Number(c.itemId), buyer: c.buyer, seller: c.seller, shop: c.shop, amount: big(c.amount), fee: big(c.fee),
    feeBps: Number(c.feeBps), paidAt: Number(c.paidAt), boughtAt: Number(c.boughtAt), deliveredAt: Number(c.deliveredAt),
    shopLock: big(c.shopLock), poolLock: big(c.poolLock), state: COVER_STATES[Number(c.state)] ?? "pending", category: catName(c.category),
    claimedAt: Number(c.claimedAt), claimDeposit: big(c.claimDeposit), reviewer: ZERO.test(c.reviewer) ? null : c.reviewer,
    evidence: c.evidence, ruling: c.ruling,
  }));
  const shops: Record<string, any> = {};
  shopRows.forEach((r: any, i: number) => {
    shops[partnerAddrs[i].toLowerCase()] = { bond: big(r.bond), locked: big(r.locked), free: big(r.free), covered: Number(r.covered), fakes: Number(r.fakes), fakesIn: {} };
  });
  specCats.forEach(([a, k], i) => { if (shops[a]) shops[a].fakesIn[k] = Number(fakesIn[i]); });
  const members: Record<string, any> = {};
  memberAddrs.forEach((a, i) => {
    members[a.toLowerCase()] = { shares: big(shares[i]), value: big(values[i]), fakesSold: fakesSold[i], claimsRejected: rejected[i], rate: rates[i] };
  });
  const [assets, locked, free, fees, paid, totalShares] = poolRaw as any[];
  return {
    address: CFG.protection, categories: setup.categories, specialists: setup.specialists, categoryOf, quote, covers: coverList, shops, members,
    pool: { assets: big(assets), locked: big(locked), free: big(free), fees: big(fees), paid: big(paid), shares: big(totalShares) },
  };
}
