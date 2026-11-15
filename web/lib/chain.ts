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
  NotAdmin: "Only the account that deployed the contract can approve partners.",
  NotOwner: "Only the owner can do that.",
  NotBuyer: "Only the buyer can do that.",
  NotPartner: "Only the partner on this sale can do that.",
  WrongStatus: "This item just changed. The page has been refreshed.",
  WrongAmount: "The amount changed. The page has been refreshed.",
  InvalidPrice: "Please enter a price above $0.",
  InvalidPartner: "That partner isn't approved.",
  PartnerExists: "That partner is already approved.",
  ConflictOfInterest: "A partner can't be the seller or buyer on a sale they stand behind.",
  CannotBuyOwnItem: "You can't buy your own item.",
  TooEarly: "It's too early for that. Check the date shown on the order.",
  NothingOwed: "There's nothing to collect.",
  TransferFailed: "The payment couldn't be sent. Please try again.",
  NoSuchItem: "That item doesn't exist.",
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
  const msg = `${e?.shortMessage ?? ""} ${e?.message ?? ""}`.toLowerCase();
  if (e?.code === "INSUFFICIENT_FUNDS" || msg.includes("insufficient funds") || msg.includes("insufficient balance")) {
    return "Not enough test dollars. Tap “Add money” and try again.";
  }
  if (msg.includes("circle is not configured")) return "Wallets aren't set up yet on the server.";
  return "Something went wrong. Please try again.";
}

const big = (v: bigint) => v.toString();

/** Everything the screens need, read straight from Arc. BigInts travel as strings. */
export async function readState(addresses: string[]) {
  const c = contract();
  const [countRaw, partnerAddrs] = await Promise.all([c.itemCount(), c.getPartners()]);
  const ids = Array.from({ length: Number(countRaw) }, (_, i) => i + 1);
  const [rows, hists, partnerRows, bals] = await Promise.all([
    Promise.all(ids.map((id) => c.getItem(id))),
    Promise.all(ids.map((id) => c.getHistory(id))),
    Promise.all((partnerAddrs as string[]).map((a) => c.partners(a))),
    Promise.all(addresses.map((a) => rpc().getBalance(a))),
  ]);
  const items = rows.map((r: any, i: number) => ({
    id: ids[i], name: r.name, brand: r.brand, details: r.details, imageUrl: r.imageUrl,
    owner: r.owner, buyer: r.buyer, partner: r.partner, authBy: r.authBy,
    price: big(r.price), deposit: big(r.deposit),
    paidAt: Number(r.paidAt), shippedAt: Number(r.shippedAt), authAt: Number(r.authAt),
    status: Number(r.status), authNote: r.authNote, disputeReason: r.disputeReason,
  }));
  const histories: Record<number, any[]> = {};
  hists.forEach((h: any, i: number) => {
    histories[ids[i]] = h.map((t: any) => ({ from: t[0], to: t[1], price: big(t[2]), at: Number(t[3]) }));
  });
  const partners = partnerRows.map((p: any, i: number) => ({
    addr: (partnerAddrs as string[])[i], name: p.name, city: p.city, active: p.active,
    authenticated: Number(p.authenticated), disputesResolved: Number(p.disputesResolved),
  }));
  const people = new Set(addresses.map((a) => a.toLowerCase()));
  for (const it of items) { people.add(it.owner.toLowerCase()); if (!/^0x0{40}$/.test(it.buyer)) people.add(it.buyer.toLowerCase()); }
  const list = [...people];
  const recRows = await Promise.all(list.map((a) => c.records(a)));
  const records: Record<string, any> = {};
  recRows.forEach((r: any, i: number) => {
    records[list[i]] = { sold: Number(r.sold), bought: Number(r.bought), refundsGiven: Number(r.refundsGiven), disputesWon: Number(r.disputesWon), disputesLost: Number(r.disputesLost) };
  });
  const balances: Record<string, string> = {};
  addresses.forEach((a, i) => (balances[a.toLowerCase()] = big(bals[i])));
  return { items, histories, partners, records, balances };
}
