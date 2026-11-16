// Every button in the app ends up here: check the input, pre-flight the call
// against the contract (so errors come back as plain sentences), then ask the
// signed-in member's managed wallet to send it.
import { createHash } from "crypto";
import { ethers } from "ethers";
import { CFG, RULES } from "./config";
import { contract, iface, rpc } from "./chain";
import { q } from "./db";
import { UserError } from "./errors";
import { getUser, treasury, type User } from "./users";
import { wallets } from "./wallets";

export { UserError };
const DEPOSIT_BPS = 1000n;
const BOND_BPS = 500n;
const MAX_PHOTO_BYTES = 400_000;

const text = (v: unknown, max: number, field: string, required = false): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw new UserError(`Please fill in ${field}.`);
  if (s.length > max) throw new UserError(`${field} is too long.`);
  return s;
};
const posInt = (v: unknown, what = "item"): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UserError(`That ${what} doesn't exist.`);
  return n;
};
const priceWei = (v: unknown): bigint => {
  const n = Number(v);
  if (!(n > 0) || n > 1_000_000) throw new UserError("Please enter a price above $0.");
  return ethers.parseUnits(n.toFixed(2), 18);
};

const ZERO = /^0x0{40}$/i;
const sameAddr = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

/** A piece counts as verified when a partner authenticated it after it last changed hands. */
async function verifiedBy(id: number): Promise<{ item: any; fresh: boolean }> {
  const c = contract();
  const [item, hist] = await Promise.all([c.getItem(id), c.getHistory(id)]);
  const lastMove = hist.length ? Number(hist[hist.length - 1][3]) : 0;
  return { item, fresh: !ZERO.test(item.authBy) && Number(item.authAt) >= lastMove };
}

/** Requests and flags are notes between people, so they live in the database. */
async function offChain(user: User, action: string, body: any) {
  if (action === "flag" || action === "unflag") {
    const id = posInt(body.id);
    const item = await contract().getItem(id);
    if (sameAddr(item.owner, user.address)) throw new UserError("You can't flag your own listing.");
    if (action === "flag") {
      await q("insert into flags (item_id, handle, reason) values ($1,$2,$3) on conflict do nothing", [id, user.handle, text(body.reason, 120, "the reason") || "Looks off"]);
    } else {
      await q("delete from flags where item_id = $1 and handle = $2", [id, user.handle]);
    }
    return { hash: null, fee: null, id };
  }
  if (action === "clearFlags") {
    // The pawn shop that stands behind the listing reviews it and clears the flags.
    const id = posInt(body.id);
    const item = await contract().getItem(id);
    if (!sameAddr(item.partner, user.address) && !sameAddr(item.authBy, user.address)) throw new UserError("Only the pawn shop behind this piece can clear its flags.");
    await q("delete from flags where item_id = $1", [id]);
    return { hash: null, fee: null, id };
  }

  const id = posInt(body.id);
  const { item, fresh } = await verifiedBy(id);
  if (action === "requestAuth") {
    if (!sameAddr(item.owner, user.address)) throw new UserError("Only the owner can ask for authentication.");
    if (Number(item.status) !== 0) throw new UserError("This piece is already in a sale.");
    if (fresh) throw new UserError("This piece is already authenticated.");
    if (!ethers.isAddress(body.partner)) throw new UserError("Please choose a pawn shop.");
    const p = await contract().partners(body.partner);
    if (!p.active) throw new UserError("That pawn shop isn't approved.");
    if (sameAddr(body.partner, user.address)) throw new UserError("You can't authenticate your own piece.");
    await q(
      `insert into auth_requests (item_id, requested_by, owner_address, partner_address, status, note, created_at, decided_at)
       values ($1,$2,$3,$4,'pending',null,now(),null)
       on conflict (item_id) do update set requested_by = excluded.requested_by, owner_address = excluded.owner_address,
         partner_address = excluded.partner_address, status = 'pending', note = null, created_at = now(), decided_at = null`,
      [id, user.handle, user.address.toLowerCase(), String(body.partner).toLowerCase()]);
  } else if (action === "cancelAuthRequest") {
    if (!sameAddr(item.owner, user.address)) throw new UserError("Only the owner can cancel this request.");
    await q("delete from auth_requests where item_id = $1 and status = 'pending'", [id]);
  } else {
    const rows = await q("select partner_address from auth_requests where item_id = $1 and status = 'pending'", [id]);
    if (!rows[0] || !sameAddr(rows[0].partner_address, user.address)) throw new UserError("There's no open request for you on this piece.");
    await q("update auth_requests set status = 'declined', note = $2, decided_at = now() where item_id = $1",
      [id, text(body.reason, 120, "the reason") || "Could not be verified."]);
  }
  return { hash: null, fee: null, id };
}

