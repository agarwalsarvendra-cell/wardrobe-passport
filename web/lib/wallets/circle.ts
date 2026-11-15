import { ethers } from "ethers";
import { CFG } from "../config";
import { q } from "../db";
import { rpc } from "../chain";
import type { ManagedWallet, TxResult, WalletProvider } from "./types";

// Circle developer-controlled wallets on Arc Testnet. Circle holds the keys;
// this server asks Circle to sign. EOA wallets pay their own fees in USDC,
// which is Arc's native currency.
function client() {
  const apiKey = process.env.CIRCLE_API_KEY;
  const entitySecret = process.env.CIRCLE_ENTITY_SECRET;
  if (!apiKey || !entitySecret) throw new Error("Circle is not configured: set CIRCLE_API_KEY and CIRCLE_ENTITY_SECRET.");
  // Loaded on first use with require(), so Node picks the SDK's CommonJS build.
  // (Its ES build is a .js file without "type": "module", which Node refuses to import.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const sdk = require("@circle-fin/developer-controlled-wallets") as typeof import("@circle-fin/developer-controlled-wallets");
  return sdk.initiateDeveloperControlledWalletsClient({ apiKey, entitySecret });
}

async function walletSetId(): Promise<string> {
  if (process.env.CIRCLE_WALLET_SET_ID) return process.env.CIRCLE_WALLET_SET_ID;
  const saved = await q("select value from settings where key = 'circle_wallet_set_id'");
  if (saved[0]) return saved[0].value;
  const res = await client().createWalletSet({ name: "Wardrobe Passport" });
  const id = res.data?.walletSet?.id;
  if (!id) throw new Error("Circle did not return a wallet set.");
  await q("insert into settings (key, value) values ('circle_wallet_set_id', $1) on conflict (key) do update set value = excluded.value", [id]);
  return id;
}

const usdc = (wei: bigint) => ethers.formatUnits(wei, 18);
const ARC_USDC = "0x3600000000000000000000000000000000000000";
const FEE = { type: "level", config: { feeLevel: "MEDIUM" } } as const;

async function waitFor(id: string): Promise<TxResult> {
  const res = await client().getTransaction({ id, waitForState: "CONFIRMED" } as any);
  const tx: any = res.data?.transaction;
  const hash: string | undefined = tx?.txHash;
  if (!hash) throw new Error("Circle did not return a transaction hash.");
  let feeWei: bigint | null = null;
  try {
    const rc = await rpc().getTransactionReceipt(hash);
    if (rc) feeWei = rc.fee;
  } catch { /* fee is informational */ }
  return { hash, feeWei };
}

export const circleProvider: WalletProvider = {
  name: "circle",
  async createWallet(label) {
    const res = await client().createWallets({
      blockchains: [CFG.circleBlockchain as any],
      count: 1,
      walletSetId: await walletSetId(),
      accountType: "EOA",
      metadata: [{ name: label, refId: label }],
    } as any);
    const w = res.data?.wallets?.[0];
    if (!w?.id || !w.address) throw new Error("Circle did not return a wallet.");
    return { walletId: w.id, address: ethers.getAddress(w.address) };
  },
  async execute(w: ManagedWallet, to, callData, valueWei) {
    const res = await client().createContractExecutionTransaction({
      walletId: w.walletId,
      contractAddress: to,
      callData: callData as `0x${string}`,
      ...(valueWei > 0n ? { amount: usdc(valueWei) } : {}),
      fee: FEE,
    } as any);
    const id = res.data?.id;
    if (!id) throw new Error("Circle did not accept the transaction.");
    return waitFor(id);
  },
  async transfer(w: ManagedWallet, to, valueWei) {
    // On Arc, USDC is the native currency and is also reachable as a token at this
    // fixed address. Circle's transfer call moves it by token address.
    const res = await client().createTransaction({
      walletId: w.walletId,
      blockchain: CFG.circleBlockchain,
      tokenAddress: ARC_USDC,
      destinationAddress: to,
      amounts: [usdc(valueWei)],
      fee: FEE,
    } as any);
    const id = res.data?.id;
    if (!id) throw new Error("Circle did not accept the transfer.");
    return waitFor(id);
  },
};
