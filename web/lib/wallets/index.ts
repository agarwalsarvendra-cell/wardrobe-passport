import { CFG } from "../config";
import { circleProvider } from "./circle";
import { localProvider } from "./local";
import type { WalletProvider } from "./types";
export const wallets = (): WalletProvider => (CFG.walletProvider === "circle" ? circleProvider : localProvider);
export type { ManagedWallet, TxResult } from "./types";
