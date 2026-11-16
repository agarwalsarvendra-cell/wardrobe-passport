// Sign-in. Three ways in:
//  1. An invite link from a member (the only way to join).
//  2. A one-time code sent to the email a member joined with.
//  3. The admin signs a message with the wallet that deployed the contract (MetaMask).
// Plus "Try the demo" accounts for the video. A session is an httpOnly cookie
// holding a random token; only its SHA-256 is stored.
import { createHash, randomBytes, randomInt } from "crypto";
import { cookies } from "next/headers";
import { ethers } from "ethers";
import { CFG, RULES, SYSTEM_USERS } from "./config";
import { contract } from "./chain";
import { q } from "./db";
import { UserError } from "./errors";
import { createMember, ensureSystem, getUser, registerOnChain, userByEmail, welcomeGas, type User } from "./users";

const COOKIE = "wp_session";
const SESSION_DAYS = 30;
const sha = (s: string) => createHash("sha256").update(s).digest("hex");

export interface Session { user: User | null; isAdmin: boolean; adminAddress?: string }

async function startSession(handle: string, isAdmin = false) {
  const token = randomBytes(32).toString("base64url");
  await q("insert into sessions (token_hash, handle, is_admin, expires_at) values ($1,$2,$3, now() + interval '30 days')", [sha(token), handle, isAdmin]);
  (await cookies()).set(COOKIE, token, { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/", maxAge: SESSION_DAYS * 86400 });
}

export async function currentSession(): Promise<Session> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return { user: null, isAdmin: false };
  const rows = await q("select handle, is_admin from sessions where token_hash = $1 and expires_at > now()", [sha(token)]);
  if (!rows[0]) return { user: null, isAdmin: false };
  if (rows[0].is_admin) return { user: null, isAdmin: true, adminAddress: rows[0].handle };
  return { user: await getUser(rows[0].handle), isAdmin: false };
}

export async function requireMember(): Promise<User> {
  const s = await currentSession();
  if (!s.user) throw new UserError("Please sign in first.");
  return s.user;
}
export async function requireAdmin(): Promise<Session> {
  const s = await currentSession();
  if (!s.isAdmin) throw new UserError("Only the admin can do that.");
  return s;
}

export async function signOut() {
  const jar = await cookies();
  const token = jar.get(COOKIE)?.value;
  if (token) await q("delete from sessions where token_hash = $1", [sha(token)]);
  jar.delete(COOKIE);
}

// ---------------------------------------------------------------- invites

const cleanEmail = (v: unknown) => {
  const s = typeof v === "string" ? v.trim().toLowerCase() : "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s) || s.length > 120) throw new UserError("Please enter a valid email.");
  return s;
};
const cleanName = (v: unknown) => {
  const s = typeof v === "string" ? v.trim().replace(/\s+/g, " ") : "";
  if (s.length < 2 || s.length > 40) throw new UserError("Please enter your name (2 to 40 characters).");
  return s;
};

/** How many open invites a member may hold: 3, plus 1 per clean completed sale, up to 10. */
export async function inviteAllowance(u: User, record?: { sold: number; disputesLost: number }) {
  let r = record;
  if (!r) {
    try { const x = await contract().records(u.address); r = { sold: Number(x.sold), disputesLost: Number(x.disputesLost) }; } catch { r = { sold: 0, disputesLost: 0 }; }
  }
  const earned = Math.max(0, r.sold - r.disputesLost);
  const total = Math.min(RULES.maxOpenInvites, RULES.startInvites + earned);
  const [{ n }] = await q("select count(*)::int as n from invites where inviter = $1", [u.handle]);
  return { total, used: n, left: Math.max(0, total - n) };
}

export async function createInvite(u: User) {
  if (u.role !== "member") throw new UserError("Only members can invite people.");
  const a = await inviteAllowance(u);
  if (a.left <= 0) throw new UserError("You've used all your invites. Complete a sale to earn another.");
  const code = randomBytes(6).toString("base64url");
  await q("insert into invites (code, inviter) values ($1,$2)", [code, u.handle]);
  return { code };
}

export async function checkInvite(codeRaw: unknown) {
  const code = typeof codeRaw === "string" ? codeRaw.trim() : "";
  const rows = await q("select i.code, i.used_by, u.display_name from invites i join users u on u.handle = i.inviter where i.code = $1", [code]);
  if (!rows[0]) throw new UserError("That invite link isn't valid. Ask the member who invited you for a new one.");
  if (rows[0].used_by) throw new UserError("That invite has already been used. Ask for a new one.");
  return { inviterName: rows[0].display_name as string };
}

/** Join through an invite: wallet, on-chain membership with the inviter, welcome credit, session. */
export async function join(body: any) {
  const code = String(body.code ?? "").trim();
  const name = cleanName(body.name);
  const email = cleanEmail(body.email);
  await checkInvite(code);
  if (await userByEmail(email)) throw new UserError("That email already has a membership. Sign in instead.");
  // Claim the invite first so it can't be used twice at the same time.
  const claimed = await q("update invites set used_by = '(joining)', used_at = now() where code = $1 and used_by is null returning inviter", [code]);
  if (!claimed[0]) throw new UserError("That invite has already been used. Ask for a new one.");
  try {
    const u = await createMember({ name, email, invitedBy: claimed[0].inviter });
    await q("update invites set used_by = $2 where code = $1", [code, u.handle]);
    await registerOnChain(u);
    await q(`insert into credits (handle, kind, amount_cents, note, expires_at)
             values ($1,'welcome_shipping',$2,$3, now() + make_interval(days => $4))`,
      [u.handle, RULES.welcomeShippingCredit * 100, `First delivery free on an order of $${RULES.welcomeMinOrder} or more`, RULES.creditDays]);
    await welcomeGas(u).catch((e) => console.warn("welcome gas failed", e));
    await startSession(u.handle);
    return { handle: u.handle };
  } catch (e) {
    await q("update invites set used_by = null, used_at = null where code = $1 and used_by = '(joining)'", [code]);
    throw e;
  }
}

// ------------------------------------------------------------- email codes

async function sendMail(to: string, code: string) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const nodemailer = require("nodemailer");
  const t = nodemailer.createTransport(CFG.smtpUrl);
  await t.sendMail({
    from: CFG.mailFrom, to, subject: `Your Wardrobe Passport code: ${code}`,
    text: `Your sign-in code is ${code}. It expires in 10 minutes. If you didn't ask for it, ignore this email.`,
  });
}

