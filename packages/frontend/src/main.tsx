import { autoDiscover, createClient } from "@solana/client";
import { SolanaProvider } from "@solana/react-hooks";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { routeTree } from "./routeTree.gen";
import "./app.css";

// Required for @solana/kit RPC serialization
(BigInt.prototype as never as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

const HELIUS_KEY = import.meta.env.VITE_HELIUS_API_KEY ?? "";
const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;
const WS_URL = `wss://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}`;

const solanaClient = createClient({
  cluster: "mainnet",
  rpc: RPC_URL,
  websocket: WS_URL,
  walletConnectors: autoDiscover(),
});

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
  createRoot(rootElement).render(
    <StrictMode>
      <SolanaProvider client={solanaClient}>
        <RouterProvider router={router} />
      </SolanaProvider>
    </StrictMode>,
  );
}
