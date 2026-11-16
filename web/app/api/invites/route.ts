import { createInvite, requireMember } from "@/lib/auth";
import { safely } from "@/lib/http";

export const dynamic = "force-dynamic";

// A member creates an invite link (limited number; see RULES).
export async function POST() {
  return safely(async () => createInvite(await requireMember()));
}
