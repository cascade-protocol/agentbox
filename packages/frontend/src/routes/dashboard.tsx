import { createWalletTransactionSigner, type WalletSession } from "@solana/client";
import type { TransactionSigner } from "@solana/kit";
import { useSplToken, useWalletSession } from "@solana/react-hooks";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Check,
  ChevronDown,
  ChevronRight,
  Copy,
  ExternalLink,
  Loader2,
  Plus,
  RefreshCw,
  RotateCw,
  Send,
  Server,
  Shuffle,
  TerminalSquare,
  Trash2,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
import { Badge } from "../components/ui/badge";
import { Button } from "../components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../components/ui/card";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "../components/ui/table";
import { env } from "../env";
import { api, getIsAdmin, type Instance, instanceUrls } from "../lib/api";
import { formatDate, relativeTime, shortDate, truncateAddress } from "../lib/format";
import { generateAgentName } from "../lib/names";
import { getProvisioningStepLabel, getStatusVariant } from "../lib/status";

export const Route = createFileRoute("/dashboard")({
  component: Home,
});

function OpenClawIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 120 120" fill="none" className={className} role="img" aria-label="OpenClaw">
      <path
        d="M60 10C30 10 15 35 15 55C15 75 30 95 45 100L45 110 55 110 55 100C55 100 60 102 65 100L65 110 75 110 75 100C90 95 105 75 105 55C105 35 90 10 60 10Z"
        fill="#ff4d4d"
      />
      <path d="M20 45C5 40 0 50 5 60C10 70 20 65 25 55C28 48 25 45 20 45Z" fill="#ff4d4d" />
      <path
        d="M100 45C115 40 120 50 115 60C110 70 100 65 95 55C92 48 95 45 100 45Z"
        fill="#ff4d4d"
      />
      <path d="M45 15Q35 5 30 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <path d="M75 15Q85 5 90 8" stroke="#ff4d4d" strokeWidth="3" strokeLinecap="round" />
      <circle cx="45" cy="35" r="6" fill="#050810" />
      <circle cx="75" cy="35" r="6" fill="#050810" />
      <circle cx="46" cy="34" r="2.5" fill="#00e5cc" />
      <circle cx="76" cy="34" r="2.5" fill="#00e5cc" />
    </svg>
  );
}

function isExpiringSoon(expiresAt: string) {
  return new Date(expiresAt).getTime() - Date.now() < 3 * 24 * 60 * 60 * 1000;
}

function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function StatusDisplay({ instance }: { instance: Instance }) {
  return (
    <div className="space-y-1">
      <Badge variant={getStatusVariant(instance.status)}>{formatStatus(instance.status)}</Badge>
      {instance.status === "provisioning" && (
        <p className="animate-pulse text-xs text-muted-foreground">
          {getProvisioningStepLabel(instance.provisioningStep)}
        </p>
      )}
      {instance.status === "minting" && (
        <p className="animate-pulse text-xs text-muted-foreground">Minting identity NFT...</p>
      )}
    </div>
  );
}

function HomeSkeleton() {
  return (
    <main className="container mx-auto flex-1 max-w-6xl px-4 py-6 md:py-8">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div className="space-y-2">
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-4 w-56" />
          </div>
          <Skeleton className="h-8 w-28" />
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          {["total", "running", "expiring"].map((item) => (
            <Card key={item}>
              <CardHeader className="pb-2">
                <Skeleton className="h-4 w-24" />
              </CardHeader>
              <CardContent>
                <Skeleton className="h-8 w-12" />
              </CardContent>
            </Card>
          ))}
        </div>

        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-32" />
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="hidden space-y-2 md:block">
              {["row-1", "row-2", "row-3", "row-4", "row-5"].map((item) => (
                <Skeleton key={item} className="h-10 w-full" />
              ))}
            </div>
            <div className="space-y-3 md:hidden">
              {["card-1", "card-2", "card-3"].map((item) => (
                <Skeleton key={item} className="h-28 w-full" />
              ))}
            </div>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const USDC_PRICE = 5;
const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{35}$/;
const NAME_RE = /^[a-z0-9][a-z0-9-]*[a-z0-9]$/;

function CopyChip({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <code className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 text-xs">
      {value}
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard.writeText(value);
          setCopied(true);
          setTimeout(() => setCopied(false), 2000);
        }}
        className="inline-flex size-5 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent"
      >
        {copied ? (
          <Check className="size-3 text-green-500" />
        ) : (
          <Copy className="size-3 text-muted-foreground" />
        )}
      </button>
    </code>
  );
}

