import { readState } from "@/lib/chain";
import { q } from "@/lib/db";
import { safely } from "@/lib/http";
import { allUsers } from "@/lib/users";

export const dynamic = "force-dynamic";

// Items, histories, partners, track records and balances, read from Arc,
// plus open authentication requests from the database.
export async function GET() {
  return safely(async () => {
    const users = await allUsers();
    const [chain, reqs] = await Promise.all([
      readState(users.map((u) => u.address)),
      q("select item_id, requested_by, owner_address, partner_address, status, note, created_at, decided_at from auth_requests"),
    ]);
    // Authentication requests are off-chain notes; the stamp itself is read from Arc above.
    const authRequests: Record<number, any> = {};
    for (const r of reqs) {
      authRequests[Number(r.item_id)] = {
        status: r.status, partner: r.partner_address, owner: r.owner_address, note: r.note,
        createdAt: Math.floor(new Date(r.created_at).getTime() / 1000),
        decidedAt: r.decided_at ? Math.floor(new Date(r.decided_at).getTime() / 1000) : null,
      };
    }
    return { ...chain, authRequests };
  });
}
