// People in the community. Each person has one membership, one managed wallet,
// and an on-chain member record (with who invited them) written by the platform
// treasury, which the contract admin approved as an "operator".
import { randomBytes } from "crypto";
import { ethers } from "ethers";
import { CFG, SYSTEM_USERS } from "./config";
import { contract, iface, rpc } from "./chain";
import { q } from "./db";
import { UserError } from "./errors";
import { wallets, type ManagedWallet } from "./wallets";

export interface User extends ManagedWallet {
  handle: string;
  name: string;
  role: "member" | "partner" | "treasury";
  email: string | null;
  invitedBy: string | null;
  onchain: boolean;
  city: string | null;
  seeded: boolean;
}


const fromRow = (r: any): User => ({
  handle: r.handle, name: r.display_name, role: r.role, walletId: r.wallet_id, address: r.address,
  email: r.email ?? null, invitedBy: r.invited_by ?? null, onchain: !!r.onchain, city: r.city ?? null, seeded: !!r.seeded,
});

export async function getUser(handle: string): Promise<User | null> {
  const rows = await q("select * from users where handle = $1 and wallet_provider = $2", [handle, CFG.walletProvider]);
  return rows[0] ? fromRow(rows[0]) : null;
}
export async function userByEmail(email: string): Promise<User | null> {
  const rows = await q("select * from users where lower(email) = lower($1) and wallet_provider = $2", [email, CFG.walletProvider]);
  return rows[0] ? fromRow(rows[0]) : null;
}
export async function allUsers(): Promise<User[]> {
  return (await q("select * from users where wallet_provider = $1 order by created_at", [CFG.walletProvider])).map(fromRow);
}

const g = globalThis as unknown as { __wpEnsure?: Map<string, Promise<User>> };
const pending = () => (g.__wpEnsure ??= new Map());

/** A built-in account (demo people, pawn shop, treasury): find it or create its wallet. */
export function ensureSystem(handle: string): Promise<User> {
  const def = SYSTEM_USERS.find((u) => u.handle === handle);
  if (!def) throw new UserError("Unknown account.");
  const key = `${CFG.walletProvider}:${handle}`;
  const p = pending();
  if (!p.has(key)) {
    p.set(key, (async () => {
      const found = await getUser(handle);
      if (found) return found;
      const w = await wallets().createWallet(handle);
      await q(
        `insert into users (handle, display_name, role, wallet_provider, wallet_id, address, invited_by, city)
         values ($1,$2,$3,$4,$5,$6,$7,$8)
         on conflict (handle) do update set wallet_provider = excluded.wallet_provider, wallet_id = excluded.wallet_id, address = excluded.address`,
        [handle, def.name, def.role, CFG.walletProvider, w.walletId, w.address, (def as any).invitedBy ?? null, (def as any).city ?? null]);
      return (await getUser(handle))!;
    })().catch((e) => { p.delete(key); throw e; }));
  }
  return p.get(key)!;
}
export const treasury = () => ensureSystem("treasury");

function slug(name: string) {
  const base = name.toLowerCase().replace(/[^a-z0-9]+/g, "").slice(0, 12) || "member";
  return `${base}-${randomBytes(2).toString("hex")}`;
}

/** Write the member record on-chain (with their inviter), once. Inviters are registered first. */
export async function registerOnChain(u: User, depth = 0): Promise<void> {
  if (u.role !== "member" || u.onchain) return;
  const c = contract();
  const m = await c.members(u.address);
  if (Number(m.joinedAt) === 0) {
    let inviterAddr = ethers.ZeroAddress;
    if (u.invitedBy) {
      const inv = await getUser(u.invitedBy);
      if (inv && inv.role === "member") {
        if (depth < 5) await registerOnChain(inv, depth + 1);
        inviterAddr = inv.address;
      }
    }
    const t = await treasury();
    const data = iface.encodeFunctionData("registerMember", [u.address, inviterAddr]);
    try {
      await rpc().call({ from: t.address, to: CFG.contract, data });
    } catch (e: any) {
      const name = (() => { try { return iface.parseError(e?.data ?? e?.info?.error?.data)?.name; } catch { return null; } })();
      if (name === "NotOperator") throw new UserError("The platform wallet isn't approved to add members yet. The admin needs to call setOperator once.");
      throw e;
    }
    const res = await wallets().execute(t, CFG.contract, data, 0n);
    await q("insert into activity (tx_hash, action, actor, detail, fee_wei) values ($1,'registerMember','treasury',$2,$3)",
      [res.hash, JSON.stringify({ member: u.handle, invitedBy: u.invitedBy }), res.feeWei?.toString() ?? null]);
  }
  await q("update users set onchain = true where handle = $1", [u.handle]);
  u.onchain = true;
}

/** Small test-dollar top-up so a new member can pay network fees (demo only). */
export async function welcomeGas(u: User, dollars = CFG.welcomeGasDollars) {
  if (!(dollars > 0)) return;
  const t = await treasury();
  const value = ethers.parseUnits(String(dollars), 18);
  const bal = await rpc().getBalance(t.address);
  if (bal < value + ethers.parseUnits("0.05", 18)) return; // treasury low: skip, the member can add money later
  const res = await wallets().transfer(t, u.address, value);
  await q("insert into activity (tx_hash, action, actor, detail, fee_wei) values ($1,'fund','treasury',$2,$3)",
    [res.hash, JSON.stringify({ to: u.handle, dollars, reason: "welcome" }), res.feeWei?.toString() ?? null]);
}

/** A new member joining through an invite (or a seeded demo member). */
export async function createMember(opts: { name: string; email: string | null; invitedBy: string | null; seeded?: boolean }): Promise<User> {
  const handle = slug(opts.name);
  const w = await wallets().createWallet(handle);
  await q(
    `insert into users (handle, display_name, role, wallet_provider, wallet_id, address, email, invited_by, seeded)
     values ($1,$2,'member',$3,$4,$5,$6,$7,$8)`,
    [handle, opts.name, CFG.walletProvider, w.walletId, w.address, opts.email, opts.invitedBy, !!opts.seeded]);
  return (await getUser(handle))!;
}
