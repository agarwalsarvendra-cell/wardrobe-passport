import { ethers } from "ethers";
import { rpc } from "../chain";
import type { ManagedWallet, TxResult, WalletProvider } from "./types";

// Development only: keys are derived from LOCAL_WALLET_SEED and never leave the server.
function signer(walletId: string) {
  const seed = process.env.LOCAL_WALLET_SEED ?? "dev-only-seed";
  return new ethers.Wallet(ethers.id(`${seed}:${walletId}`), rpc());
}
async function done(tx: ethers.TransactionResponse): Promise<TxResult> {
  const rc = await tx.wait();
  if (!rc || rc.status !== 1) throw new Error("Transaction failed");
  return { hash: rc.hash, feeWei: rc.fee ?? null };
}
export const localProvider: WalletProvider = {
  name: "local",
  async createWallet(label) {
    return { walletId: label, address: signer(label).address };
  },
  async execute(w: ManagedWallet, to, callData, valueWei) {
    return done(await signer(w.walletId).sendTransaction({ to, data: callData, value: valueWei }));
  },
  async transfer(w: ManagedWallet, to, valueWei) {
    return done(await signer(w.walletId).sendTransaction({ to, value: valueWei }));
  },
};
