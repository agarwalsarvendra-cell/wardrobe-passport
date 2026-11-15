import { q } from "@/lib/db";
import { safely } from "@/lib/http";

export const dynamic = "force-dynamic";

// The latest actions taken through the app, newest first.
export async function GET() {
  return safely(async () => ({
    activity: await q("select id, tx_hash, action, item_id, actor, detail, fee_wei, created_at from activity order by id desc limit 50"),
  }));
}
