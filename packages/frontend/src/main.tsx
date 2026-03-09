import { PrivyProvider } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import { createRouter, RouterProvider } from "@tanstack/react-router";
import { createRoot } from "react-dom/client";

import { env } from "./env";
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

const solanaConnectors = toSolanaWalletConnectors();

const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
  createRoot(rootElement).render(
    <PrivyProvider
      appId={env.privyAppId}
      config={{
        loginMethods: ["wallet"],
        appearance: {
          showWalletLoginFirst: true,
          walletChainType: "solana-only",
          walletList: ["phantom", "detected_solana_wallets"],
          theme: "dark",
        },
        externalWallets: {
          solana: { connectors: solanaConnectors },
        },
        embeddedWallets: {
          solana: { createOnLogin: "all-users" },
        },
      }}
    >
      <RouterProvider router={router} />
    </PrivyProvider>,
  );
}
