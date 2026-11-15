import { fund, UserError } from "@/lib/actions";
import { isHandle } from "@/lib/config";
import { safely } from "@/lib/http";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

// Demo only: send test dollars from the demo treasury to a demo person.
export async function POST(req: Request) {
  return safely(async () => {
    const body = await req.json().catch(() => ({}));
    if (!isHandle(body.as)) throw new UserError("Choose who you are first.");
    return fund(body.as, Number(body.dollars));
  });
}
