import { useWalletConnection } from "@solana/react-hooks";
import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { Loader2, LogOut, Wallet } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { clearToken, getToken, setIsAdmin, setToken } from "../lib/api";

export const Route = createRootRoute({
  component: RootLayout,
});

function truncateAddress(addr: string) {
  return `${addr.slice(0, 4)}...${addr.slice(-4)}`;
}

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

  // Auto sign-in when wallet connects
  useEffect(() => {
    if (connected && wallet && !getToken()) {
      signIn(wallet);
    }
  }, [connected, wallet, signIn]);

  if (!token) {
    return (
      <div className="flex h-screen items-center justify-center bg-background px-4">
        <Card className="w-full max-w-sm">
          <CardHeader>
            <CardTitle className="text-xl">AgentBox</CardTitle>
            <p className="text-sm text-muted-foreground">Connect your Solana wallet to continue</p>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {error && <p className="text-sm text-destructive">{error}</p>}
            {signingIn ? (
              <Button disabled>
                <Loader2 className="h-4 w-4 animate-spin" />
                Signing in...
              </Button>
            ) : (
              connectors.map((c) => (
                <Button key={c.id} onClick={() => connect(c.id)} variant="outline">
                  <Wallet className="h-4 w-4" />
                  {c.name}
                </Button>
              ))
            )}
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="shrink-0 border-b px-4 md:px-6">
        <div className="container mx-auto flex h-14 items-center justify-between max-w-4xl">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            AgentBox
          </Link>
          <div className="flex items-center gap-3">
            {wallet && (
              <span className="text-sm text-muted-foreground font-mono">
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
              className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground transition-colors"
            >
              <LogOut className="h-3.5 w-3.5" />
              Disconnect
            </button>
          </div>
        </div>
      </header>
      <div className="flex flex-1 flex-col min-h-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}
