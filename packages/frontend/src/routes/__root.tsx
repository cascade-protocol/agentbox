import { useWalletConnection } from "@solana/react-hooks";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { BadgeCheck, Coins, Loader2, LogOut, ShieldCheck, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ErrorBoundary } from "../components/error-boundary";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Toaster } from "../components/ui/sonner";
import { clearToken, getToken, setIsAdmin, setToken } from "../lib/api";
import { truncateAddress } from "../lib/format";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

function RootLayout() {
  const [token, setTokenState] = useState(() => getToken());
  const { connectors, connect, disconnect, wallet, connected } = useWalletConnection();
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const signIn = useCallback(async (w: NonNullable<typeof wallet>) => {
    setSigningIn(true);
    setError(null);
    try {
      const timestamp = Date.now();
      const message = `Sign in to AgentBox\nTimestamp: ${timestamp}`;
      const encoded = new TextEncoder().encode(message);
      if (!w.signMessage) {
        throw new Error("Wallet does not support message signing");
      }
      const sigBytes = await w.signMessage(encoded);
      const signature = btoa(String.fromCharCode(...sigBytes));

      const res = await fetch("/api/instances/auth", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          solanaWalletAddress: w.account.address,
          signature,
          timestamp,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Auth failed" }));
        throw new Error(body.error ?? "Auth failed");
      }

      const data = await res.json();
      setToken(data.token);
      setIsAdmin(data.isAdmin ?? false);
      setTokenState(data.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Sign-in failed");
    } finally {
      setSigningIn(false);
    }
  }, []);

  useEffect(() => {
    if (connected && wallet && !getToken()) {
      signIn(wallet);
    }
  }, [connected, wallet, signIn]);

  if (!token) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-md">
          <CardHeader className="space-y-2">
            <CardTitle className="text-xl">AgentBox</CardTitle>
            <p className="text-sm font-medium">Dedicated AI agent VMs in 60 seconds</p>
            <ul className="space-y-1 text-sm text-muted-foreground">
              <li className="flex items-center gap-2">
                <BadgeCheck className="size-4" />
                OpenClaw gateway + web terminal
              </li>
              <li className="flex items-center gap-2">
                <ShieldCheck className="size-4" />
                HTTPS + Solana wallet + SATI identity
              </li>
              <li className="flex items-center gap-2">
                <Coins className="size-4" />
                $1 USDC for 30 days
              </li>
            </ul>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {signingIn ? (
              <Button disabled>
                <Loader2 className="size-4 animate-spin" />
                Signing in...
              </Button>
            ) : (
              connectors.map((c) => (
                <Button key={c.id} onClick={() => connect(c.id)} variant="outline">
                  <Wallet className="size-4" />
                  {c.name}
                </Button>
              ))
            )}
            <p className="text-xs text-muted-foreground">
              You&apos;ll sign a message to prove ownership. No funds are transferred.
            </p>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <Toaster />
      <header className="shrink-0 border-b px-4 md:px-6">
        <div className="container mx-auto flex h-14 max-w-4xl items-center justify-between">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            AgentBox
          </Link>
          <div className="flex items-center gap-3">
            {wallet && (
              <span className="font-mono text-sm text-muted-foreground">
                {truncateAddress(wallet.account.address)}
              </span>
            )}
            <button
              type="button"
              onClick={() => {
                clearToken();
                setTokenState(null);
                disconnect();
              }}
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
            >
              <LogOut className="size-3.5" />
              Disconnect
            </button>
          </div>
        </div>
      </header>
      <div className="flex min-h-0 flex-1 flex-col overflow-auto">
        <ErrorBoundary>
          <Outlet />
        </ErrorBoundary>
      </div>
    </div>
  );
}

function NotFoundPage() {
  return (
    <main className="flex flex-1 items-center justify-center p-4">
      <Card className="w-full max-w-md">
        <CardHeader>
          <CardTitle>Page not found</CardTitle>
        </CardHeader>
        <CardContent>
          <Button asChild>
            <Link to="/">Go to Dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
