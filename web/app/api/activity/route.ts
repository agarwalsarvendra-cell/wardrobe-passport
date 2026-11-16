import { requireMember } from "@/lib/auth";
import { q } from "@/lib/db";
import { safely } from "@/lib/http";

export const dynamic = "force-dynamic";

// The latest actions taken through the app, newest first. Members only (the full ledger is in /api/state).
export async function GET() {
  return safely(async () => {
    await requireMember();
    return { activity: await q("select id, tx_hash, action, item_id, actor, detail, created_at from activity order by id desc limit 50") };
  });
}
