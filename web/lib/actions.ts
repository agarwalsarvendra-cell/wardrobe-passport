// Every button in the app ends up here: check the input, pre-flight the call
// against the contract (so errors come back as plain sentences), then ask the
// signed-in member's managed wallet to send it.
import { createHash } from "crypto";
import { ethers } from "ethers";
import { CATEGORIES, CFG, RULES } from "./config";
import { catKey, contract, forgetProtection, iface, piface, protection, protectionOn, rpc } from "./chain";
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
const CLAIM_DEPOSIT_BPS = 500n;

/** The category a piece was added under (stored with the piece; the specialist certifies it on-chain). */
export async function pieceCategory(id: number): Promise<string | null> {
  const r = await q("select category from piece_meta where item_id = $1", [id]);
  return r[0]?.category ?? null;
}
const dollars = (v: unknown, what: string): bigint => {
  const n = Number(v);
  if (!(n > 0) || n > 100_000) throw new UserError(`Please enter an amount for ${what}.`);
  return ethers.parseUnits(n.toFixed(2), 18);
};
const sameAddr = (a: string, b: string) => !!a && !!b && a.toLowerCase() === b.toLowerCase();

const CONFLICT_MSG = "A jeweler can't check a piece from someone linked to them. Choose another specialist.";
/** Conflict-of-interest check (app level): the partner is the owner, or the partner invited the owner. On-chain enforcement is the next contract version. */
async function linkedTo(owner: string, partner: string): Promise<boolean> {
  if (sameAddr(owner, partner)) return true;
  try {
    const m = await contract().members(owner);
    return !!m.invitedBy && sameAddr(m.invitedBy, partner);
  } catch { return false; }
}

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
    if (!sameAddr(item.partner, user.address) && !sameAddr(item.authBy, user.address)) throw new UserError("Only the authenticator behind this piece can clear its flags.");
    await q("delete from flags where item_id = $1", [id]);
    return { hash: null, fee: null, id };
  }

  const id = posInt(body.id);
  const { item, fresh } = await verifiedBy(id);
  if (action === "requestAuth") {
    if (!sameAddr(item.owner, user.address)) throw new UserError("Only the owner can ask for authentication.");
    if (Number(item.status) !== 0) throw new UserError("This piece is already in a sale.");
    if (fresh) throw new UserError("This piece is already authenticated.");
    if (!ethers.isAddress(body.partner)) throw new UserError("Please choose an authenticator.");
    const p = await contract().partners(body.partner);
    if (!p.active) throw new UserError("That authenticator isn't approved.");
    if (sameAddr(body.partner, user.address)) throw new UserError("You can't authenticate your own piece.");
    if (await linkedTo(item.owner, body.partner)) throw new UserError(CONFLICT_MSG);
    const cat = await pieceCategory(id);
    if (protectionOn() && cat && !(await protection().specialistIn(body.partner, catKey(cat)))) {
      throw new UserError("That authenticator isn't approved for this category. Choose a specialist.");
    }
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
export async function send(user: User, fn: string, args: any[], value = 0n, target: "passport" | "protection" = "passport") {
  const to = target === "protection" ? CFG.protection : CFG.contract;
  const callData = (target === "protection" ? piface : iface).encodeFunctionData(fn, args);
  // Pre-flight: a failing call is rejected here with the contract's own reason, before any wallet is asked to sign.
  await rpc().call({ from: user.address, to, data: callData, value });
  return wallets().execute(user, to, callData, value);
}
const logActivity = (hash: string, action: string, id: number | null, actor: string, detail: any, fee: bigint | null) =>
  q("insert into activity (tx_hash, action, item_id, actor, detail, fee_wei) values ($1,$2,$3,$4,$5,$6)",
    [hash, action, id, actor, JSON.stringify(detail), fee?.toString() ?? null]);

const PROTECTION_ACTIONS = new Set(["stakeBond", "withdrawBond", "poolDeposit", "poolWithdraw", "buyCover", "fileClaim", "decideClaim", "certify"]);

/** Bonds, pool, cover and claims: calls to the protection contract. */
async function protectionAction(user: User, action: string, body: any) {
  if (!protectionOn()) throw new UserError("Protection isn't switched on yet.");
  const P = protection();
  let fn: string, args: any[] = [], value = 0n, id: number | null = null;
  const detail: Record<string, any> = {};
  switch (action) {
    case "stakeBond":
      if (user.role !== "partner") throw new UserError("Only authenticators stake a bond.");
      value = dollars(body.amount, "the bond"); fn = "stakeBond"; detail.amount = value.toString();
      break;
    case "withdrawBond":
      if (user.role !== "partner") throw new UserError("Only authenticators have a bond.");
      args = [dollars(body.amount, "the withdrawal")]; fn = "withdrawBond"; detail.amount = args[0].toString();
      break;
    case "poolDeposit":
      if (user.role !== "member") throw new UserError("Only members fund the pool.");
      value = dollars(body.amount, "your stake"); fn = "depositToPool"; detail.amount = value.toString();
      break;
    case "poolWithdraw": {
      if (user.role !== "member") throw new UserError("Only members fund the pool.");
      const [mine, total, assets] = await Promise.all([P.sharesOf(user.address), P.totalShares(), P.poolAssets()]);
      if (mine === 0n) throw new UserError("You have nothing in the pool.");
      let shares: bigint = mine;
      if (body.amount !== "all") {
        const want = dollars(body.amount, "the withdrawal");
        shares = (want * total + assets - 1n) / assets; // round up so you get at least what you asked for
        if (shares > mine) shares = mine;
      }
      args = [shares]; fn = "withdrawFromPool"; detail.amount = ((shares * assets) / total).toString();
      break;
    }
    case "buyCover": {
      id = posInt(body.id);
      const qt = await P.quote(id);
      if (!qt.available) throw new UserError("Protection isn't available for this piece right now.");
      value = qt.fee; fn = "buyCover"; args = [id];
      detail.fee = value.toString(); detail.feeBps = Number(qt.feeBps);
      break;
    }
    case "fileClaim": {
      const cid = posInt(body.cover, "protection");
      const c = await P.getCover(cid);
      id = Number(c.itemId);
      value = (BigInt(c.amount) * CLAIM_DEPOSIT_BPS) / 10000n;
      fn = "fileClaim"; args = [cid, text(body.evidence, 300, "what you found", true)];
      detail.cover = cid; detail.deposit = value.toString();
      break;
    }
    case "decideClaim": {
      const cid = posInt(body.cover, "protection");
      if (user.role !== "partner") throw new UserError("Only a second authenticator rules on a claim.");
      id = Number((await P.getCover(cid)).itemId);
      fn = "decideClaim"; args = [cid, body.fake === true, text(body.ruling, 300, "your ruling", true)];
      detail.cover = cid; detail.fake = body.fake === true;
      break;
    }
    case "certify": {
      // Certify an already-authenticated piece (e.g. one stamped before the specialist was approved).
      id = posInt(body.id);
      const cat = await pieceCategory(id);
      if (!cat) throw new UserError("This piece has no category.");
      fn = "certify"; args = [id, catKey(cat)]; detail.category = cat;
      break;
    }
    default: throw new UserError("Unknown action.");
  }
  const res = await send(user, fn, args, value, "protection");
  forgetProtection();
  await logActivity(res.hash, action, id, user.handle, detail, res.feeWei);
  return { hash: res.hash, fee: res.feeWei?.toString() ?? null, id };
}

/**
 * When a sale ends, start its 90 days of protection (sale completed) or cancel it
 * and refund the fee (sale cancelled or refunded). The treasury pays the network fee,
 * so nobody has to remember to do it.
 */
export async function settleCover(before: { id: number; buyer: string; paidAt: number }) {
  if (!protectionOn() || ZERO.test(before.buyer) || !before.paidAt) return;
  const P = protection();
  const cid = Number(await P.coverFor(before.id, before.buyer, before.paidAt));
  if (!cid) return;
  if (Number((await P.getCover(cid)).state) !== 0) return; // only pending covers
  const t = await treasury();
  for (const fn of ["activate", "voidCover"]) {
    const data = piface.encodeFunctionData(fn, [cid]);
    try { await rpc().call({ from: t.address, to: CFG.protection, data }); } catch { continue; } // not this one
    const res = await wallets().execute(t, CFG.protection, data, 0n);
    forgetProtection();
    await logActivity(res.hash, fn === "activate" ? "coverActivated" : "coverVoided", before.id, "treasury", { cover: cid }, res.feeWei);
    return;
  }
}

/** After a partner stamps a piece, it certifies the category on the protection contract if it's a specialist there. */
async function certifyAfterAuth(user: User, id: number) {
  if (!protectionOn()) return;
  const cat = await pieceCategory(id);
  if (!cat) return;
  if (!(await protection().specialistIn(user.address, catKey(cat)))) return;
  const res = await send(user, "certify", [id, catKey(cat)], 0n, "protection");
  await logActivity(res.hash, "certify", id, user.handle, { category: cat }, res.feeWei);
}

export async function perform(user: User, action: string, body: any) {
  if (OFF_CHAIN.has(action)) return offChain(user, action, body);
  if (user.role === "treasury") throw new UserError("The treasury can't do that.");
  if (PROTECTION_ACTIONS.has(action)) return protectionAction(user, action, body);
  const c = contract();
  let fn: string, args: any[], value = 0n, id: number | null = null;
  const detail: Record<string, any> = {};

  switch (action) {
    case "createPassport": {
      const name = text(body.name, 60, "the name", true);
      const cat = CATEGORIES.find((c) => c.key === body.category);
      if (protectionOn() && !cat) throw new UserError("Please choose a category.");
      if (cat) detail.category = cat.key;
      const hash = await savePhoto(body.photo, user.handle);
      const icon = /^[a-z]{1,12}$/.test(body.icon ?? "") ? body.icon : cat?.icon ?? "other";
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
      if (n >= RULES.flagsToPause) throw new UserError("This listing is paused while the authenticator reviews flags from members.");
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
      const owner = (await c.getItem(id)).owner;
      if (await linkedTo(owner, user.address)) throw new UserError(CONFLICT_MSG);
      const cat = await pieceCategory(id);
      if (protectionOn() && cat && !(await protection().specialistIn(user.address, catKey(cat)))) {
        throw new UserError("You're not approved as a specialist for this category, so you can't stamp it.");
      }
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
  // Sales that can end with this call: remember which sale it was, to settle its protection afterwards.
  const ENDS = ["confirm", "claim", "sellerCancel", "buyerCancel", "vote", "finalize", "resolve"];
  const sale = ENDS.includes(action) && id ? await c.getItem(id) : null;
  const res = await send(user, fn, args, value);

  if (action === "createPassport") {
    const rc = await rpc().getTransactionReceipt(res.hash);
    for (const log of rc?.logs ?? []) {
      try { const p = iface.parseLog(log); if (p?.name === "PassportCreated") id = Number(p.args.id); } catch { /* other log */ }
    }
    if (id && detail.category) {
      await q("insert into piece_meta (item_id, category, set_by) values ($1,$2,$3) on conflict (item_id) do update set category = excluded.category",
        [id, detail.category, user.handle]);
    }
  }
  if (action === "authenticate") {
    await q("update auth_requests set status = 'approved', note = $2, decided_at = now() where item_id = $1", [id, args[1]]);
  }
  await q("insert into activity (tx_hash, action, item_id, actor, detail, fee_wei) values ($1,$2,$3,$4,$5,$6)",
    [res.hash, action, id, user.handle, JSON.stringify(detail), res.feeWei?.toString() ?? null]);
  forgetProtection();
  if (before) await afterFirstDelivery(user, before).catch((e) => console.warn("credits", e));
  if (action === "authenticate") await certifyAfterAuth(user, id!).catch((e) => console.warn("certify", e));
  if (sale && !ZERO.test(sale.buyer)) {
    await settleCover({ id: id!, buyer: sale.buyer, paidAt: Number(sale.paidAt) }).catch((e) => console.warn("cover", e));
  }
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
