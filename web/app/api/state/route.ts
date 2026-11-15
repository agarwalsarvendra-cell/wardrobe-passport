import { readState } from "@/lib/chain";
import { safely } from "@/lib/http";
import { allUsers } from "@/lib/users";

export const dynamic = "force-dynamic";

// Items, histories, partners, track records and balances, read from Arc.
export async function GET() {
  return safely(async () => {
    const users = await allUsers();
    return readState(users.map((u) => u.address));
  });
}
