import { backpack, createDefaultClient, phantom, solflare } from "@solana/client";
import { SolanaProvider } from "@solana/react-hooks";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import { routeTree } from "./routeTree.gen";
import "./app.css";

// Required for @solana/kit RPC serialization
(BigInt.prototype as never as { toJSON: () => string }).toJSON = function () {
  return this.toString();
};

const router = createRouter({
  routeTree,
  defaultPreload: "intent",
});

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}

const client = createDefaultClient({
  cluster: "mainnet-beta",
  walletConnectors: [...phantom(), ...solflare(), ...backpack()],
});

const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
  createRoot(rootElement).render(
    <SolanaProvider client={client} walletPersistence={{ autoConnect: true }}>
      <RouterProvider router={router} />
    </SolanaProvider>,
  );
}
