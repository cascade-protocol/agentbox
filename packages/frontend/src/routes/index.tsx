import { useWalletConnection } from "@solana/react-hooks";
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
import { useCallback, useEffect, useRef, useState } from "react";
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
import { api, type Instance, instanceUrls } from "../lib/api";
import { formatDate, relativeTime } from "../lib/format";

export const Route = createFileRoute("/")({
  component: Home,
});

const statusStyles: Record<string, string> = {
  provisioning: "bg-blue-500/10 text-blue-600",
  running: "bg-green-500/10 text-green-600",
  stopped: "bg-gray-500/10 text-gray-500",
  error: "bg-red-500/10 text-red-600",
  deleting: "bg-amber-500/10 text-amber-600",
};

function isExpiringSoon(expiresAt: string) {
  return new Date(expiresAt).getTime() - Date.now() < 3 * 24 * 60 * 60 * 1000;
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
    if (editing) inputRef.current?.select();
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
          className="text-sm font-medium bg-muted px-2 py-0.5 rounded border border-input outline-none focus:ring-1 focus:ring-ring w-full min-w-0"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") save();
            if (e.key === "Escape") {
              setValue(instance.name);
              setEditing(false);
            }
          }}
          disabled={saving}
        />
        <button
          type="button"
          onClick={save}
          disabled={saving}
          className="inline-flex items-center justify-center size-6 rounded hover:bg-accent transition-colors shrink-0"
        >
          <Check className="h-3 w-3 text-green-600" />
        </button>
        <button
          type="button"
          onClick={() => {
            setValue(instance.name);
            setEditing(false);
          }}
          disabled={saving}
          className="inline-flex items-center justify-center size-6 rounded hover:bg-accent transition-colors shrink-0"
        >
          <X className="h-3 w-3 text-muted-foreground" />
        </button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-1 group">
      <Link
        to="/instances/$id"
        params={{ id: String(instance.id) }}
        className="text-sm font-medium hover:underline truncate"
      >
        {instance.name}
      </Link>
      <button
        type="button"
        onClick={() => setEditing(true)}
        className="inline-flex items-center justify-center size-6 rounded hover:bg-accent transition-colors shrink-0 opacity-0 group-hover:opacity-100"
      >
        <Pencil className="h-3 w-3 text-muted-foreground" />
      </button>
    </div>
  );
}

