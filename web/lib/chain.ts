import { ethers } from "ethers";
import abi from "./abi.json";
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
export function contract(): ethers.Contract {
  if (!ethers.isAddress(CFG.contract)) throw new Error("CONTRACT_ADDRESS is not set.");
  return new ethers.Contract(CFG.contract, abi as any, rpc());
}

const FRIENDLY: Record<string, string> = {
  NotAdmin: "Only the contract's admin can do that.",
  NotOperator: "The platform wallet isn't approved to add members yet.",
  NotOwner: "Only the owner can do that.",
  NotBuyer: "Only the buyer can do that.",
  NotPartner: "Only the pawn shop on this sale can do that.",
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
  InvalidPartner: "That pawn shop isn't approved.",
  PartnerExists: "That pawn shop is already approved.",
  ConflictOfInterest: "A pawn shop can't take part in a sale it stands behind.",
  CannotBuyOwnItem: "You can't buy your own item.",
  OverNewMemberCap: "New members can buy items up to $50. Get your ID checked at a partner shop to lift the limit.",
  TooEarly: "It's too early for that. Check the date shown.",
  TooLate: "Voting on this dispute has closed.",
  PanelDecides: "The community panel is deciding this one.",
  PartnerDecides: "The panel didn't reach a decision, so the pawn shop decides.",
  NothingOwed: "There's nothing to collect.",
  TransferFailed: "The payment couldn't be sent. Please try again.",
  NoSuchItem: "That item doesn't exist.",
  NoSuchDispute: "That dispute doesn't exist.",
};

function revertData(e: any): string | null {
  const c = [e?.data, e?.info?.error?.data, e?.error?.data, e?.info?.error?.data?.data, e?.info?.error?.data?.result];
  return c.find((d) => typeof d === "string" && d.startsWith("0x")) ?? null;
}
/** Turn a contract or network error into a sentence a person can act on. */
export function friendly(e: any): string {
  const data = revertData(e);
  if (data) {
    try {
      const parsed = iface.parseError(data);
      if (parsed && FRIENDLY[parsed.name]) return FRIENDLY[parsed.name];
    } catch { /* not one of ours */ }
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
async function pool<T, R>(list: T[], fn: (x: T) => Promise<R>, n = 8): Promise<R[]> {
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
