import { createWalletTransactionSigner, type WalletSession } from "@solana/client";
import type { TransactionSigner } from "@solana/kit";
import { useSplToken, useWalletSession } from "@solana/react-hooks";
import { createFileRoute, Link } from "@tanstack/react-router";
import {
  Activity,
  AlertTriangle,
  Check,
  Loader2,
  MessageSquare,
  Pencil,
  Plus,
  RefreshCw,
  RotateCw,
  Server,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { getProvisioningStepLabel, getStatusVariant } from "../lib/status";

export const Route = createFileRoute("/")({
  component: Home,
});

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

function EditableName({
  instance,
  onSave,
}: {
  instance: Instance;
  onSave: (id: number, name: string) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(instance.name);
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) {
      inputRef.current?.select();
    }
  }, [editing]);

  async function save() {
    const trimmed = value.trim();
    if (!trimmed || trimmed === instance.name) {
      setValue(instance.name);
      setEditing(false);
      return;
    }

    setSaving(true);
    try {
      await onSave(instance.id, trimmed);
      setEditing(false);
    } catch {
      setValue(instance.name);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  }

  if (editing) {
    return (
      <div className="flex items-center gap-1">
        <input
          ref={inputRef}
          className="w-full min-w-0 rounded border border-input bg-muted px-2 py-0.5 text-sm font-medium outline-none focus:ring-1 focus:ring-ring"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              void save();
            }
            if (e.key === "Escape") {
              setValue(instance.name);
              setEditing(false);
            }
          }}
          disabled={saving}
        />
        <button
          type="button"
          onClick={() => void save()}
          disabled={saving}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent"
        >
          <Check className="size-3 text-success" />
        </button>
        <button
          type="button"
          onClick={() => {
            setValue(instance.name);
            setEditing(false);
          }}
          disabled={saving}
          className="inline-flex size-6 shrink-0 items-center justify-center rounded transition-colors hover:bg-accent"
        >
          <X className="size-3 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div className="group flex items-center gap-1">
      <Link
        to="/instances/$id"
        params={{ id: String(instance.id) }}
        className="truncate text-sm font-medium hover:underline"
      >
        {instance.name}
      </Link>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex size-6 shrink-0 items-center justify-center rounded opacity-0 transition-colors group-hover:opacity-100 hover:bg-accent"
      >
        <Pencil className="size-3 text-muted-foreground" />
      </button>
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

  async function handleCreate() {
    setCreating(true);
    try {
      await api.instances.create(signer);
      toast.success("Instance created - provisioning will take ~2 minutes");
      onOpenChange(false);
      await onCreated();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button size="sm">
          <Plus className="size-4" />
          Create Instance
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create Instance</DialogTitle>
          <DialogDescription>
            Provision a new AgentBox VM for {USDC_PRICE} USDC on Solana (7 days). Your wallet will
            be prompted to approve the payment.
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
              Insufficient balance. You need at least {USDC_PRICE} USDC on Solana to create an
              instance. Make sure your USDC is on Solana, not another chain.
            </p>
          )}
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline" disabled={creating}>
              Cancel
            </Button>
          </DialogClose>
          <Button onClick={() => void handleCreate()} disabled={creating || !hasEnough}>
            {creating && <Loader2 className="size-4 animate-spin" />}
            {creating ? "Creating..." : `Pay ${USDC_PRICE} USDC & Create`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Home() {
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

  async function handleRename(id: number, name: string) {
    try {
      const updated = await api.instances.update(id, { name });
      setInstances((prev) =>
        prev.map((instance) =>
          instance.id === id ? { ...instance, name: updated.name } : instance,
        ),
      );
      toast.success("Instance renamed");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed");
      throw err;
    }
  }

  async function handleConfirm() {
    if (!confirmAction) {
      return;
    }

    setActionLoading(true);
    try {
      if (confirmAction.type === "restart") {
        await api.instances.restart(confirmAction.instance.id);
        toast.success("Instance restarting");
      } else {
        await api.instances.delete(confirmAction.instance.id);
        toast.success("Instance deleted");
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
              <h1 className="text-2xl font-bold tracking-tight md:text-3xl">Instances</h1>
              <p className="mt-1 text-sm text-muted-foreground">Manage your AgentBox instances</p>
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
              {/* {session ? (
                <CreateInstanceDialog
                  session={session}
                  open={createOpen}
                  onOpenChange={setCreateOpen}
                  onCreated={() => fetchInstances()}
                />
              ) : (
                <Button size="sm" disabled>
                  <Plus className="size-4" />
                  Create Instance
                </Button>
              )} */}
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
                {/* <Button className="mt-4" onClick={() => setCreateOpen(true)} disabled={!session}>
                  <Plus className="size-4" />
                  Create Instance
                </Button> */}
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
                          <TableRow key={instance.id}>
                            <TableCell className="max-w-[240px] pl-3">
                              <EditableName instance={instance} onSave={handleRename} />
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
                              <div className="flex items-center justify-end gap-1">
                                {instance.status === "running" ? (
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    asChild
                                    title="Open Chat"
                                  >
                                    <a href={urls.chat} target="_blank" rel="noopener noreferrer">
                                      <MessageSquare className="size-3.5" />
                                    </a>
                                  </Button>
                                ) : (
                                  <Button
                                    variant="outline"
                                    size="icon-sm"
                                    title="Open Chat"
                                    disabled
                                  >
                                    <MessageSquare className="size-3.5" />
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
                      <Card key={instance.id}>
                        <CardContent className="space-y-3 px-4 py-4">
                          <div className="flex items-start justify-between gap-3">
                            <Link
                              to="/instances/$id"
                              params={{ id: String(instance.id) }}
                              className="truncate text-sm font-semibold hover:underline"
                            >
                              {instance.name}
                            </Link>
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
                          <div className="grid grid-cols-4 gap-2">
                            {instance.status === "running" ? (
                              <Button
                                variant="outline"
                                size="icon-sm"
                                asChild
                                title="Open Chat"
                                className="w-full"
                              >
                                <a href={urls.chat} target="_blank" rel="noopener noreferrer">
                                  <MessageSquare className="size-3.5" />
                                </a>
                              </Button>
                            ) : (
                              <Button
                                variant="outline"
                                size="icon-sm"
                                title="Open Chat"
                                className="w-full"
                                disabled
                              >
                                <MessageSquare className="size-3.5" />
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
              {confirmAction?.type === "restart" ? "Restart Instance" : "Delete Instance"}
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