function Home() {
  const { wallet } = useWalletConnection();
  const [instances, setInstances] = useState<Instance[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);

  const [createOpen, setCreateOpen] = useState(false);
  const [creating, setCreating] = useState(false);

  const [confirmAction, setConfirmAction] = useState<{
    type: "restart" | "delete";
    instance: Instance;
  } | null>(null);
  const [actionLoading, setActionLoading] = useState(false);

  const fetchInstances = useCallback(async () => {
    try {
      const data = await api.instances.list();
      setInstances(data.instances);
      setLastChecked(new Date());
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchInstances();
  }, [fetchInstances]);

  useEffect(() => {
    const interval = setInterval(() => {
      if (!document.hidden) fetchInstances();
    }, 30_000);
    return () => clearInterval(interval);
  }, [fetchInstances]);

  async function handleCreate() {
    if (!wallet) return;
    setCreating(true);
    try {
      await api.instances.create(wallet);
      setCreateOpen(false);
      await fetchInstances();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Create failed");
    } finally {
      setCreating(false);
    }
  }

  async function handleRename(id: number, name: string) {
    const updated = await api.instances.update(id, { name });
    setInstances((prev) => prev.map((i) => (i.id === id ? { ...i, name: updated.name } : i)));
  }

  async function handleConfirm() {
    if (!confirmAction) return;
    setActionLoading(true);
    try {
      if (confirmAction.type === "restart") {
        await api.instances.restart(confirmAction.instance.id);
      } else {
        await api.instances.delete(confirmAction.instance.id);
      }
      setConfirmAction(null);
      await fetchInstances();
    } catch (err) {
      setError(err instanceof Error ? err.message : `${confirmAction.type} failed`);
    } finally {
      setActionLoading(false);
    }
  }

  const running = instances.filter((i) => i.status === "running").length;
  const expiring = instances.filter((i) => isExpiringSoon(i.expiresAt)).length;

  if (loading) {
    return (
      <main className="flex-1 container mx-auto px-4 py-6 md:py-8 max-w-6xl">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </main>
    );
  }

  return (
    <main className="flex-1 container mx-auto px-4 py-6 md:py-8 max-w-6xl">
      <div className="space-y-6">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl md:text-3xl font-bold tracking-tight">Instances</h1>
            <p className="text-sm text-muted-foreground mt-1">Manage your AgentBox instances</p>
          </div>
          <div className="flex items-center gap-2">
            {lastChecked && (
              <span className="text-xs text-muted-foreground hidden sm:inline">
                {relativeTime(lastChecked.toISOString())}
              </span>
            )}
            <Button variant="outline" size="sm" onClick={() => fetchInstances()}>
              <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
              Refresh
            </Button>
            <Dialog open={createOpen} onOpenChange={setCreateOpen}>
              <DialogTrigger asChild>
                <Button size="sm">
                  <Plus className="h-4 w-4" />
                  Create Instance
                </Button>
              </DialogTrigger>
              <DialogContent className="sm:max-w-md">
                <DialogHeader>
                  <DialogTitle>Create Instance</DialogTitle>
                  <DialogDescription>
                    Provision a new AgentBox VM for $1 USDC (30 days). Your wallet will be prompted
                    to approve the payment.
                  </DialogDescription>
                </DialogHeader>
                <DialogFooter>
                  <DialogClose asChild>
                    <Button type="button" variant="outline" disabled={creating}>
                      Cancel
                    </Button>
                  </DialogClose>
                  <Button onClick={handleCreate} disabled={creating || !wallet}>
                    {creating && <Loader2 className="h-4 w-4 animate-spin" />}
                    {creating ? "Creating..." : "Pay $1 & Create"}
                  </Button>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </div>
        </div>

        {error && <p className="text-sm text-destructive">Error: {error}</p>}

        <div className="grid gap-4 md:grid-cols-3">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Total</CardTitle>
              <Server className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{instances.length}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Running</CardTitle>
              <Activity className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{running}</div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-sm font-medium">Expiring Soon</CardTitle>
              <AlertTriangle className="h-4 w-4 text-muted-foreground" />
            </CardHeader>
            <CardContent>
              <div className="text-2xl font-bold">{expiring}</div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>All Instances</CardTitle>
          </CardHeader>
          <CardContent>
            {instances.length === 0 ? (
              <p className="text-sm text-muted-foreground py-4 text-center">No instances yet</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full">
                  <thead>
                    <tr className="border-b text-left text-sm text-muted-foreground">
                      <th className="pb-3 pr-4 font-medium">Name</th>
                      <th className="pb-3 pr-4 font-medium">User</th>
                      <th className="pb-3 pr-4 font-medium">Status</th>
                      <th className="pb-3 pr-4 font-medium">Expires</th>
                      <th className="pb-3 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody>
                    {instances.map((instance) => (
                      <tr key={instance.id} className="border-b last:border-0">
                        <td className="py-3 pr-4">
                          <EditableName instance={instance} onSave={handleRename} />
                          <p className="text-xs text-muted-foreground">{instance.id}</p>
                        </td>
                        <td className="py-3 pr-4 text-sm text-muted-foreground">
                          {instance.userId}
                        </td>
                        <td className="py-3 pr-4">
                          <span
                            className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyles[instance.status] ?? "bg-gray-500/10 text-gray-500"}`}
                          >
                            {instance.status}
                          </span>
                        </td>
                        <td
                          className={`py-3 pr-4 text-sm ${isExpiringSoon(instance.expiresAt) ? "text-destructive font-medium" : "text-muted-foreground"}`}
                          title={formatDate(instance.expiresAt)}
                        >
                          {relativeTime(instance.expiresAt)}
                        </td>
                        <td className="py-3 text-right whitespace-nowrap">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              variant="outline"
                              size="sm"
                              asChild
                              disabled={instance.status !== "running"}
                            >
                              <a
                                href={instanceUrls(instance.name, instance.gatewayToken).chat}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={
                                  instance.status !== "running"
                                    ? "pointer-events-none opacity-50"
                                    : ""
                                }
                              >
                                <MessageSquare className="h-3.5 w-3.5" />
                                Chat
                              </a>
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              asChild
                              disabled={instance.status !== "running"}
                            >
                              <a
                                href={instanceUrls(instance.name, instance.gatewayToken).terminal}
                                target="_blank"
                                rel="noopener noreferrer"
                                className={
                                  instance.status !== "running"
                                    ? "pointer-events-none opacity-50"
                                    : ""
                                }
                              >
                                <TerminalSquare className="h-3.5 w-3.5" />
                                Terminal
                              </a>
                            </Button>
                            <Button
                              variant="outline"
                              size="sm"
                              onClick={() =>
                                setConfirmAction({
                                  type: "restart",
                                  instance,
                                })
                              }
                              disabled={instance.status !== "running"}
                            >
                              <RotateCw className="h-3.5 w-3.5" />
                              Restart
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
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <Dialog
        open={confirmAction !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAction(null);
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
              onClick={handleConfirm}
              disabled={actionLoading}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin" />}
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
