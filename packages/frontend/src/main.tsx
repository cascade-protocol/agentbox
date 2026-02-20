import { createRouter, RouterProvider } from "@tanstack/react-router";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { WalletProvider } from "./lib/wallet";
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

const rootElement = document.getElementById("app");
if (rootElement && !rootElement.innerHTML) {
  createRoot(rootElement).render(
    <StrictMode>
      <WalletProvider>
        <RouterProvider router={router} />
      </WalletProvider>
    </StrictMode>,
  );
}
