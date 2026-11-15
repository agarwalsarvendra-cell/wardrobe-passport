// Every button in the app ends up here: check the input, pre-flight the call
// against the contract (so errors come back as plain sentences), then ask the
// user's managed wallet to send it.
import { createHash } from "crypto";
import { ethers } from "ethers";
import { CFG, type Handle } from "./config";
import { contract, iface, rpc } from "./chain";
import { q } from "./db";
import { ensureUser } from "./users";
import { wallets } from "./wallets";

export class UserError extends Error {}
const DEPOSIT_BPS = 1000n;
const MAX_PHOTO_BYTES = 400_000;

const text = (v: unknown, max: number, field: string, required = false): string => {
  const s = typeof v === "string" ? v.trim() : "";
  if (required && !s) throw new UserError(`Please fill in ${field}.`);
  if (s.length > max) throw new UserError(`${field} is too long.`);
  return s;
};
const itemId = (v: unknown): number => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw new UserError("That item doesn't exist.");
  return n;
};
const priceWei = (v: unknown): bigint => {
  const n = Number(v);
  if (!(n > 0) || n > 1_000_000) throw new UserError("Please enter a price above $0.");
  return ethers.parseUnits(n.toFixed(2), 18);
};

async function savePhoto(dataUrl: unknown, handle: Handle): Promise<string | null> {
  if (typeof dataUrl !== "string" || !dataUrl) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(dataUrl);
  if (!m) throw new UserError("Couldn't use that photo. Try a JPG or PNG.");
  const bytes = Buffer.from(m[2], "base64");
  if (bytes.length > MAX_PHOTO_BYTES) throw new UserError("That photo is too large.");
  const hash = createHash("sha256").update(bytes).digest("hex");
  await q("insert into photos (hash, mime, bytes, uploaded_by) values ($1,$2,$3,$4) on conflict (hash) do nothing", [hash, m[1], bytes, handle]);
  return hash;
}

export async function perform(handle: Handle, action: string, body: any) {
  const user = await ensureUser(handle);
  const c = contract();
  let fn: string, args: any[], value = 0n, id: number | null = null;
  const detail: Record<string, any> = {};

  switch (action) {
    case "createPassport": {
      const name = text(body.name, 60, "the name", true);
      const hash = await savePhoto(body.photo, handle);
      const icon = /^[a-z]{1,12}$/.test(body.icon ?? "") ? body.icon : "other";
      // Photos live in the database; their SHA-256 fingerprint goes on-chain so anyone can verify the photo.
      fn = "createPassport"; args = [name, text(body.brand, 40, "the brand"), text(body.details, 80, "the details"), hash ? `sha256:${hash}` : `icon:${icon}`];
      detail.name = name;
      break;
    }
    case "list": {
      id = itemId(body.id);
      const price = priceWei(body.price);
      if (!ethers.isAddress(body.partner)) throw new UserError("Please choose a partner.");
      value = (price * DEPOSIT_BPS) / 10000n;
      fn = "listForSale"; args = [id, price, body.partner];
      detail.price = price.toString();
      break;
    }
    case "buy": {
      id = itemId(body.id);
      const it = await c.getItem(id);
      value = it.price;
      fn = "buy"; args = [id];
      detail.price = value.toString();
      break;
    }
    case "dispute": id = itemId(body.id); fn = "openDispute"; args = [id, text(body.reason, 160, "the reason", true)]; break;
    case "authenticate": id = itemId(body.id); fn = "authenticate"; args = [id, text(body.note, 120, "the note") || "Inspected in store."]; break;
    case "resolve": id = itemId(body.id); fn = "resolveDispute"; args = [id, body.buyerWins === true]; detail.buyerWins = body.buyerWins === true; break;
    case "unlist": id = itemId(body.id); fn = "cancelListing"; args = [id]; break;
    case "ship": id = itemId(body.id); fn = "markShipped"; args = [id]; break;
    case "confirm": id = itemId(body.id); fn = "confirmDelivery"; args = [id]; break;
    case "claim": id = itemId(body.id); fn = "sellerClaim"; args = [id]; break;
    case "sellerCancel": id = itemId(body.id); fn = "sellerCancelSale"; args = [id]; break;
    case "buyerCancel": id = itemId(body.id); fn = "buyerCancelUnshipped"; args = [id]; break;
    default: throw new UserError("Unknown action.");
  }

  const callData = iface.encodeFunctionData(fn, args);
  // Pre-flight: a failing call is rejected here with the contract's own reason, before any wallet is asked to sign.
  await rpc().call({ from: user.address, to: CFG.contract, data: callData, value });
  const res = await wallets().execute(user, CFG.contract, callData, value);

  if (action === "createPassport") {
    const rc = await rpc().getTransactionReceipt(res.hash);
    for (const log of rc?.logs ?? []) {
      try { const p = iface.parseLog(log); if (p?.name === "PassportCreated") id = Number(p.args.id); } catch { /* other log */ }
    }
  }
  await q("insert into activity (tx_hash, action, item_id, actor, detail, fee_wei) values ($1,$2,$3,$4,$5,$6)",
    [res.hash, action, id, handle, JSON.stringify(detail), res.feeWei?.toString() ?? null]);
  return { hash: res.hash, fee: res.feeWei?.toString() ?? null, id };
}

/** Demo money: move test dollars from the demo treasury wallet to a demo person. */
export async function fund(handle: Handle, dollars: number) {
  if (![1, 5, 10, 20].includes(dollars)) throw new UserError("Choose $1, $5, $10 or $20.");
  if (handle === "treasury") throw new UserError("The treasury is funded from the faucet.");
  const [treasury, user] = await Promise.all([ensureUser("treasury"), ensureUser(handle)]);
  const value = ethers.parseUnits(String(dollars), 18);
  const bal = await rpc().getBalance(treasury.address);
  if (bal < value + ethers.parseUnits("0.05", 18)) throw new UserError("The demo treasury is low. Top it up from the faucet first.");
  const res = await wallets().transfer(treasury, user.address, value);
  await q("insert into activity (tx_hash, action, actor, detail, fee_wei) values ($1,'fund','treasury',$2,$3)",
    [res.hash, JSON.stringify({ to: handle, dollars }), res.feeWei?.toString() ?? null]);
  return { hash: res.hash, fee: res.feeWei?.toString() ?? null };
}
