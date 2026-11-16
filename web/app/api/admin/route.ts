import { ethers } from "ethers";
import { requireAdmin } from "@/lib/auth";
import { send } from "@/lib/actions";
import { contract, rpc } from "@/lib/chain";
import { CFG, SEED_MEMBERS } from "@/lib/config";
import { q } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { safely } from "@/lib/http";
import { allUsers, createMember, ensureSystem, registerOnChain, welcomeGas, type User } from "@/lib/users";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

/** Top a wallet up to at least `dollars` from the treasury (demo gas money). */
async function topUp(u: User, dollars: number) {
  const want = ethers.parseUnits(String(dollars), 18);
  const have = await rpc().getBalance(u.address);
  if (have >= want / 2n) return false;
  await welcomeGas(u, dollars);
  return true;
}

/** The shop checks a member's ID on-chain (setup and seeding only; normally done at the front desk). */
async function shopVerifies(u: User) {
  const shop = await ensureSystem("shop");
  const m = await contract().members(u.address);
  if (m.verifiedBy !== ethers.ZeroAddress) return false;
  const res = await send(shop, "verifyMember", [u.address]);
  await q("insert into activity (tx_hash, action, actor, detail, fee_wei) values ($1,'verifyMember','shop',$2,$3)",
    [res.hash, JSON.stringify({ member: u.handle }), res.feeWei?.toString() ?? null]);
  return true;
}

// Admin setup, run in small steps so each call stays well inside the time limit.
//  setup: demo accounts get wallets; Maya and Alex join on-chain and are ID-checked by the shop.
//  seed:  adds the next community member (invited by Maya or Alex), registered, ID-checked and given gas money.
export async function POST(req: Request) {
  return safely(async () => {
    await requireAdmin();
    const body = await req.json().catch(() => ({}));
    const c = contract();
    const shop = await ensureSystem("shop");
    const p = await c.partners(shop.address);
    if (!p.active) throw new UserError("Approve the pawn shop first: call addPartner in Remix with the shop's address.");

    if (body.op === "setup") {
      const done: string[] = [];
      for (const h of ["treasury", "maya", "alex"]) await ensureSystem(h);
      if (await topUp(shop, 1)) done.push("Shop given $1 for network fees");
      for (const h of ["maya", "alex"]) {
        const u = await ensureSystem(h);
        await registerOnChain(u);
        if (await shopVerifies(u)) done.push(`${u.name}'s ID checked by the shop`);
        if (await topUp(u, 5)) done.push(`${u.name} given $5 of test money`);
      }
      return { done, message: done.length ? done.join(". ") + "." : "Demo accounts were already set up." };
    }

    if (body.op === "seed") {
      const users = await allUsers();
      const have = new Set(users.filter((u) => u.seeded).map((u) => u.name));
      const next = SEED_MEMBERS.filter((n) => !have.has(n)).slice(0, 1);
      // Finish anyone half set up (e.g. a call that timed out) before adding more.
      const work: User[] = [];
      for (const u of users.filter((x) => x.seeded)) {
        if (work.length) break;
        if (!u.onchain || (await c.members(u.address)).verifiedBy === ethers.ZeroAddress) work.push(u);
      }
      for (const name of next) {
        if (work.length >= 1) break;
        const inviter = (SEED_MEMBERS.indexOf(name) % 2) ? "alex" : "maya";
        work.push(await createMember({ name, email: null, invitedBy: inviter, seeded: true }));
      }
      for (const u of work) {
        await registerOnChain(u);
        await shopVerifies(u);
        await topUp(u, 0.5);
      }
      const total = (await allUsers()).filter((u) => u.seeded && u.onchain).length;
      return { added: work.map((u) => u.name), total, remaining: SEED_MEMBERS.length - total };
    }
    throw new UserError("Unknown request.");
  });
}
