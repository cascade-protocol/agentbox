import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  Check,
  Copy,
  ExternalLink,
  Eye,
  EyeOff,
  Loader2,
  MessageSquare,
  Pencil,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
} from "../components/ui/dialog";
import { api, type InstanceAccess, type InstanceHealth } from "../lib/api";
import { formatDate, relativeTime } from "../lib/format";

export const Route = createFileRoute("/instances/$id")({
  component: InstanceDetail,
});

const statusStyles: Record<string, string> = {
  provisioning: "bg-blue-500/10 text-blue-600",
  running: "bg-green-500/10 text-green-600",
  stopped: "bg-gray-500/10 text-gray-500",
  error: "bg-red-500/10 text-red-600",
  deleting: "bg-amber-500/10 text-amber-600",
};

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="inline-flex items-center justify-center size-8 rounded-md hover:bg-accent transition-colors shrink-0"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" />
      ) : (
        <Copy className="h-3.5 w-3.5 text-muted-foreground" />
      )}
    </button>
  );
}

function InstanceDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const numId = Number(id);

  const [instance, setInstance] = useState<InstanceAccess | null>(null);
  const [health, setHealth] = useState<InstanceHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [confirmAction, setConfirmAction] = useState<"restart" | "delete" | null>(null);

  useEffect(() => {
    Promise.all([api.instances.access(numId), api.instances.health(numId).catch(() => null)])
      .then(([access, healthData]) => {
        setInstance(access);
        setHealth(healthData);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [numId]);

  useEffect(() => {
    if (editingName) nameInputRef.current?.select();
  }, [editingName]);

  async function handleNameSave() {
    if (!instance) return;
    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === instance.name) {
      setEditingName(false);
      return;
    }
    setNameSaving(true);
    try {
      const updated = await api.instances.update(numId, { name: trimmed });
      setInstance((prev) => (prev ? { ...prev, name: updated.name } : prev));
      setEditingName(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setNameSaving(false);
    }
  }

  async function handleConfirm() {
    if (!confirmAction) return;
    setActionLoading(confirmAction);
    try {
      if (confirmAction === "restart") {
        await api.instances.restart(numId);
        const updated = await api.instances.access(numId);
        setInstance(updated);
      } else {
        await api.instances.delete(numId);
        navigate({ to: "/" });
        return;
      }
      setConfirmAction(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : `${confirmAction} failed`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleExtend() {
    setActionLoading("extend");
    try {
      const updated = await api.instances.extend(numId);
      setInstance((prev) => (prev ? { ...prev, ...updated } : prev));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Extend failed");
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return (
      <main className="flex-1 container mx-auto px-4 py-6 md:py-8 max-w-4xl">
        <p className="text-sm text-muted-foreground">Loading...</p>
      </main>
    );
  }

  if (error || !instance) {
    return (
      <main className="flex-1 container mx-auto px-4 py-6 md:py-8 max-w-4xl">
        <Link
          to="/"
          className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-4"
        >
          <ArrowLeft className="h-4 w-4" /> Back
        </Link>
        <p className="text-sm text-destructive">{error ?? "Instance not found"}</p>
      </main>
    );
  }

  return (
    <main className="flex-1 container mx-auto px-4 py-6 md:py-8 max-w-4xl">
      <div className="space-y-6">
        <div>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground mb-3"
          >
            <ArrowLeft className="h-4 w-4" /> Back
          </Link>
          <div className="flex items-center gap-3">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  ref={nameInputRef}
                  className="text-2xl md:text-3xl font-bold tracking-tight bg-muted px-2 py-0.5 rounded border border-input outline-none focus:ring-1 focus:ring-ring"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") handleNameSave();
                    if (e.key === "Escape") setEditingName(false);
                  }}
                  disabled={nameSaving}
                />
                <button
                  type="button"
                  onClick={handleNameSave}
                  disabled={nameSaving}
                  className="inline-flex items-center justify-center size-8 rounded-md hover:bg-accent transition-colors"
                >
                  <Check className="h-4 w-4 text-green-600" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                  disabled={nameSaving}
                  className="inline-flex items-center justify-center size-8 rounded-md hover:bg-accent transition-colors"
                >
                  <X className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
            ) : (
              <div className="flex items-center gap-2 group">
                <h1 className="text-2xl md:text-3xl font-bold tracking-tight">{instance.name}</h1>
                <button
                  type="button"
                  onClick={() => {
                    setNameValue(instance.name);
                    setEditingName(true);
                  }}
                  className="inline-flex items-center justify-center size-8 rounded-md hover:bg-accent transition-colors opacity-0 group-hover:opacity-100"
                >
                  <Pencil className="h-4 w-4 text-muted-foreground" />
                </button>
              </div>
            )}
            <span
              className={`text-xs px-2 py-0.5 rounded-full font-medium ${statusStyles[instance.status] ?? "bg-gray-500/10 text-gray-500"}`}
            >
              {instance.status}
            </span>
          </div>
          <p className="text-sm text-muted-foreground mt-1">{instance.userId}</p>
        </div>

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">IP Address</dt>
              <dd className="font-mono">{instance.ip}</dd>
              <dt className="text-muted-foreground">Wallet</dt>
              <dd className="font-mono">
                {instance.walletAddress ?? (
                  <span className="text-muted-foreground italic">Pending callback</span>
                )}
              </dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd title={formatDate(instance.createdAt)}>{relativeTime(instance.createdAt)}</dd>
              <dt className="text-muted-foreground">Expires</dt>
              <dd title={formatDate(instance.expiresAt)}>{relativeTime(instance.expiresAt)}</dd>
            </dl>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>Access</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <AccessRow label="SSH" value={instance.ssh} />
            <AccessRow label="Chat" value={instance.chatUrl} />
            <AccessRow label="Terminal" value={instance.terminalUrl} />
            {instance.rootPassword && (
              <div className="flex items-center gap-3">
                <span className="text-sm text-muted-foreground w-16 shrink-0">Password</span>
                <code className="flex-1 text-sm font-mono bg-muted px-3 py-2 rounded-md truncate">
                  {showPassword ? instance.rootPassword : "\u2022".repeat(16)}
                </code>
                <button
                  type="button"
                  onClick={() => setShowPassword(!showPassword)}
                  className="inline-flex items-center justify-center size-8 rounded-md hover:bg-accent transition-colors shrink-0"
                >
                  {showPassword ? (
                    <EyeOff className="h-3.5 w-3.5 text-muted-foreground" />
                  ) : (
                    <Eye className="h-3.5 w-3.5 text-muted-foreground" />
                  )}
                </button>
                <CopyButton value={instance.rootPassword} />
              </div>
            )}
          </CardContent>
        </Card>

        {health && (
          <Card>
            <CardHeader>
              <CardTitle>Health</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
                <dt className="text-muted-foreground">Status</dt>
                <dd>
                  <span
                    className={`text-xs px-2 py-0.5 rounded-full font-medium ${health.healthy ? "bg-green-500/10 text-green-600" : "bg-red-500/10 text-red-600"}`}
                  >
                    {health.healthy ? "Healthy" : "Unhealthy"}
                  </span>
                </dd>
                <dt className="text-muted-foreground">Hetzner</dt>
                <dd>{health.hetznerStatus}</dd>
                <dt className="text-muted-foreground">Callback</dt>
                <dd>{health.callbackReceived ? "Received" : "Pending"}</dd>
              </dl>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap gap-3">
          <Button asChild variant="outline">
            <a href={instance.chatUrl} target="_blank" rel="noopener noreferrer">
              <MessageSquare className="h-4 w-4" />
              Open Chat
              <ExternalLink className="h-3 w-3 ml-1" />
            </a>
          </Button>
          <Button asChild variant="outline">
            <a href={instance.terminalUrl} target="_blank" rel="noopener noreferrer">
              <TerminalSquare className="h-4 w-4" />
              Open Terminal
              <ExternalLink className="h-3 w-3 ml-1" />
            </a>
          </Button>
        </div>

        <div className="flex gap-3">
          <Button
            variant="outline"
            onClick={() => setConfirmAction("restart")}
            disabled={actionLoading !== null}
          >
            Restart
          </Button>
          <Button variant="outline" onClick={handleExtend} disabled={actionLoading !== null}>
            {actionLoading === "extend" ? "Extending..." : "Extend 30 days"}
          </Button>
          <Button
            variant="destructive"
            onClick={() => setConfirmAction("delete")}
            disabled={actionLoading !== null}
          >
            Delete
          </Button>
        </div>
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
              {confirmAction === "restart" ? "Restart Instance" : "Delete Instance"}
            </DialogTitle>
            <DialogDescription>
              {confirmAction === "restart"
                ? "This will reboot the VM. Active sessions will disconnect."
                : "This will permanently destroy the instance. This action cannot be undone."}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" disabled={actionLoading !== null}>
                Cancel
              </Button>
            </DialogClose>
            <Button
              variant={confirmAction === "delete" ? "destructive" : "default"}
              onClick={handleConfirm}
              disabled={actionLoading !== null}
            >
              {actionLoading && <Loader2 className="h-4 w-4 animate-spin" />}
              {actionLoading
                ? confirmAction === "restart"
                  ? "Restarting..."
                  : "Deleting..."
                : confirmAction === "restart"
                  ? "Restart"
                  : "Delete"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </main>
  );
}

function AccessRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-3">
      <span className="text-sm text-muted-foreground w-16 shrink-0">{label}</span>
      <code className="flex-1 text-sm font-mono bg-muted px-3 py-2 rounded-md truncate">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}