async function savePhoto(dataUrl: unknown, handle: string): Promise<string | null> {
  if (typeof dataUrl !== "string" || !dataUrl) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new UserError("Couldn't use that photo. Try a JPG or PNG.");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > MAX_PHOTO_BYTES) throw new UserError("That photo is too large.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await q("insert into photos (hash, mime, bytes, uploaded_by) values ($1,$2,$3,$4) on conflict (hash) do nothing", [hash, m[1], bytes, handle]);
  return hash;
}

const OFF_CHAIN = new Set(["requestAuth", "cancelAuthRequest", "declineAuth", "flag", "unflag", "clearFlags"]);

/** Send one contract call from a member's wallet, after a pre-flight check. */
export async function send(user: User, fn: string, args: any[], value = 0n) {
  const callData = iface.encodeFunctionData(fn, args);
  // Pre-flight: a failing call is rejected here with the contract's own reason, before any wallet is asked to sign.
  await rpc().call({ from: user.address, to: CFG.contract, data: callData, value });
  return wallets().execute(user, CFG.contract, callData, value);
}

export async function perform(user: User, action: string, body: any) {
  if (OFF_CHAIN.has(action)) return offChain(user, action, body);
  if (user.role === "treasury") throw new UserError("The treasury can't do that.");
  const c = contract();
  let fn: string, args: any[], value = 0n, id: number | null = null;
  const detail: Record<string, any> = {};

  switch (action) {
    case "createPassport": {
      const name = text(body.name, 60, "the name", true);
      const hash = await savePhoto(body.photo, user.handle);
      const icon = /^[a-z]{1,12}$/.test(body.icon ?? "") ? body.icon : "other";
      // Photos live in the database; their SHA-256 fingerprint goes on-chain so anyone can verify the photo.
      fn = "createPassport"; args = [name, text(body.brand, 40, "the brand"), text(body.details, 80, "the details"), hash ? `sha256:${hash};kind=${icon}` : `icon:${icon}`];
      detail.name = name;
      break;
    }
    case "list": {
      id = posInt(body.id);
      const price = priceWei(body.price);
      // Authentication comes before listing, and the pawn shop that vouched for the piece stands behind the sale.
      const v = await verifiedBy(id);
      if (!v.fresh) throw new UserError("This piece needs to be authenticated before it can be listed.");
      value = (price * DEPOSIT_BPS) / 10000n;
      fn = "listForSale"; args = [id, price, v.item.authBy];
      detail.price = price.toString();
      break;
    }
    case "buy": {
      id = posInt(body.id);
      const [{ n }] = await q("select count(*)::int as n from flags where item_id = $1", [id]);
      if (n >= RULES.flagsToPause) throw new UserError("This listing is paused while the pawn shop reviews flags from members.");
      const it = await c.getItem(id);
      value = it.price;
      fn = "buy"; args = [id];
      detail.price = value.toString();
      break;
    }
    case "dispute": {
      id = posInt(body.id);
      const it = await c.getItem(id);
      value = (BigInt(it.price) * BOND_BPS) / 10000n;
      fn = "openDispute"; args = [id, text(body.reason, 160, "the reason", true)];
      detail.bond = value.toString();
      break;
    }
    case "authenticate": {
      id = posInt(body.id);
      const rows = await q("select partner_address from auth_requests where item_id = $1 and status = 'pending'", [id]);
      if (!rows[0] || !sameAddr(rows[0].partner_address, user.address)) throw new UserError("The owner hasn't asked you to authenticate this piece.");
      fn = "authenticate"; args = [id, text(body.note, 120, "the note") || "Inspected in store."];
      break;
    }
    case "verifyMember": {
      const m = await getUser(String(body.member ?? ""));
      if (!m || m.role !== "member") throw new UserError("That member wasn't found.");
      fn = "verifyMember"; args = [m.address];
      detail.member = m.handle;
      break;
    }
    case "vote": {
      const did = posInt(body.did, "dispute");
      fn = "castVote"; args = [did, body.buyerWins === true];
      detail.did = did; detail.buyerWins = body.buyerWins === true;
      id = Number((await c.getDispute(did)).itemId);
      break;
    }
    case "report": {
      const did = posInt(body.did, "dispute");
      fn = "fileReport"; args = [did, text(body.report, 300, "the report", true)];
      detail.did = did;
      id = Number((await c.getDispute(did)).itemId);
      break;
    }
    case "finalize": {
      const did = posInt(body.did, "dispute");
      fn = "finalizeDispute"; args = [did];
      detail.did = did;
      id = Number((await c.getDispute(did)).itemId);
      break;
    }
    case "resolve": {
      const did = posInt(body.did, "dispute");
      fn = "resolveDispute"; args = [did, body.buyerWins === true];
      detail.did = did; detail.buyerWins = body.buyerWins === true;
      id = Number((await c.getDispute(did)).itemId);
      break;
    }
    case "unlist": id = posInt(body.id); fn = "cancelListing"; args = [id]; break;
    case "ship": id = posInt(body.id); fn = "markShipped"; args = [id]; break;
    case "confirm": id = posInt(body.id); fn = "confirmDelivery"; args = [id]; break;
    case "claim": id = posInt(body.id); fn = "sellerClaim"; args = [id]; break;
    case "sellerCancel": id = posInt(body.id); fn = "sellerCancelSale"; args = [id]; break;
    case "buyerCancel": id = posInt(body.id); fn = "buyerCancelUnshipped"; args = [id]; break;
    default: throw new UserError("Unknown action.");
  }

  const before = action === "confirm" ? await c.getItem(id!) : null;
  const res = await send(user, fn, args, value);

  if (action === "createPassport") {
    const rc = await rpc().getTransactionReceipt(res.hash);
    for (const log of rc?.logs ?? []) {
      try { const p = iface.parseLog(log); if (p?.name === "PassportCreated") id = Number(p.args.id); } catch { /* other log */ }
    }
  }
  if (action === "authenticate") {
    await q("update auth_requests set status = 'approved', note = $2, decided_at = now() where item_id = $1", [id, args[1]]);
  }
  await q("insert into activity (tx_hash, action, item_id, actor, detail, fee_wei) values ($1,$2,$3,$4,$5,$6)",
    [res.hash, action, id, user.handle, JSON.stringify(detail), res.feeWei?.toString() ?? null]);
  if (before) await afterFirstDelivery(user, before).catch((e) => console.warn("credits", e));
  return { hash: res.hash, fee: res.feeWei?.toString() ?? null, id };
}

