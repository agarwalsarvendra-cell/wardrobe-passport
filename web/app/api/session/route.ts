import { CATEGORIES, CFG, RULES, SPECIALIST_PLAN, SYSTEM_USERS } from "@/lib/config";
import { currentSession, inviteAllowance } from "@/lib/auth";
import { q } from "@/lib/db";
import { safely } from "@/lib/http";
import { allUsers } from "@/lib/users";

export const dynamic = "force-dynamic";

// Who is signed in, the community directory (members only), and chain details for the client.
export async function GET() {
  return safely(async () => {
    const s = await currentSession();
    const config = {
      chainId: CFG.chainId, chainName: CFG.chainName, contractAddress: CFG.contract, explorer: CFG.explorer,
      faucet: CFG.faucet, rpcUrl: CFG.rpcUrl, walletProvider: CFG.walletProvider, emailDelivery: !!CFG.smtpUrl, rules: RULES,
      protectionAddress: CFG.protection || null, categories: CATEGORIES, specialistPlan: SPECIALIST_PLAN,
    };
    const demo = CFG.demoSignin ? SYSTEM_USERS.filter((u) => "demo" in u).map((u: any) => ({ handle: u.handle, name: u.name, label: u.demo })) : [];
    const seeded = CFG.demoSignin
      ? (await q("select handle, display_name from users where seeded and onchain and wallet_provider = $1 order by created_at", [CFG.walletProvider])).map((r: any) => ({ handle: r.handle, name: r.display_name }))
      : [];
    if (!s.user && !s.isAdmin) return { config, demo, seeded, me: null, isAdmin: false, directory: [] };

    const users = await allUsers();
    const directory = users.map((u) => ({
      handle: u.handle, name: u.name, address: u.address, role: u.role, invitedBy: u.invitedBy,
      city: u.city, seeded: u.seeded, demo: SYSTEM_USERS.some((d) => d.handle === u.handle && "demo" in d),
    }));
    let me = null;
    if (s.user) {
      const u = s.user;
      const [invites, credits, allowance] = await Promise.all([
        q("select i.code, i.created_at, i.used_at, u.display_name as used_by_name from invites i left join users u on u.handle = i.used_by where i.inviter = $1 order by i.created_at desc", [u.handle]),
        q("select kind, amount_cents, note, expires_at, used_at from credits where handle = $1 order by created_at desc", [u.handle]),
        u.role === "member" ? inviteAllowance(u) : Promise.resolve(null),
      ]);
      me = {
        handle: u.handle, name: u.name, address: u.address, role: u.role, email: u.email, invitedBy: u.invitedBy, city: u.city,
        invites: invites.map((i: any) => ({ code: i.code, createdAt: i.created_at, usedAt: i.used_at, usedBy: i.used_by_name })),
        credits: credits.map((c: any) => ({ kind: c.kind, dollars: c.amount_cents / 100, note: c.note, expiresAt: c.expires_at, usedAt: c.used_at })),
        allowance,
      };
    }
    return { config, demo, seeded, me, isAdmin: s.isAdmin, adminAddress: s.adminAddress ?? null, directory };
  });
}
