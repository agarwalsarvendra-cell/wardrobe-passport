// One interface, two implementations: Circle developer-controlled wallets in
// production, throwaway server-side keys for local development and tests.
export interface ManagedWallet { walletId: string; address: string }
export interface TxResult { hash: string; feeWei: bigint | null }
export interface WalletProvider {
  name: "local" | "circle";
  createWallet(label: string): Promise<ManagedWallet>;
  /** Call the contract from this wallet, optionally sending native USDC (wei, 18 decimals). Waits until confirmed. */
  execute(w: ManagedWallet, to: string, callData: string, valueWei: bigint): Promise<TxResult>;
  /** Plain transfer of native USDC. Waits until confirmed. */
  transfer(w: ManagedWallet, to: string, valueWei: bigint): Promise<TxResult>;
}
