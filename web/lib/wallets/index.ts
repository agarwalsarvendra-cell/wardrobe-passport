import { forgetProtection } from "../chain";
import { CFG } from "../config";
import { circleProvider } from "./circle";
import { localProvider } from "./local";
import type { WalletProvider } from "./types";

const base = (): WalletProvider => (CFG.walletProvider === "circle" ? circleProvider : localProvider);
/** The wallet provider. Anything it sends changes the chain, so the shared page snapshot is dropped afterwards. */
export const wallets = (): WalletProvider => {
  const p = base();
  return {
    name: p.name,
    createWallet: (label) => p.createWallet(label),
    execute: async (w, to, data, value) => { try { return await p.execute(w, to, data, value); } finally { forgetProtection(); } },
    transfer: async (w, to, value) => { try { return await p.transfer(w, to, value); } finally { forgetProtection(); } },
  };
};
export type { ManagedWallet, TxResult } from "./types";
