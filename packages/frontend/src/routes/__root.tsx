import { useLogin, usePrivy, type WalletWithMetadata } from "@privy-io/react-auth";
import { createRootRoute, Link, Outlet, useNavigate, useRouterState } from "@tanstack/react-router";
import {
  ArrowRight,
  BadgeCheck,
  Bot,
  Coins,
  Loader2,
  LogOut,
  Server,
  ShieldCheck,
  TerminalSquare,
  Wallet,
  WalletCards,
} from "lucide-react";
import { useEffect, useState } from "react";
import { ErrorBoundary } from "../components/error-boundary";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { Toaster } from "../components/ui/sonner";
import { env } from "../env";
import { API_URL, clearToken, getToken, getTokenWallet, setIsAdmin, setToken } from "../lib/api";
import { truncateAddress } from "../lib/format";
import { useActiveWallet } from "../lib/solana";

export const Route = createRootRoute({
  component: RootLayout,
  notFoundComponent: NotFoundPage,
});

function RootLayout() {
  const [token, setTokenState] = useState(() => getToken());
  const {
    ready,
    authenticated: privyAuthenticated,
    logout: privyLogout,
    getAccessToken,
  } = usePrivy();
  const navigate = useNavigate();
  const pathname = useRouterState({
    select: (state) => state.location.pathname,
  });
  const inDashboard =
    pathname === "/dashboard" ||
    pathname.startsWith("/dashboard/") ||
    pathname.startsWith("/instances/");
  const [signingIn, setSigningIn] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const activeWallet = useActiveWallet();
  const walletAddress = activeWallet?.address ?? null;
  const authenticated = token && walletAddress && getTokenWallet() === walletAddress;

  // Clear our JWT if Privy session expired
  useEffect(() => {
    if (ready && !privyAuthenticated && token) {
      clearToken();
      setTokenState(null);
    }
  }, [ready, privyAuthenticated, token]);

  async function signIn(address: string) {
    setSigningIn(true);
    setError(null);
    try {
      const privyToken = await getAccessToken();
      if (!privyToken) throw new Error("No Privy session");

      const res = await fetch(`${API_URL}/instances/auth`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          privyToken,
          solanaWalletAddress: address,
        }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({ error: "Auth failed" }));
        throw new Error(body.error ?? "Auth failed");
      }

      const data = await res.json();
      setToken(data.token, address);
      setIsAdmin(data.isAdmin ?? false);
      setTokenState(data.token);
      return true;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Sign-in failed";
      setError(msg);
      return false;
    } finally {
      setSigningIn(false);
    }
  }

  const { login } = useLogin({
    onComplete: async ({ user }) => {
      const solanaWallets = user.linkedAccounts.filter(
        (a): a is WalletWithMetadata => a.type === "wallet" && a.chainType === "solana",
      );
      const wallet = solanaWallets.find((w) => w.walletClientType !== "privy") ?? solanaWallets[0];
      if (!wallet) return;

      const ok = await signIn(wallet.address);
      if (ok) void navigate({ to: "/dashboard" });
    },
  });

  // Restore session on page reload when Privy session exists but JWT is missing
  useEffect(() => {
    if (!privyAuthenticated || !activeWallet || token || signingIn) return;
    void signIn(activeWallet.address);
  }, [privyAuthenticated, activeWallet, token, signingIn]);

  async function logout() {
    clearToken();
    setTokenState(null);
    await privyLogout();
    void navigate({ to: "/" });
  }

  // Privy not ready yet
  if (!ready) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <Loader2 className="size-8 animate-spin text-primary" />
      </div>
    );
  }

  // Auto-signing in - show loading (only block dashboard routes)
  if (inDashboard && signingIn) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <div className="flex flex-col items-center gap-3">
          <Loader2 className="size-8 animate-spin text-primary" />
          <p className="text-sm text-muted-foreground">Signing in...</p>
        </div>
      </div>
    );
  }

  // Authenticated - show dashboard
  if (inDashboard && authenticated) {
    return (
      <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
        <Toaster />
        <header className="shrink-0 border-b border-border/80 bg-background/80 px-4 backdrop-blur md:px-6">
          <div className="container mx-auto flex h-14 max-w-6xl items-center justify-between">
            <Link to="/" className="text-lg font-bold tracking-tight">
              AgentBox Control
            </Link>
            <div className="flex items-center gap-3">
              <a
                href="https://github.com/cascade-protocol/agentbox"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <svg
                  role="img"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                  className="size-4.5 fill-current"
                >
                  <title>GitHub</title>
                  <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
                </svg>
                <span className="sr-only">GitHub</span>
              </a>
              <a
                href="https://x.com/agentbox_fyi"
                target="_blank"
                rel="noopener noreferrer"
                className="text-muted-foreground transition-colors hover:text-foreground"
              >
                <svg
                  role="img"
                  viewBox="0 0 24 24"
                  xmlns="http://www.w3.org/2000/svg"
                  className="size-4.5 fill-current"
                >
                  <title>X</title>
                  <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
                </svg>
                <span className="sr-only">X</span>
              </a>
              {walletAddress && (
                <span className="rounded-md bg-muted/70 px-2 py-1 font-mono text-xs text-muted-foreground">
                  {truncateAddress(walletAddress)}
                </span>
              )}
              <button
                type="button"
                onClick={() => void logout()}
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
          <Footer />
        </div>
      </div>
    );
  }

  // Dashboard but not authenticated - show login
  if (inDashboard) {
    return (
      <div className="flex min-h-screen flex-col bg-background">
        <div className="flex flex-1 items-center justify-center p-4">
          <Card className="w-full max-w-sm">
            <CardHeader className="text-center">
              <CardTitle className="text-xl font-semibold tracking-tight">Open Dashboard</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button onClick={login} className="w-full">
                <Wallet className="size-4" />
                Login
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                Connect your Solana wallet to continue.
              </p>
            </CardContent>
          </Card>
        </div>
        <Footer />
      </div>
    );
  }

  // Landing page
  return (
    <div className="relative min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border/70 bg-background/75 backdrop-blur">
        <div className="container mx-auto flex h-14 max-w-6xl items-center justify-between px-4 md:px-6">
          <span className="text-sm font-semibold tracking-wide">AgentBox</span>
          <div className="flex items-center gap-3">
            <a
              href="https://github.com/cascade-protocol/agentbox"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <svg
                role="img"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
                className="size-4.5 fill-current"
              >
                <title>GitHub</title>
                <path d="M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12" />
              </svg>
              <span className="sr-only">GitHub</span>
            </a>
            <a
              href="https://x.com/agentbox_fyi"
              target="_blank"
              rel="noopener noreferrer"
              className="text-muted-foreground transition-colors hover:text-foreground"
            >
              <svg
                role="img"
                viewBox="0 0 24 24"
                xmlns="http://www.w3.org/2000/svg"
                className="size-4.5 fill-current"
              >
                <title>X</title>
                <path d="M18.901 1.153h3.68l-8.04 9.19L24 22.846h-7.406l-5.8-7.584-6.638 7.584H.474l8.6-9.83L0 1.154h7.594l5.243 6.932ZM17.61 20.644h2.039L6.486 3.24H4.298Z" />
              </svg>
              <span className="sr-only">X</span>
            </a>
            {authenticated ? (
              <Button asChild size="sm">
                <Link to="/dashboard">Dashboard</Link>
              </Button>
            ) : env.enableInstanceCreation ? (
              <Button size="sm" onClick={login}>
                Launch for 5 USDC
              </Button>
            ) : (
              <Button size="sm" disabled>
                Coming soon
              </Button>
            )}
          </div>
        </div>
      </header>

      <main className="container mx-auto max-w-6xl space-y-12 px-4 py-10 md:space-y-16 md:px-6 md:py-12">
        <section className="grid gap-8 lg:grid-cols-[1.05fr_0.95fr] lg:items-center">
          <div className="space-y-6">
            <p className="inline-flex rounded-full border border-primary/35 bg-primary/12 px-3 py-1 text-xs font-semibold tracking-wide text-primary">
              x402 payments on Solana. No API keys.
            </p>
            <div className="space-y-4">
              <h1 className="text-4xl font-semibold leading-tight tracking-tight text-foreground md:text-5xl">
                Agent in a Box
              </h1>
              <p className="max-w-2xl text-base text-muted-foreground md:text-lg">
                A ready-to-use OpenClaw agent on its own VM. It pays for AI models via x402, talks
                to you on Telegram, and can call any paid API autonomously. Running in 3 minutes.
              </p>
            </div>
            <div className="space-y-3">
              {authenticated ? (
                <Button asChild size="lg">
                  <Link to="/dashboard">
                    Go to Dashboard
                    <ArrowRight className="size-4" />
                  </Link>
                </Button>
              ) : env.enableInstanceCreation ? (
                <Button size="lg" onClick={login}>
                  Launch for 5 USDC
                  <ArrowRight className="size-4" />
                </Button>
              ) : (
                <Button size="lg" disabled>
                  Coming soon
                </Button>
              )}
              <p className="text-sm text-muted-foreground">7 days, no subscription</p>
              <p className="max-w-2xl text-sm text-muted-foreground">
                Setting up OpenClaw takes a VPS, DNS, TLS, API keys, and an afternoon. Or pay 5 USDC
                and skip all of it.
              </p>
            </div>
          </div>

          <div className="overflow-hidden rounded-xl border border-border/80 bg-[#131416] font-mono text-xs leading-relaxed shadow-lg">
            <div className="border-b border-[#2B2F36] px-3 py-1.5 text-[#F6C453]">
              openclaw tui --url wss://my-agent.agentbox.fyi
            </div>
            <div className="space-y-3 px-4 py-3">
              <p className="text-[#7B7F87]">session agent:main:main</p>
              <p className="text-[#7DD3A5]">
                ✅ New session started · model: anthropic/claude-sonnet-4-5
              </p>
              <div className="rounded bg-[#2B2F36] px-2.5 py-1.5 text-[#F3EEE0]">
                Wake up, my friend!
              </div>
              <p className="text-[#E8E3D5]">
                Hey! Just came online at my-agent.agentbox.fyi. Fresh workspace, no memories yet -
                just me and whatever we build from here. What&apos;s the plan? 🦞
              </p>
            </div>
            <div className="border-t border-[#2B2F36] px-3 py-1 text-[#7B7F87]">
              connected | idle
            </div>
            <div className="border-t border-[#2B2F36] px-3 py-1 text-[#7B7F87]">
              agent main | session main | anthropic/claude-sonnet-4-5 | tokens 1.2k/200k (0%)
            </div>
            <div className="border-t border-[#2B2F36] px-3 py-1.5 text-[#E8E3D5]">
              <span className="text-[#F6C453]">&gt;</span> <span className="animate-pulse">▋</span>
            </div>
          </div>
        </section>

        <section className="space-y-5">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">
            What&apos;s in the Box
          </h2>
          <div className="grid gap-4 md:grid-cols-2">
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <WalletCards className="size-4 text-primary" />
                  No API Keys
                </p>
                <p className="text-sm text-muted-foreground">
                  Your agent&apos;s wallet pays for Claude, GPT-5, DeepSeek, and more via USDC. Free
                  model included, top up for premium.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <ShieldCheck className="size-4 text-primary" />
                  Full VM Isolation
                </p>
                <p className="text-sm text-muted-foreground">
                  A dedicated machine, not a shared container. Your agent&apos;s keys, context, and
                  data can&apos;t leak because there&apos;s nothing shared.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <BadgeCheck className="size-4 text-primary" />
                  On-Chain Identity
                </p>
                <p className="text-sm text-muted-foreground">
                  Registered on-chain the moment it boots. Builds verifiable reputation from your
                  first interaction. Powered by SATI, ERC-8004 on Solana.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <Bot className="size-4 text-primary" />
                  OpenClaw Runtime
                </p>
                <p className="text-sm text-muted-foreground">
                  Full agent framework with 4,500+ community skills, tool access, and MCP servers.
                  Dashboard and terminal in your browser.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <TerminalSquare className="size-4 text-primary" />
                  Live at {"{name}"}.agentbox.fyi
                </p>
                <p className="text-sm text-muted-foreground">
                  HTTPS with automatic TLS. Your agent gets its own domain.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="flex items-center gap-2 text-sm font-semibold">
                  <Coins className="size-4 text-primary" />5 USDC. 7 days. No strings.
                </p>
                <p className="text-sm text-muted-foreground">
                  Spin up, experiment, let it expire. Need another? Deploy again in 3 minutes.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="space-y-5">
          <h2 className="text-2xl font-semibold tracking-tight md:text-3xl">Three Steps</h2>
          <div className="grid gap-4 md:grid-cols-3">
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="text-xs font-semibold tracking-wider text-primary">STEP 1</p>
                <p className="text-sm font-semibold">Connect your Solana wallet</p>
                <p className="text-sm text-muted-foreground">
                  Phantom, Solflare, or any Solana wallet.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="text-xs font-semibold tracking-wider text-primary">STEP 2</p>
                <p className="text-sm font-semibold">Pay 5 USDC</p>
                <p className="text-sm text-muted-foreground">
                  One transaction. No account, no subscription, no Stripe.
                </p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="space-y-2 pt-5">
                <p className="text-xs font-semibold tracking-wider text-primary">STEP 3</p>
                <p className="text-sm font-semibold">Your agent is live</p>
                <p className="text-sm text-muted-foreground">
                  Dashboard, terminal, wallet, identity. All running at your-name.agentbox.fyi.
                </p>
              </CardContent>
            </Card>
          </div>
        </section>

        <section className="grid gap-4 lg:grid-cols-[1.05fr_0.95fr]">
          <Card>
            <CardHeader>
              <CardTitle className="text-2xl font-semibold tracking-tight md:text-3xl">
                5 USDC / 7 days
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm text-muted-foreground">
              <p className="flex items-start gap-2">
                <Server className="mt-0.5 size-4 shrink-0 text-primary" />
                Dedicated VM (2 vCPU, 4 GB RAM, 80 GB disk)
              </p>
              <p className="flex items-start gap-2">
                <WalletCards className="mt-0.5 size-4 shrink-0 text-primary" />
                Pre-funded wallet (free model included, top up anytime)
              </p>
              <p className="flex items-start gap-2">
                <TerminalSquare className="mt-0.5 size-4 shrink-0 text-primary" />
                Full root access via web terminal
              </p>
              <p className="flex items-start gap-2">
                <BadgeCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                HTTPS at {"{name}"}.agentbox.fyi
              </p>
              <p className="flex items-start gap-2">
                <ShieldCheck className="mt-0.5 size-4 shrink-0 text-primary" />
                On-chain agent identity
              </p>
              <p className="flex items-start gap-2">
                <Coins className="mt-0.5 size-4 shrink-0 text-primary" />
                No auto-renewal. Expires cleanly. Extend anytime.
              </p>
            </CardContent>
          </Card>

          <Card id="connect-wallet">
            <CardHeader>
              <CardTitle className="text-xl font-semibold tracking-tight">
                {authenticated ? "Welcome back" : "Deploy your agent"}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              {authenticated && walletAddress ? (
                <>
                  <p className="font-mono text-xs text-muted-foreground">
                    {truncateAddress(walletAddress)}
                  </p>
                  <Button asChild className="w-full">
                    <Link to="/dashboard">
                      Go to Dashboard
                      <ArrowRight className="size-4" />
                    </Link>
                  </Button>
                </>
              ) : (
                <>
                  {error && <p className="text-sm text-destructive">{error}</p>}
                  <Button onClick={login} className="w-full">
                    <Wallet className="size-4" />
                    {env.enableInstanceCreation ? "Launch for 5 USDC" : "Login"}
                  </Button>
                  <p className="text-xs text-muted-foreground">
                    {env.enableInstanceCreation
                      ? "Connect your Solana wallet, then complete a single 5 USDC transaction."
                      : "Wallet connection is live. Instance creation is temporarily disabled while we finish the product."}
                  </p>
                </>
              )}
            </CardContent>
          </Card>
        </section>
      </main>

      <Footer />
    </div>
  );
}

function Footer() {
  return (
    <footer className="shrink-0 border-t border-border/70 px-4 py-6 text-center text-sm text-muted-foreground md:px-6">
      AgentBox by Cascade | Questions? DM{" "}
      <a
        href="https://x.com/opwizardx"
        target="_blank"
        rel="noopener noreferrer"
        className="underline hover:text-foreground"
      >
        @opwizardx
      </a>{" "}
      on X
    </footer>
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
            <Link to="/dashboard">Go to Dashboard</Link>
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}