/**
 * Invite rewards (store credit, not cash), following Poshmark/eBay practice:
 * on a member's first confirmed delivery, their inviter earns $5 credit, unless
 * the seller is the inviter (self-dealing), up to $100 a year.
 */
async function afterFirstDelivery(buyer: User, item: any) {
  if (!buyer.invitedBy) return;
  const [{ n }] = await q("select count(*)::int as n from activity where actor = $1 and action = 'confirm'", [buyer.handle]);
  if (n !== 1) return;
  const inviter = await getUser(buyer.invitedBy);
  if (!inviter || sameAddr(inviter.address, item.owner)) return;
  const [{ total }] = await q(
    "select coalesce(sum(amount_cents),0)::int as total from credits where handle = $1 and kind = 'invite_reward' and created_at > now() - interval '1 year'", [inviter.handle]);
  if (total + RULES.inviterReward * 100 > RULES.inviterYearlyCap * 100) return;
  await q(`insert into credits (handle, kind, amount_cents, note, expires_at) values ($1,'invite_reward',$2,$3, now() + make_interval(days => $4))`,
    [inviter.handle, RULES.inviterReward * 100, `${buyer.name} completed their first purchase`, RULES.creditDays]);
}

/** Demo money: move test dollars from the platform treasury to the signed-in member. */
export async function fund(user: User, dollars: number) {
  if (![1, 5, 10, 20].includes(dollars)) throw new UserError("Choose $1, $5, $10 or $20.");
  if (user.role === "treasury") throw new UserError("The treasury is funded from the faucet.");
  const t = await treasury();
  const value = ethers.parseUnits(String(dollars), 18);
  const bal = await rpc().getBalance(t.address);
  if (bal < value + ethers.parseUnits("0.05", 18)) throw new UserError("The demo treasury is low. Top it up from the faucet first.");
  const res = await wallets().transfer(t, user.address, value);
  await q("insert into activity (tx_hash, action, actor, detail, fee_wei) values ($1,'fund','treasury',$2,$3)",
    [res.hash, JSON.stringify({ to: user.handle, dollars }), res.feeWei?.toString() ?? null]);
  return { hash: res.hash, fee: res.feeWei?.toString() ?? null };
}
