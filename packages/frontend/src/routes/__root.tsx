import { createRootRoute, Link, Outlet } from "@tanstack/react-router";
import { useState } from "react";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import { clearToken, getToken, setToken } from "../lib/api";

export const Route = createRootRoute({
  component: RootLayout,
});

function RootLayout() {
  const [token, setTokenState] = useState(() => getToken());

  if (!token) {
    return (
      <TokenForm
        onSubmit={(t) => {
          setToken(t);
          setTokenState(t);
        }}
      />
    );
  }

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-background text-foreground">
      <header className="shrink-0 border-b px-4 md:px-6">
        <div className="container mx-auto flex h-14 items-center justify-between max-w-4xl">
          <Link to="/" className="text-lg font-semibold tracking-tight">
            AgentBox
          </Link>
          <button
            type="button"
            onClick={() => {
              clearToken();
              setTokenState(null);
            }}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            Logout
          </button>
        </div>
      </header>
      <div className="flex flex-1 flex-col min-h-0 overflow-auto">
        <Outlet />
      </div>
    </div>
  );
}

function TokenForm({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [value, setValue] = useState("");

  return (
    <div className="flex h-screen items-center justify-center bg-background px-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle className="text-xl">AgentBox</CardTitle>
          <p className="text-sm text-muted-foreground">Enter your operator token to continue</p>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim()) onSubmit(value.trim());
            }}
            className="flex flex-col gap-3"
          >
            <input
              type="password"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Operator token"
              className="h-9 rounded-md border bg-transparent px-3 py-1 text-sm shadow-xs transition-colors focus:outline-none focus:ring-[3px] focus:ring-ring/50 focus:border-ring"
            />
            <Button type="submit" disabled={!value.trim()}>
              Sign in
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
