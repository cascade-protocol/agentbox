import type { StandardConnectFeature, StandardDisconnectFeature } from "@wallet-standard/features";
import {
  getWalletFeature,
  type UiWallet,
  type UiWalletAccount,
  useWallets,
} from "@wallet-standard/react";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

const STORAGE_KEY = "agentbox-wallet";

type WalletContextValue = {
  wallets: readonly UiWallet[];
  wallet: UiWallet | null;
  account: UiWalletAccount | null;
  connected: boolean;
  connect: (wallet: UiWallet) => Promise<void>;
  disconnect: () => void;
};

const WalletContext = createContext<WalletContextValue | null>(null);

function isSolanaWallet(w: UiWallet): boolean {
  return w.chains.some((c) => c.startsWith("solana:"));
}

export function WalletProvider({ children }: { children: ReactNode }) {
  const allWallets = useWallets();
  const wallets = useMemo(() => allWallets.filter(isSolanaWallet), [allWallets]);

  const [selectedName, setSelectedName] = useState<string | null>(() =>
    localStorage.getItem(STORAGE_KEY),
  );

  const wallet = useMemo(
    () => wallets.find((w) => w.name === selectedName) ?? null,
    [wallets, selectedName],
  );

  const account = wallet?.accounts[0] ?? null;
  const connected = account !== null;

  const connect = useCallback(async (w: UiWallet) => {
    const feature = getWalletFeature(
      w,
      "standard:connect",
    ) as StandardConnectFeature["standard:connect"];
    await feature.connect();
    setSelectedName(w.name);
    localStorage.setItem(STORAGE_KEY, w.name);
  }, []);

  const disconnect = useCallback(() => {
    if (wallet) {
      try {
        const feature = getWalletFeature(
          wallet,
          "standard:disconnect",
        ) as StandardDisconnectFeature["standard:disconnect"];
        void feature.disconnect();
      } catch {
        // Not all wallets support disconnect
      }
    }
    setSelectedName(null);
    localStorage.removeItem(STORAGE_KEY);
  }, [wallet]);

  // Auto-reconnect on mount when a wallet name is saved
  const autoConnected = useRef(false);
  useEffect(() => {
    if (wallet && !connected && !autoConnected.current) {
      autoConnected.current = true;
      connect(wallet).catch(() => {
        setSelectedName(null);
        localStorage.removeItem(STORAGE_KEY);
      });
    }
  }, [wallet, connected, connect]);

  const value = useMemo(
    () => ({ wallets, wallet, account, connected, connect, disconnect }),
    [wallets, wallet, account, connected, connect, disconnect],
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within WalletProvider");
  return ctx;
}

export type { UiWallet, UiWalletAccount };
