import { CFG, DEMO_USERS } from "@/lib/config";
import { safely } from "@/lib/http";
import { allUsers } from "@/lib/users";

export const dynamic = "force-dynamic";

// Who is in the demo, their wallet addresses, and what the client needs to know about the chain.
export async function GET() {
  return safely(async () => {
    const users = await allUsers();
    return {
      config: { chainId: CFG.chainId, chainName: CFG.chainName, contractAddress: CFG.contract, explorer: CFG.explorer, faucet: CFG.faucet, rpcUrl: CFG.rpcUrl, walletProvider: CFG.walletProvider },
      users: users.map((u) => {
        const def = DEMO_USERS.find((d) => d.handle === u.handle) as any;
        return { handle: u.handle, name: u.name, role: u.role, address: u.address, regName: def.regName ?? null, city: def.city ?? null };
      }),
    };
  });
}
