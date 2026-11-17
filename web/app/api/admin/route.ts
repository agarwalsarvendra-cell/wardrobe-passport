import { ethers } from "ethers";
import { requireAdmin } from "@/lib/auth";
import { perform, pieceCategory, send } from "@/lib/actions";
import { catKey, contract, protection, protectionOn, rpc } from "@/lib/chain";
import { PROTECTION_DEMO, SEED_HISTORY, SEED_INVITER, SEED_MEMBERS, SPECIALIST_PLAN } from "@/lib/config";
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

/** A demo photo from /public/seed, if one was added (fetched from our own site so it works on Vercel). */
async function seedPhoto(origin: string, file: string): Promise<string | null> {
  try {
    const r = await fetch(`${origin}/seed/${file}`, { cache: "no-store" });
    if (!r.ok) return null;
    const type = r.headers.get("content-type") || "";
    if (!/^image\/(jpeg|png|webp)/.test(type)) return null;
    const bytes = Buffer.from(await r.arrayBuffer());
    if (bytes.length > 380_000) return null; // the app compresses photos on upload; seed photos must already be small
    return `data:${type.split(";")[0]};base64,${bytes.toString("base64")}`;
  } catch { return null; }
}

/** Which authenticator checks a piece: a specialist in its category (vintage watches go to the second shop if it's a partner). */
async function authenticatorFor(category: string, shop: User): Promise<User> {
  const plan = SPECIALIST_PLAN.filter((s) => s.category === category).map((s) => s.shop as string);
  for (const h of plan.length ? plan : ["shop"]) {
    const u = h === "shop" ? shop : await ensureSystem(h);
    if ((await contract().partners(u.address)).active) return u;
  }
  return shop;
}
const NOTE: Record<string, string> = {
  watches: "Opened the caseback: movement, serial and dial match the reference.",
  "vintage-watches": "Movement, dial and case checked against period references. Serviced, keeps time.",
  jewelry: "Hallmarks checked, gold and stones tested in store.",
  handbags: "Stitching, hardware and date code match.",
};

