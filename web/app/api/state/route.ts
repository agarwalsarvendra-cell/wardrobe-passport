import { readProtection, readState } from "@/lib/chain";
import { currentSession } from "@/lib/auth";
import { q } from "@/lib/db";
import { safely } from "@/lib/http";
import { allUsers } from "@/lib/users";

export const dynamic = "force-dynamic";

// Items, histories, members, disputes and track records, read from Arc. Members also get
// the ledger (every action with its Arc transaction), flags and authentication requests.
export async function GET() {
  return safely(async () => {
    const s = await currentSession();
    const signedIn = !!s.user || s.isAdmin;
    const users = signedIn ? await allUsers() : [];
    const chain = await readState(users.map((u) => u.address));
    const [prot, metaRows] = await Promise.all([
      readProtection(chain, users.filter((u) => u.role === "member").map((u) => u.address)),
      q("select item_id, category from piece_meta"),
    ]);
    const categories: Record<number, string> = {};
    for (const r of metaRows) categories[Number(r.item_id)] = r.category;
    if (!signedIn) return { ...chain, protection: prot, categories, balances: {}, authRequests: {}, flags: {}, ledger: [] };

    const [reqs, flagRows, ledger, feed, feedStat] = await Promise.all([
      q("select item_id, owner_address, partner_address, status, note, created_at, decided_at from auth_requests"),
      q("select item_id, handle, reason from flags"),
      q("select id, tx_hash, action, item_id, actor, detail, created_at from activity order by id desc limit 200"),
      // QuickNode Streams: an independent feed of the contracts' events (see /api/streams).
      q("select tx_hash, log_index, block_number, block_time, event, args, contract from chain_events order by block_number desc, log_index desc limit 300"),
      q("select max(block_number)::bigint as last_block, max(received_at) as last_at, count(*)::int as n from chain_events"),
    ]);
    const streamed: Record<string, string[]> = {};
    const hashes = [...new Set(ledger.map((r: any) => String(r.tx_hash).toLowerCase()))];
    const confirmed = feedStat[0]?.n && hashes.length ? await q("select tx_hash, event from chain_events where tx_hash = any($1)", [hashes]) : [];
    for (const r of confirmed) (streamed[r.tx_hash] ??= []).push(r.event);
    const streamStatus = feedStat[0]?.n
      ? { lastBlock: Number(feedStat[0].last_block), lastAt: Math.floor(new Date(feedStat[0].last_at).getTime() / 1000), count: feedStat[0].n }
      : null;
    const chainFeed = feed.slice(0, 50).map((r: any) => ({
      hash: r.tx_hash, logIndex: r.log_index, block: Number(r.block_number), at: Math.floor(new Date(r.block_time).getTime() / 1000),
      event: r.event, args: r.args, contract: r.contract,
    }));
    const authRequests: Record<number, any> = {};
    for (const r of reqs) {
      authRequests[Number(r.item_id)] = {
        status: r.status, partner: r.partner_address, owner: r.owner_address, note: r.note,
        createdAt: Math.floor(new Date(r.created_at).getTime() / 1000),
        decidedAt: r.decided_at ? Math.floor(new Date(r.decided_at).getTime() / 1000) : null,
      };
    }
    const flags: Record<number, { count: number; mine: boolean; reasons: string[] }> = {};
    for (const f of flagRows) {
      const k = Number(f.item_id);
      flags[k] ??= { count: 0, mine: false, reasons: [] };
      flags[k].count++;
      flags[k].reasons.push(f.reason);
      if (s.user && f.handle === s.user.handle) flags[k].mine = true;
    }
    // Balances: your own (and the treasury's) for members; everyone's for the admin.
    const balances: Record<string, string> = {};
    for (const u of users) {
      const k = u.address.toLowerCase();
      if (s.isAdmin || u.handle === s.user?.handle || u.role === "treasury") balances[k] = chain.balances[k];
    }
    return {
      ...chain, protection: prot, categories, balances, authRequests, flags, streamed, streamStatus, chainFeed,
      ledger: ledger.map((r: any) => ({ id: Number(r.id), hash: r.tx_hash, action: r.action, itemId: r.item_id == null ? null : Number(r.item_id), actor: r.actor, detail: r.detail, at: Math.floor(new Date(r.created_at).getTime() / 1000) })),
    };
  });
}
