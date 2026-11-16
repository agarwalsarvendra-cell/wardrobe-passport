import { perform } from "@/lib/actions";
import { requireMember } from "@/lib/auth";
import { safely } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One endpoint for every action, signed by the signed-in member's wallet. Body: { action: "buy", id: 3, ... }
export async function POST(req: Request) {
  return safely(async () => {
    const user = await requireMember();
    const body = await req.json().catch(() => ({}));
    return perform(user, String(body.action ?? ""), body);
  });
}
