import { ethers } from "ethers";
import { requireAdmin } from "@/lib/auth";
import { perform, send } from "@/lib/actions";
import { contract, rpc } from "@/lib/chain";
import { SEED_HISTORY, SEED_INVITER, SEED_MEMBERS } from "@/lib/config";
import { q } from "@/lib/db";
import { UserError } from "@/lib/errors";
import { safely } from "@/lib/http";
import { allUsers, createMember, ensureSystem, registerOnChain, welcomeGas, type User } from "@/lib/users";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

const usd = (n: number) => ethers.parseUnits(n.toFixed(2), 18);

/** Make sure a wallet holds at least `dollars` (demo money from the treasury). */
async function ensureFunds(u: User, dollars: number) {
  const have = await rpc().getBalance(u.address);
  const want = usd(dollars);
  if (have >= want) return false;
  const missing = Number(ethers.formatUnits(want - have, 18));
  await welcomeGas(u, Math.ceil((missing + 0.05) * 100) / 100);
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

async function seededByName(): Promise<Record<string, User>> {
  const out: Record<string, User> = {};
  for (const u of await allUsers()) if (u.seeded) out[u.name] = u;
  return out;
}

// ------------------------------------------------------------------ history
// A script of small steps. Progress is saved after each step, so a call that
// runs out of time picks up where it stopped on the next call.
interface Ctx { step: number; items: Record<string, number>; did?: number }

async function loadCtx(): Promise<Ctx> {
  const r = await q("select value from settings where key = 'seed_history'");
  return r[0] ? JSON.parse(r[0].value) : { step: 0, items: {} };
}
const saveCtx = (c: Ctx) =>
  q("insert into settings (key, value) values ('seed_history', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(c)]);

function historySteps(people: Record<string, User>, shop: User): { label: string; run: (c: Ctx) => Promise<void> }[] {
  const steps: { label: string; run: (c: Ctx) => Promise<void> }[] = [];
  for (const h of SEED_HISTORY) {
    const seller = people[h.seller];
    const buyer = h.buyer ? people[h.buyer] : null;
    steps.push({ label: `${h.seller} adds “${h.name}”`, run: async (c) => {
      await ensureFunds(seller, 0.3);
      const r = await perform(seller, "createPassport", { name: h.name, brand: h.brand, details: h.details, icon: h.icon });
      c.items[h.key] = r.id!;
    } });
    steps.push({ label: `${h.seller} asks the shop to authenticate it`, run: async (c) => {
      await perform(seller, "requestAuth", { id: c.items[h.key], partner: shop.address });
    } });
    if (h.end === "request") continue; // left waiting in the shop's queue
    steps.push({ label: `The shop authenticates “${h.name}”`, run: async (c) => {
      await perform(shop, "authenticate", { id: c.items[h.key], note: "Inspected in store: labels, stitching and condition match." });
    } });
    steps.push({ label: `${h.seller} lists it for $${h.price}`, run: async (c) => {
      await ensureFunds(seller, h.price * 0.1 + 0.2);
      await perform(seller, "list", { id: c.items[h.key], price: String(h.price) });
    } });
    if (!buyer) continue; // stays in the marketplace
    steps.push({ label: `${h.buyer} buys it`, run: async (c) => {
      await ensureFunds(buyer, h.price * 1.05 + 0.3);
      await perform(buyer, "buy", { id: c.items[h.key] });
    } });
    steps.push({ label: `${h.seller} ships it`, run: async (c) => { await perform(seller, "ship", { id: c.items[h.key] }); } });
    if (h.end === "confirm") {
      steps.push({ label: `${h.buyer} confirms it arrived`, run: async (c) => { await perform(buyer, "confirm", { id: c.items[h.key] }); } });
      continue;
    }
    // A dispute the member panel decides for the seller.
    steps.push({ label: `${h.buyer} opens a dispute`, run: async (c) => {
      await perform(buyer, "dispute", { id: c.items[h.key], reason: "I don't think it's genuine: the hardware looks different from the photos" });
      c.did = Number((await contract().getItem(c.items[h.key])).disputeId);
    } });
    steps.push({ label: "The shop files its inspection report", run: async (c) => {
      await perform(shop, "report", { did: c.did, report: "Re-inspected on return: serial tag, hardware and leather match our original check. Genuine." });
    } });
    for (let v = 0; v < 3; v++) {
      steps.push({ label: `Panel member ${v + 1} votes`, run: async (c) => {
        const panel: string[] = await contract().getPanel(c.did);
        const all = await allUsers();
        const voter = all.find((u) => u.address.toLowerCase() === panel[v].toLowerCase());
        if (!voter) throw new UserError("A panel member wasn't found.");
        const d = await contract().getDispute(c.did);
        if (d.resolved) return;
        await ensureFunds(voter, 0.1);
        await perform(voter, "vote", { did: c.did, buyerWins: false });
      } });
    }
  }
  return steps;
}

// Admin setup, run in small steps so each call stays well inside the time limit.
//  setup:   demo accounts get wallets; Maya and Alex join on-chain and are ID-checked by the shop.
//  seed:    adds the next community member (invited by Maya, Alex or an earlier member), registered, ID-checked, given gas money.
//  history: plays the demo history (sales, listings, a dispute decided by a member panel), resuming where it stopped.
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
      if (await ensureFunds(shop, 1)) done.push("Shop given $1 for network fees");
      for (const h of ["maya", "alex"]) {
        const u = await ensureSystem(h);
        await registerOnChain(u);
        if (await shopVerifies(u)) done.push(`${u.name}'s ID checked by the shop`);
        if (await ensureFunds(u, 3)) done.push(`${u.name} given test money`);
      }
      return { done, message: done.length ? done.join(". ") + "." : "Demo accounts were already set up." };
    }

    if (body.op === "seed") {
      const people = await seededByName();
      // Finish anyone half set up (e.g. a call that timed out) before adding more.
      let u: User | undefined;
      for (const x of Object.values(people)) {
        if (!x.onchain || (await c.members(x.address)).verifiedBy === ethers.ZeroAddress) { u = x; break; }
      }
      if (!u) {
        const name = SEED_MEMBERS.find((n) => !people[n]);
        if (name) {
          const inv = SEED_INVITER[name];
          const inviter = inv === "maya" || inv === "alex" ? inv : people[inv]?.handle ?? "maya";
          u = await createMember({ name, email: null, invitedBy: inviter, seeded: true });
        }
      }
      if (u) {
        await registerOnChain(u);
        await shopVerifies(u);
        await ensureFunds(u, 0.3);
      }
      const total = Object.values(await seededByName()).filter((x) => x.onchain).length;
      return { added: u ? [u.name] : [], total, remaining: SEED_MEMBERS.length - total };
    }

    if (body.op === "history") {
      const people = await seededByName();
      if (SEED_MEMBERS.some((n) => !people[n]?.onchain)) throw new UserError("Add the community members first.");
      const steps = historySteps(people, shop);
      const ctx = await loadCtx();
      const started = Date.now();
      const done: string[] = [];
      while (ctx.step < steps.length && Date.now() - started < 40_000) {
        await steps[ctx.step].run(ctx);
        done.push(steps[ctx.step].label);
        ctx.step++;
        await saveCtx(ctx);
      }
      return { done, step: ctx.step, total: steps.length, finished: ctx.step >= steps.length };
    }
    throw new UserError("Unknown request.");
  });
}
