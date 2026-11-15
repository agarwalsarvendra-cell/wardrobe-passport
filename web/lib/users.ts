import { CFG, DEMO_USERS, type Handle } from "./config";
import { q } from "./db";
import { wallets, type ManagedWallet } from "./wallets";

export interface User extends ManagedWallet { handle: Handle; name: string; role: string }

const g = globalThis as unknown as { __wpEnsure?: Map<string, Promise<User>> };
const pending = () => (g.__wpEnsure ??= new Map());

/** Find the user's managed wallet, creating it the first time. One wallet per user per provider. */
export function ensureUser(handle: Handle): Promise<User> {
  const key = `${CFG.walletProvider}:${handle}`;
  const p = pending();
  if (!p.has(key)) {
    p.set(key, (async () => {
      const def = DEMO_USERS.find((u) => u.handle === handle)!;
      const rows = await q("select wallet_id, address from users where handle = $1 and wallet_provider = $2", [handle, CFG.walletProvider]);
      if (rows[0]) return { handle, name: def.name, role: def.role, walletId: rows[0].wallet_id, address: rows[0].address };
      const w = await wallets().createWallet(handle);
      await q(
        `insert into users (handle, display_name, role, wallet_provider, wallet_id, address) values ($1,$2,$3,$4,$5,$6)
         on conflict (handle) do update set wallet_provider = excluded.wallet_provider, wallet_id = excluded.wallet_id, address = excluded.address`,
        [handle, def.name, def.role, CFG.walletProvider, w.walletId, w.address]
      );
      return { handle, name: def.name, role: def.role, ...w };
    })().catch((e) => { p.delete(key); throw e; }));
  }
  return p.get(key)!;
}
export const allUsers = () => Promise.all(DEMO_USERS.map((u) => ensureUser(u.handle)));
