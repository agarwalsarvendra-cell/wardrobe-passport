import { perform, UserError } from "@/lib/actions";
import { isHandle } from "@/lib/config";
import { safely } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// One endpoint for every action. Body: { as: "maya", action: "buy", id: 3, ... }
export async function POST(req: Request) {
  return safely(async () => {
    const body = await req.json().catch(() => ({}));
    if (!isHandle(body.as) || body.as === "treasury") throw new UserError("Choose who you are first.");
    return perform(body.as, String(body.action ?? ""), body);
  });
}