function CreateInstanceDialog({
  session,
  open,
  onOpenChange,
  onCreated,
}: {
  session: WalletSession;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: () => Promise<void>;
}) {
  const signer: TransactionSigner = useMemo(
    () => createWalletTransactionSigner(session).signer,
    [session],
  );
  const { balance } = useSplToken(USDC_MINT);
  const usdcBalance = Number(balance?.uiAmount ?? 0);
  const hasEnough = usdcBalance >= USDC_PRICE;
  const [creating, setCreating] = useState(false);
  const [createdInstance, setCreatedInstance] = useState<Instance | null>(null);
  const [name, setName] = useState(generateAgentName);
  const [showTelegram, setShowTelegram] = useState(false);
  const [telegramToken, setTelegramToken] = useState("");
  const telegramValid = telegramToken === "" || TELEGRAM_TOKEN_RE.test(telegramToken.trim());
  const nameValid = name.length >= 3 && name.length <= 63 && NAME_RE.test(name);

  const suggestedBotName = name
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const suggestedBotUsername = `ab_${name.replace(/-/g, "_")}_bot`;

  function resetDialog() {
    setCreatedInstance(null);
    setTelegramToken("");
    setShowTelegram(false);
    setName(generateAgentName());
  }

  async function handleCreate() {
    setCreating(true);
    try {
      const opts: { name: string; telegramBotToken?: string } = { name };
      if (telegramToken.trim()) opts.telegramBotToken = telegramToken.trim();
      const instance = await api.instances.create(signer, opts);
      await onCreated();
      if (instance.telegramBotUsername) {
        setCreatedInstance(instance);
      } else {
        toast.success("Agent launched - provisioning will take ~3 minutes");
        onOpenChange(false);
        resetDialog();
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) resetDialog();
        onOpenChange(v);
      }}
    >
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Create Instance
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        {createdInstance ? (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <Check className="size-5 text-green-500" />
                Instance Created
              </DialogTitle>
              <DialogDescription>
                Your agent is provisioning and will be ready in ~3 minutes.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border border-green-500/20 bg-green-500/5 px-4 py-3">
              <p className="text-sm font-medium">Open your bot and press Start</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Your message will be queued and the agent will reply as soon as it's ready.
              </p>
              <a
                href={`https://t.me/${createdInstance.telegramBotUsername}?start=hi`}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-3 inline-flex items-center gap-2 rounded-md bg-[#2AABEE] px-4 py-2 text-sm font-medium text-white hover:bg-[#229ED9] transition-colors"
              >
                <Send className="size-4" />
                Open @{createdInstance.telegramBotUsername}
                <ExternalLink className="size-3.5" />
              </a>
            </div>
            <DialogFooter>
              <Link to="/instances/$id" params={{ id: String(createdInstance.id) }}>
                <Button
                  variant="outline"
                  onClick={() => {
                    onOpenChange(false);
                    resetDialog();
                  }}
                >
                  Go to instance
                </Button>
              </Link>
              <Button
                onClick={() => {
                  onOpenChange(false);
                  resetDialog();
                }}
              >
                Done
              </Button>
            </DialogFooter>
          </>
        ) : (
          <>
            <DialogHeader>
              <DialogTitle>Launch Agent</DialogTitle>
              <DialogDescription>
                Launch a new AgentBox agent for {USDC_PRICE} USDC on Solana (7 days). Your wallet
                will be prompted to approve the payment.
              </DialogDescription>
            </DialogHeader>
            <div className="rounded-md border px-4 py-3 text-sm">
              <div className="flex items-center justify-between">
                <span className="text-muted-foreground">Your Solana USDC balance</span>
                <span className={hasEnough ? "text-foreground" : "text-destructive font-medium"}>
                  {balance ? `${usdcBalance.toFixed(2)} USDC` : "Loading..."}
                </span>
              </div>
              {balance && !hasEnough && (
                <p className="mt-2 text-destructive text-xs">
                  Insufficient balance. You need at least {USDC_PRICE} USDC on Solana to launch an
                  agent. Make sure your USDC is on Solana, not another chain.
                </p>
              )}
            </div>
            <div className="space-y-1.5">
              <label htmlFor="instance-name" className="text-sm text-muted-foreground">
                Agent name
              </label>
              <div className="flex gap-2">
                <input
                  id="instance-name"
                  className="flex-1 rounded-md border border-input bg-muted px-3 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                  value={name}
                  onChange={(e) => setName(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ""))}
                  disabled={creating}
                />
                <Button
                  type="button"
                  variant="outline"
                  size="icon"
                  onClick={() => setName(generateAgentName())}
                  disabled={creating}
                  title="Randomize name"
                >
                  <Shuffle className="size-4" />
                </Button>
              </div>
              {name && !nameValid && (
                <p className="text-xs text-destructive">
                  3-63 chars, lowercase letters, numbers, and hyphens
                </p>
              )}
            </div>
            <div>
              <button
                type="button"
                onClick={() => setShowTelegram(!showTelegram)}
                className="flex w-full items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
              >
                <Send className="size-3.5" />
                <span>Connect Telegram Bot (optional)</span>
                <ChevronDown
                  className={`ml-auto size-4 transition-transform ${showTelegram ? "rotate-180" : ""}`}
                />
              </button>
              {showTelegram && (
                <div className="mt-3 space-y-3">
                  <ol className="space-y-2 text-sm text-muted-foreground">
                    <li className="flex items-start gap-2">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground">
                        1
                      </span>
                      <span>
                        Open{" "}
                        <a
                          href="https://t.me/BotFather"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-primary hover:underline"
                        >
                          @BotFather
                        </a>{" "}
                        in Telegram and send <CopyChip value="/newbot" />
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground">
                        2
                      </span>
                      <span>
                        For the name, send: <CopyChip value={suggestedBotName} />
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground">
                        3
                      </span>
                      <span>
                        For the username, send: <CopyChip value={suggestedBotUsername} />
                      </span>
                    </li>
                    <li className="flex items-start gap-2">
                      <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground">
                        4
                      </span>
                      <span>Copy the bot token and paste it below</span>
                    </li>
                  </ol>
                  <input
                    className="w-full rounded-md border border-input bg-muted px-3 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                    placeholder="123456789:ABCdefGHI..."
                    value={telegramToken}
                    onChange={(e) => setTelegramToken(e.target.value)}
                    disabled={creating}
                  />
                  {telegramToken && !telegramValid && (
                    <p className="text-xs text-destructive">Invalid bot token format</p>
                  )}
                </div>
              )}
            </div>
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline" disabled={creating}>
                  Cancel
                </Button>
              </DialogClose>
              <Button
                onClick={() => void handleCreate()}
                disabled={creating || !hasEnough || !nameValid || !telegramValid}
              >
                {creating && <Loader2 className="size-4 animate-spin" />}
                {creating ? "Creating..." : `Pay ${USDC_PRICE} USDC & Create`}
              </Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  );
}

function Home() {
  const navigate = useNavigate();
  const session = useWalletSession();
  const instanceCreationEnabled = env.enableInstanceCreation;
  const admin = getIsAdmin();
  const [showAll, setShowAll] = useState(false);
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingChain, setSyncingChain] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const [createOpen, setCreateOpen] = useState(false);

  const [confirmAction, setConfirmAction] = useState<{
    type: "restart" | "delete";
    instance: Instance;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchInstances = useCallback(
    async ({ showErrorToast = false }: { showErrorToast?: boolean } = {}) => {
      try {
        const data = await api.instances.list(showAll);
        setInstances(data.instances);
        setLastChecked(new Date());
      } catch (err) {
        if (showErrorToast) {
          const message = err instanceof Error ? err.message : "Failed to load instances";
          toast.error(message, { id: "instances-load-error" });
        }
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [showAll],
  );

  useEffect(() => {
    setLoading(true);
    void fetchInstances();
  }, [fetchInstances]);

  const hasFastPolling = instances.some(
    (instance) => instance.status === "provisioning" || instance.status === "minting",
  );

  useEffect(() => {
    const intervalMs = hasFastPolling ? 10_000 : 30_000;
    const interval = setInterval(() => {
      if (!document.hidden) {
        void fetchInstances();
      }
    }, intervalMs);
    return () => clearInterval(interval);
  }, [fetchInstances, hasFastPolling]);

  async function handleConfirm() {
    if (!confirmAction) {
      return;
    }

    setActionLoading(true);
    try {
      if (confirmAction.type === "restart") {
        await api.instances.restart(confirmAction.instance.id);
        toast.success("Agent restarting");
      } else {
        await api.instances.delete(confirmAction.instance.id);
        toast.success("Agent deleted");
      }
      setConfirmAction(null);
      await fetchInstances();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${confirmAction.type} failed`);
    } finally {
      setActionLoading(false);
    }
  }

  async function handleSyncFromChain() {
    setSyncingChain(true);
    try {
      const result = await api.instances.sync();
      setInstances(result.instances);
      setLastChecked(new Date());
      const total = result.claimed + result.recovered;
      if (total > 0) {
        toast.success(`Synced ${total} instances from chain`);
      } else {
        toast.success("Everything up to date");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to sync from chain");
    } finally {
      setSyncingChain(false);
    }
  }

  const running = instances.filter((instance) => instance.status === "running").length;
  const expiring = instances.filter((instance) => isExpiringSoon(instance.expiresAt)).length;

  if (loading) {
    return <HomeSkeleton />;
  }

  return (
    <main className="container mx-auto flex-1 max-w-6xl px-4 py-6 md:py-8">
      <div className="space-y-6">
        <div className="rounded-xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur md:p-5">
          <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
            <div>
              <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Agents</h1>
              <p className="mt-1 text-sm text-muted-foreground">Manage your AgentBox agents</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {admin && (
                <label className="flex h-8 cursor-pointer select-none items-center gap-1.5 rounded-md border border-border px-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={showAll}
                    onChange={(e) => setShowAll(e.target.checked)}
                    className="accent-primary"
                  />
                  All
                </label>
              )}
              {lastChecked && (
                <span className="hidden rounded-md bg-muted px-2 py-1 text-xs text-muted-foreground sm:inline">
                  {relativeTime(lastChecked.toISOString())}
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  setRefreshing(true);
                  void fetchInstances({ showErrorToast: true });
                }}
              >
                <RefreshCw className={`size-4 ${refreshing ? "animate-spin" : ""}`} />
                Refresh
              </Button>
              {instanceCreationEnabled && session ? (
                <CreateInstanceDialog
                  session={session}
                  open={createOpen}
                  onOpenChange={setCreateOpen}
                  onCreated={() => fetchInstances()}
                />
              ) : (
                <Button size="sm" disabled>
                  <Plus className="size-4" />
                  Coming soon
                </Button>
              )}
            </div>
          </div>
        </div>

        <div className="grid gap-4 md:grid-cols-3">
          <Card className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Total
              </CardTitle>
              <Server className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tracking-tight">{instances.length}</div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Running
              </CardTitle>
              <Activity className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tracking-tight">{running}</div>
            </CardContent>
          </Card>
          <Card className="shadow-sm">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                Expiring Soon
              </CardTitle>
              <AlertTriangle className="size-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-3xl font-bold tracking-tight">{expiring}</div>
            </CardContent>
          </Card>
        </div>

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between border-b border-border/60">
            <CardTitle className="text-base">All Instances</CardTitle>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void handleSyncFromChain()}
              disabled={syncingChain}
            >
              <RefreshCw className={`size-4 ${syncingChain ? "animate-spin" : ""}`} />
              Refresh from chain
            </Button>
          </CardHeader>
          <CardContent>
            {instances.length === 0 ? (
              <div className="rounded-lg border border-dashed border-border/60 bg-background/60 py-10 text-center">
                <Server className="mx-auto size-10 text-muted-foreground" />
                <h3 className="mt-3 text-lg font-semibold tracking-tight">No instances yet</h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  Instance creation is temporarily disabled while we finish the product.
                </p>
                <Button className="mt-4" disabled>
                  <Plus className="size-4" />
                  Coming soon
                </Button>
              </div>
            ) : (
              <>
                <div className="hidden md:block">
                  <Table>
                    <TableHeader className="bg-muted/35">
                      <TableRow className="hover:bg-muted/50">
                        <TableHead className="pl-3">Name</TableHead>
                        <TableHead>Owner</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead>Expires</TableHead>
                        <TableHead className="pr-3 text-right">Actions</TableHead>
                        <TableHead className="w-8" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {instances.map((instance) => {
                        const urls = instanceUrls(
                          instance.name,
                          instance.gatewayToken,
                          instance.terminalToken,
                        );
                        return (
                          <TableRow
                            key={instance.id}
                            className="group/row cursor-pointer"
                            onClick={() =>
                              navigate({
                                to: "/instances/$id",
                                params: { id: String(instance.id) },
                              })
                            }
                          >
                            <TableCell className="max-w-[240px] pl-3">
                              <Link
                                to="/instances/$id"
                                params={{ id: String(instance.id) }}
                                className="truncate text-sm font-medium transition-colors group-hover/row:text-primary"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {instance.name}
                              </Link>
                            </TableCell>
                            <TableCell
                              title={instance.ownerWallet}
                              className="text-sm text-muted-foreground"
                            >
                              {truncateAddress(instance.ownerWallet)}
                            </TableCell>
                            <TableCell>
                              <StatusDisplay instance={instance} />
                            </TableCell>
                            <TableCell
                              title={formatDate(instance.createdAt)}
                              className="text-sm text-muted-foreground"
                            >
                              {shortDate(instance.createdAt)}
                            </TableCell>
                            <TableCell
                              title={formatDate(instance.expiresAt)}
                              className={`text-sm ${isExpiringSoon(instance.expiresAt) ? "font-medium text-destructive" : "text-muted-foreground"}`}
                            >
                              {relativeTime(instance.expiresAt)}
                            </TableCell>
                            <TableCell className="pr-3 text-right">
                              <div
                                role="toolbar"
                                className="flex items-center justify-end gap-1"
                                onClick={(e) => e.stopPropagation()}
                                onKeyDown={(e) => e.stopPropagation()}
                              >
                                {instance.telegramBotUsername ? (
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    asChild
                                    title="Open Telegram Bot"
                                  >
                                    <a
                                      href={`https://t.me/${instance.telegramBotUsername}`}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      <Send className="size-3.5" />
                                    </a>
                                  </Button>
                                ) : null}
                                {instance.status === "running" ? (
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    asChild
                                    title="OpenClaw Dashboard"
                                  >
                                    <a href={urls.chat} target="_blank" rel="noopener noreferrer">
                                      <OpenClawIcon className="size-3.5" />
                                    </a>
                                  </Button>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    title="OpenClaw Dashboard"
                                    disabled
                                  >
                                    <OpenClawIcon className="size-3.5" />
                                  </Button>
                                )}
                                {instance.status === "running" ? (
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    asChild
                                    title="Open Terminal"
                                  >
                                    <a
                                      href={urls.terminal}
                                      target="_blank"
                                      rel="noopener noreferrer"
                                    >
                                      <TerminalSquare className="size-3.5" />
                                    </a>
                                  </Button>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    title="Open Terminal"
                                    disabled
                                  >
                                    <TerminalSquare className="size-3.5" />
                                  </Button>
                                )}
                                <Button
                                  variant="outline"
                                  size="icon-sm"
                                  title="Restart"
                                  onClick={() =>
                                    setConfirmAction({
                                      type: "restart",
                                      instance,
                                    })
                                  }
                                  disabled={instance.status !== "running"}
                                >
                                  <RotateCw className="size-3.5" />
                                </Button>
                                <Button
                                  variant="ghost"
                                  size="icon-sm"
                                  title="Delete"
                                  className="text-destructive hover:text-destructive"
                                  onClick={() =>
                                    setConfirmAction({
                                      type: "delete",
                                      instance,
                                    })
                                  }
                                  disabled={instance.status === "deleting"}
                                >
                                  <Trash2 className="size-3.5" />
                                </Button>
                              </div>
                            </TableCell>
                            <TableCell className="w-8 pr-2">
                              <ChevronRight className="size-4 text-muted-foreground/50 transition-all duration-150 group-hover/row:translate-x-0.5 group-hover/row:text-muted-foreground" />
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                </div>

                <div className="space-y-3 md:hidden">
                  {instances.map((instance) => {
                    const urls = instanceUrls(
                      instance.name,
                      instance.gatewayToken,
                      instance.terminalToken,
                    );
                    return (
                      <Card
                        key={instance.id}
                        className="cursor-pointer transition-colors hover:bg-muted/30"
                        onClick={() =>
                          navigate({
                            to: "/instances/$id",
                            params: { id: String(instance.id) },
                          })
                        }
                      >
                        <CardContent className="space-y-3 px-4 py-4">
                          <div className="flex items-start justify-between gap-3">
                            <div className="flex min-w-0 items-center gap-1">
                              <Link
                                to="/instances/$id"
                                params={{ id: String(instance.id) }}
                                className="truncate text-sm font-semibold"
                                onClick={(e) => e.stopPropagation()}
                              >
                                {instance.name}
                              </Link>
                              <ChevronRight className="size-3.5 shrink-0 text-muted-foreground/50" />
                            </div>
                            <StatusDisplay instance={instance} />
                          </div>
                          <div className="space-y-1 text-xs">
                            <p className="text-muted-foreground" title={instance.ownerWallet}>
                              Owner {truncateAddress(instance.ownerWallet)}
                            </p>
                            <p
                              className="text-muted-foreground"
                              title={formatDate(instance.createdAt)}
                            >
                              Created {relativeTime(instance.createdAt)}
                            </p>
                            <p
                              className={
                                isExpiringSoon(instance.expiresAt)
                                  ? "font-medium text-destructive"
                                  : "text-muted-foreground"
                              }
                              title={formatDate(instance.expiresAt)}
                            >
                              Expires {relativeTime(instance.expiresAt)}
                            </p>
                          </div>
                          <div
                            role="toolbar"
                            className="grid grid-cols-4 gap-2"
                            onClick={(e) => e.stopPropagation()}
                            onKeyDown={(e) => e.stopPropagation()}
                          >
                            {instance.telegramBotUsername ? (
                              <Button
                                variant="outline"
                                size="icon-sm"
                                asChild
                                title="Open Telegram Bot"
                                className="w-full"
                              >
                                <a
                                  href={`https://t.me/${instance.telegramBotUsername}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                >
                                  <Send className="size-3.5" />
                                </a>
                              </Button>
                            ) : null}
                            {instance.status === "running" ? (
                              <Button
                                variant="outline"
                                size="icon-sm"
                                asChild
                                title="OpenClaw Dashboard"
                                className="w-full"
                              >
                                <a href={urls.chat} target="_blank" rel="noopener noreferrer">
                                  <OpenClawIcon className="size-3.5" />
                                </a>
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="icon-sm"
                                title="OpenClaw Dashboard"
                                className="w-full"
                                disabled
                              >
                                <OpenClawIcon className="size-3.5" />
                              </Button>
                            )}
                            {instance.status === "running" ? (
                              <Button
                                variant="outline"
                                size="icon-sm"
                                asChild
                                title="Open Terminal"
                                className="w-full"
                              >
                                <a href={urls.terminal} target="_blank" rel="noopener noreferrer">
                                  <TerminalSquare className="size-3.5" />
                                </a>
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="icon-sm"
                                title="Open Terminal"
                                className="w-full"
                                disabled
                              >
                                <TerminalSquare className="size-3.5" />
                              </Button>
                            )}
                            <Button
                              variant="outline"
                              size="icon-sm"
                              className="w-full"
                              title="Restart"
                              onClick={() =>
                                setConfirmAction({
                                  type: "restart",
                                  instance,
                                })
                              }
                              disabled={instance.status !== "running"}
                            >
                              <RotateCw className="size-3.5" />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon-sm"
                              className="w-full text-destructive hover:text-destructive"
                              title="Delete"
                              onClick={() =>
                                setConfirmAction({
                                  type: "delete",
                                  instance,
                                })
                              }
                              disabled={instance.status === "deleting"}
                            >
                              <Trash2 className="size-3.5" />
                            </Button>
                          </div>
                        </CardContent>
                      </Card>
                    );
                  })}
                </div>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) {
            setConfirmAction(null);
          }
        }}
      >
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>
              {confirmAction?.type === "restart" ? "Restart Agent" : "Delete Agent"}
            </DialogTitle>
            <DialogDescription>
              {confirmAction?.type === "restart"
                ? `This will reboot ${confirmAction.instance.name}. Active sessions will disconnect.`
                : `This will permanently destroy ${confirmAction?.instance.name}. This action cannot be undone.`}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={actionLoading}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant={confirmAction?.type === "delete" ? "destructive" : "default"}
              onClick={() => void handleConfirm()}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="size-4 animate-spin" />}
              {actionLoading
                ? confirmAction?.type === "restart"
                  ? "Restarting..."
                  : "Deleting..."
                : confirmAction?.type === "restart"
                  ? "Restart"
                  : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}
