import { fund } from "@/lib/actions";
import { requireMember } from "@/lib/auth";
import { safely } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Demo only: send test dollars from the platform treasury to the signed-in member.
export async function POST(req: Request) {
  return safely(async () => {
    const user = await requireMember();
    const body = await req.json().catch(() => ({}));
    return fund(user, Number(body.dollars));
  });
}