function historySteps(people: Record<string, User>, shop: User, origin: string): { label: string; run: (c: Ctx) => Promise<void> }[] {
  const steps: { label: string; run: (c: Ctx) => Promise<void> }[] = [];
  for (const h of SEED_HISTORY) {
    const seller = people[h.seller];
    const buyer = h.buyer ? people[h.buyer] : null;
    steps.push({ label: `${h.seller} adds “${h.name}”`, run: async (c) => {
      await ensureFunds(seller, 0.3);
      const photo = await seedPhoto(origin, h.photo);
      const r = await perform(seller, "createPassport", { name: h.name, brand: h.brand, details: h.details, icon: h.icon, category: h.category, photo });
      c.items[h.key] = r.id!;
    } });
    steps.push({ label: `${h.seller} asks an authenticator to check it`, run: async (c) => {
      const a = await authenticatorFor(h.category, shop);
      await perform(seller, "requestAuth", { id: c.items[h.key], partner: a.address });
    } });
    if (h.end === "request") continue; // left waiting in the shop's queue
    steps.push({ label: `The authenticator checks “${h.name}”`, run: async (c) => {
      const a = await authenticatorFor(h.category, shop);
      await perform(a, "authenticate", { id: c.items[h.key], note: NOTE[h.category] ?? "Inspected in store." });
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
      await perform(buyer, "dispute", { id: c.items[h.key], reason: "I don't think it's genuine: the crown and dial look different from the photos" });
      c.did = Number((await contract().getItem(c.items[h.key])).disputeId);
    } });
    steps.push({ label: "The shop files its inspection report", run: async (c) => {
      await perform(shop, "report", { did: c.did, report: "Re-inspected on return: serial, movement and dial match our original check. Genuine." });
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

// ------------------------------------------------------------- protection
async function loadP(): Promise<Ctx> {
  const r = await q("select value from settings where key = 'seed_protection'");
  return r[0] ? JSON.parse(r[0].value) : { step: 0, items: {} };
}
const saveP = (c: Ctx) =>
  q("insert into settings (key, value) values ('seed_protection', $1) on conflict (key) do update set value = excluded.value", [JSON.stringify(c)]);

const usdOf = (wei: bigint) => Number(ethers.formatUnits(wei, 18));

/**
 * The protection demo, in resumable steps:
 * retire listings from before the launch category, make sure the catalogue of watches and
 * jewelry is listed and certified, stake both authenticators' bonds, fund the pool, then
 * three covered sales: one proven fake, one claim rejected as genuine, one live.
 */
async function protectionSteps(people: Record<string, User>, shop: User, origin: string) {
  const steps: { label: string; run: (c: Ctx) => Promise<boolean | void> }[] = [];
  const P = protection();
  const shop2 = await ensureSystem("shop2");
  const shops: Record<string, User> = { shop, shop2 };
  const all = await allUsers();
  const byAddr = (a: string) => all.find((u) => u.address.toLowerCase() === a.toLowerCase());

  // 1. Listings from before watches and jewelry (no category): their sellers take them off sale, a few per call.
  steps.push({ label: "Older listings outside watches and jewelry are taken off sale", run: async () => {
    const c = contract();
    const n = Number(await c.itemCount());
    const started = Date.now();
    for (let id = 1; id <= n; id++) {
      if (await pieceCategory(id)) continue;
      await q("delete from auth_requests where item_id = $1 and status = 'pending'", [id]);
      const it = await c.getItem(id);
      const owner = byAddr(it.owner);
      if (Number(it.status) !== 1 || !owner || owner.role !== "member") continue;
      if (Date.now() - started > 25_000) return false; // more to do: the next call carries on
      await perform(owner, "unlist", { id });
    }
    return true;
  } });

  // 2. The catalogue: every listing in the demo history exists, is authenticated and certified by a specialist, and is for sale.
  for (const h of SEED_HISTORY.filter((x) => x.end === "list")) {
    steps.push({ label: `“${h.name}” is listed and certified`, run: async (c) => {
      const seller = people[h.seller];
      const ct = contract();
      let id = c.items[h.key] ?? 0;
      if (!id) {
        const n = Number(await ct.itemCount());
        for (let i = n; i >= 1; i--) {
          if ((await pieceCategory(i)) !== h.category) continue;
          const it = await ct.getItem(i);
          if (it.name === h.name && it.owner.toLowerCase() === seller.address.toLowerCase()) { id = i; break; }
        }
      }
      if (!id) {
        await ensureFunds(seller, 0.3 + h.price * 0.1);
        const photo = await seedPhoto(origin, h.photo);
        id = (await perform(seller, "createPassport", { name: h.name, brand: h.brand, details: h.details, icon: h.icon, category: h.category, photo })).id!;
      }
      c.items[h.key] = id;
      await saveP(c);
      let it = await ct.getItem(id);
      if (ethers.ZeroAddress === it.authBy) {
        const a = await authenticatorFor(h.category, shop);
        await perform(seller, "requestAuth", { id, partner: a.address });
        await ensureFunds(a, 0.3); // fee money for the authenticator
        await perform(a, "authenticate", { id, note: NOTE[h.category] ?? "Inspected in store." }); // certifies too
        it = await ct.getItem(id);
      }
      if (/^0x0+$/.test(await P.categoryOf(id)) && (await P.specialistIn(it.authBy, catKey(h.category)))) {
        const by = byAddr(it.authBy);
        if (by) await perform(by, "certify", { id });
      }
      if (Number(it.status) === 0) {
        await ensureFunds(seller, h.price * 0.1 + 0.2);
        await perform(seller, "list", { id, price: String(h.price) });
      }
      return true;
    } });
  }

  // 3. Bonds and the pool.
  for (const [h, amount] of Object.entries(PROTECTION_DEMO.bonds)) {
    steps.push({ label: `${h === "shop" ? "Demo Pawn Shop" : "Second Opinion Jewelers"} stakes a $${amount} bond`, run: async () => {
      const u = shops[h];
      const have = usdOf(await P.bondOf(u.address));
      if (have >= amount) return;
      await ensureFunds(u, amount - have + 0.3);
      await perform(u, "stakeBond", { amount: (amount - have).toFixed(2) });
    } });
  }
  for (const [name, amount] of PROTECTION_DEMO.stakers) {
    steps.push({ label: `${name} puts $${amount} into the protection pool`, run: async () => {
      const u = people[name];
      if ((await P.sharesOf(u.address)) > 0n) return;
      await ensureFunds(u, amount + 0.2);
      await perform(u, "poolDeposit", { amount: String(amount) });
    } });
  }

  // 4. Covered sales.
  for (const s of PROTECTION_DEMO.sales) {
    const seller = people[s.seller], buyer = people[s.buyer], a = shops[s.shop];
    steps.push({ label: `${s.seller} adds “${s.name}”`, run: async (c) => {
      await ensureFunds(seller, 0.4 + s.price * 0.1);
      c.items[s.key] = (await perform(seller, "createPassport", { name: s.name, brand: s.brand, details: s.details, icon: s.icon, category: s.category, photo: await seedPhoto(origin, s.photo) })).id!;
    } });
    steps.push({ label: `${a.name} authenticates it, and ${s.seller} lists it for $${s.price}`, run: async (c) => {
      const id = c.items[s.key];
      let it = await contract().getItem(id);
      if (ethers.ZeroAddress === it.authBy) {
        await perform(seller, "requestAuth", { id, partner: a.address });
        await ensureFunds(a, 0.3);
        await perform(a, "authenticate", { id, note: NOTE[s.category] ?? "Inspected in store." });
        it = await contract().getItem(id);
      }
      if (Number(it.status) === 0) await perform(seller, "list", { id, price: String(s.price) });
    } });
    steps.push({ label: `${s.buyer} buys it and adds 90-day protection`, run: async (c) => {
      const id = c.items[s.key];
      await ensureFunds(buyer, s.price * 1.25 + 0.3);
      if (Number((await contract().getItem(id)).status) === 1) await perform(buyer, "buy", { id });
      const it = await contract().getItem(id);
      if (!Number(await P.coverFor(id, buyer.address, it.paidAt))) await perform(buyer, "buyCover", { id });
    } });
    steps.push({ label: `${s.seller} ships it and ${s.buyer} confirms it arrived`, run: async (c) => {
      const id = c.items[s.key];
      if (Number((await contract().getItem(id)).status) === 2) await perform(seller, "ship", { id });
      if (Number((await contract().getItem(id)).status) === 3) await perform(buyer, "confirm", { id }); // the 90 days start here
    } });
    if (!("claim" in s)) continue;
    const reviewer = shops[s.shop === "shop" ? "shop2" : "shop"];
    steps.push({ label: `${s.buyer} files a claim: “${s.claim}”`, run: async (c) => {
      const id = c.items[s.key];
      let cover = 0;
      const n = Number(await P.coverCount());
      for (let i = n; i >= 1; i--) { const cv = await P.getCover(i); if (Number(cv.itemId) === id && cv.buyer.toLowerCase() === buyer.address.toLowerCase()) { cover = i; break; } }
      c.items[`${s.key}-cover`] = cover;
      await ensureFunds(buyer, s.price * 0.05 + 0.2);
      await perform(buyer, "fileClaim", { cover, evidence: s.claim });
    } });
    steps.push({ label: `${reviewer.name} re-inspects it: ${s.fake ? "fake" : "genuine"}`, run: async (c) => {
      await ensureFunds(reviewer, 0.2);
      await perform(reviewer, "decideClaim", { cover: c.items[`${s.key}-cover`], fake: s.fake, ruling: s.ruling });
    } });
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
    if (!p.active) throw new UserError("Approve Demo Pawn Shop first: call addPartner in Remix with its address.");

    if (body.op === "setup") {
      const done: string[] = [];
      for (const h of ["treasury", "maya", "alex", "shop2"]) await ensureSystem(h);
      if (await ensureFunds(shop, 1)) done.push("Shop given $1 for network fees");
      const shop2 = await ensureSystem("shop2");
      if ((await c.partners(shop2.address)).active && (await ensureFunds(shop2, 1))) done.push("Second Opinion Jewelers given $1 for network fees");
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
      const steps = historySteps(people, shop, new URL(req.url).origin);
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
    if (body.op === "protection") {
      if (!protectionOn()) throw new UserError("Set PROTECTION_ADDRESS on Vercel first.");
      const shop2 = await ensureSystem("shop2");
      if (!(await c.partners(shop2.address)).active) throw new UserError(`Approve Second Opinion Jewelers as a partner first (Admin → Specialists, or addPartner in Remix with ${shop2.address}).`);
      const P = protection();
      for (const sp of SPECIALIST_PLAN) {
        const u = sp.shop === "shop" ? shop : shop2;
        if (!(await P.specialistIn(u.address, catKey(sp.category)))) throw new UserError("Approve the specialists first (Admin → Specialists).");
      }
      const people = await seededByName();
      if (SEED_MEMBERS.some((n) => !people[n]?.onchain)) throw new UserError("Add the community members first.");
      const steps = await protectionSteps(people, shop, new URL(req.url).origin);
      const ctx = await loadP();
      const started = Date.now();
      const done: string[] = [];
      while (ctx.step < steps.length && Date.now() - started < 20_000) {
        const finished = await steps[ctx.step].run(ctx);
        if (finished === false) { done.push(`${steps[ctx.step].label} (continuing)`); await saveP(ctx); break; }
        done.push(steps[ctx.step].label);
        ctx.step++;
        await saveP(ctx);
      }
      return { done, step: ctx.step, total: steps.length, finished: ctx.step >= steps.length };
    }
    throw new UserError("Unknown request.");
  });
}
