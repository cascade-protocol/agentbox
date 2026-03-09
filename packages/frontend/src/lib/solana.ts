import type { ConnectedStandardSolanaWallet } from "@privy-io/react-auth/solana";
import { useSignTransaction, useWallets } from "@privy-io/react-auth/solana";
import {
  address,
  createSolanaRpc,
  getTransactionDecoder,
  getTransactionEncoder,
  type TransactionSigner,
} from "@solana/kit";
import { useCallback, useEffect, useMemo, useState } from "react";
import { env } from "../env";

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${env.heliusApiKey}`;
const rpc = createSolanaRpc(RPC_URL);

/** Prefers external wallet (user's own) over Privy embedded wallet. */
export function useActiveWallet(): ConnectedStandardSolanaWallet | null {
  const { wallets } = useWallets();
  return wallets.find((w) => w.standardWallet.name !== "Privy") ?? wallets[0] ?? null;
}

/**
 * Creates a @solana/kit TransactionSigner from a Privy Solana wallet.
 * Used by x402 payment flow and NFT transfer dialog.
 */
export function usePrivySigner(
  wallet: ConnectedStandardSolanaWallet | null,
): TransactionSigner | null {
  const { signTransaction } = useSignTransaction();

  return useMemo(() => {
    if (!wallet) return null;

    const walletAddress = address(wallet.address);
    const encoder = getTransactionEncoder();
    const decoder = getTransactionDecoder();

    // TransactionSigner is a union of Modifying|Partial|Sending signers.
    // We implement modifyAndSignTransactions (the TransactionModifyingSigner variant).
    // Cast through unknown because the branded types (TransactionWithinSizeLimit)
    // are compile-time nominal markers that can't be produced by decoder.decode().
    return {
      address: walletAddress,
      // biome-ignore lint/suspicious/noExplicitAny: TransactionSigner union requires cast through unknown
      async modifyAndSignTransactions(transactions: readonly any[]) {
        const results = [];
        for (const tx of transactions) {
          const bytes = new Uint8Array(encoder.encode(tx));
          const { signedTransaction } = await signTransaction({
            transaction: bytes,
            wallet,
          });
          results.push(decoder.decode(signedTransaction));
        }
        return results;
      },
    } as unknown as TransactionSigner;
  }, [wallet, signTransaction]);
}

/** SOL balance for any wallet address. */
export function useSolBalance(walletAddress: string | null) {
  const [lamports, setLamports] = useState<bigint | null>(null);
  const [fetching, setFetching] = useState(false);

  const refresh = useCallback(async () => {
    if (!walletAddress) return;
    setFetching(true);
    try {
      const { value } = await rpc.getBalance(address(walletAddress)).send();
      setLamports(value);
    } catch {
      /* ignore */
    } finally {
      setFetching(false);
    }
  }, [walletAddress]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { lamports, fetching, refresh };
}

/** SPL token balance for any wallet address. */
export function useSplTokenBalance(mint: string, owner: string | null) {
  const [balance, setBalance] = useState<{ uiAmount: number } | null>(null);
  const [isFetching, setIsFetching] = useState(false);

  const refresh = useCallback(async () => {
    if (!owner) return;
    setIsFetching(true);
    try {
      const { value } = await rpc
        .getTokenAccountsByOwner(
          address(owner),
          { mint: address(mint) },
          { encoding: "jsonParsed" },
        )
        .send();
      if (value.length > 0) {
        const parsed = (
          value[0].account.data as { parsed: { info: { tokenAmount: { uiAmount: number } } } }
        ).parsed;
        setBalance({ uiAmount: parsed.info.tokenAmount.uiAmount });
      } else {
        setBalance({ uiAmount: 0 });
      }
    } catch {
      /* ignore */
    } finally {
      setIsFetching(false);
    }
  }, [mint, owner]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { balance, isFetching, refresh };
}