export async function sendCode(body: any) {
  const email = cleanEmail(body.email);
  const u = await userByEmail(email);
  // Same answer whether or not the email is a member, unless we're in demo mode.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  if (u) {
    await q(`insert into login_codes (key, code_hash, expires_at, attempts) values ($1,$2, now() + interval '10 minutes', 0)
             on conflict (key) do update set code_hash = excluded.code_hash, expires_at = excluded.expires_at, attempts = 0`,
      [`email:${email}`, sha(code)]);
  }
  if (CFG.smtpUrl) {
    if (u) await sendMail(email, code);
    return { sent: true };
  }
  if (!u) throw new UserError("No membership uses that email. Membership is by invitation.");
  return { sent: false, demoCode: code };
}

export async function verifyCode(body: any) {
  const email = cleanEmail(body.email);
  const code = String(body.code ?? "").trim();
  const key = `email:${email}`;
  const rows = await q("select code_hash, attempts from login_codes where key = $1 and expires_at > now()", [key]);
  if (!rows[0]) throw new UserError("That code has expired. Ask for a new one.");
  if (rows[0].attempts >= 5) throw new UserError("Too many tries. Ask for a new code.");
  if (rows[0].code_hash !== sha(code)) {
    await q("update login_codes set attempts = attempts + 1 where key = $1", [key]);
    throw new UserError("That code isn't right. Check the email and try again.");
  }
  await q("delete from login_codes where key = $1", [key]);
  const u = await userByEmail(email);
  if (!u) throw new UserError("No membership uses that email.");
  await startSession(u.handle);
  return { handle: u.handle };
}

// ------------------------------------------------------------------ demo

export async function demoSignIn(body: any) {
  if (!CFG.demoSignin) throw new UserError("Demo sign-in is turned off.");
  const def = SYSTEM_USERS.find((u) => u.handle === body.handle && "demo" in u);
  if (def) {
    const u = await ensureSystem(def.handle);
    await startSession(u.handle);
    return { handle: u.handle };
  }
  // Seeded community members (no email) can be used in the demo, e.g. to vote on a panel.
  const seeded = await getUser(String(body.handle ?? ""));
  if (!seeded || !seeded.seeded) throw new UserError("Unknown demo account.");
  await startSession(seeded.handle);
  return { handle: seeded.handle };
}

// ------------------------------------------------------------------ admin

const adminMessage = (nonce: string) =>
  `Sign in to Wardrobe Passport as admin.\n\nThis proves you hold the wallet that deployed the contract. It costs nothing.\n\nNonce: ${nonce}`;

export async function adminNonce() {
  const nonce = randomBytes(12).toString("hex");
  await q("insert into login_codes (key, code_hash, expires_at) values ($1,$2, now() + interval '5 minutes')", [`admin:${nonce}`, "-"]);
  return { message: adminMessage(nonce), nonce };
}

export async function adminSignIn(body: any) {
  const nonce = String(body.nonce ?? "");
  const rows = await q("delete from login_codes where key = $1 and expires_at > now() returning key", [`admin:${nonce}`]);
  if (!rows[0]) throw new UserError("That sign-in request expired. Try again.");
  let signer: string;
  try { signer = ethers.verifyMessage(adminMessage(nonce), String(body.signature ?? "")); } catch { throw new UserError("Couldn't read that signature."); }
  const admin: string = await contract().admin();
  if (signer.toLowerCase() !== admin.toLowerCase()) throw new UserError("That wallet isn't the contract's admin. Use the account that deployed it.");
  await startSession(admin, true);
  return { admin };
}
