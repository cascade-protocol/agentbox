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
  RotateCw,
  TerminalSquare,
  Trash2,
  X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
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
} from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { api, type InstanceAccess, type InstanceHealth } from "../lib/api";
import { formatDate, relativeTime } from "../lib/format";
import {
  getProvisioningStepIndex,
  getProvisioningStepLabel,
  getStatusVariant,
  provisioningStepOrder,
} from "../lib/status";

export const Route = createFileRoute("/instances/$id")({
  component: InstanceDetail,
});

function formatStatus(status: string): string {
  return status.charAt(0).toUpperCase() + status.slice(1);
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
      }}
      className="inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
    >
      {copied ? (
        <Check className="size-3.5 text-success" />
      ) : (
        <Copy className="size-3.5 text-muted-foreground" />
      )}
    </button>
  );
}

function StatusDisplay({ instance }: { instance: InstanceAccess }) {
  return (
    <div className="space-y-1">
      <Badge variant={getStatusVariant(instance.status)}>{formatStatus(instance.status)}</Badge>
      {instance.status === "provisioning" && (
        <p className="animate-pulse text-xs text-muted-foreground">
          {getProvisioningStepLabel(instance.provisioningStep)}
        </p>
      )}
    </div>
  );
}

function ProvisioningStepper({ step }: { step: string | null | undefined }) {
  const current = getProvisioningStepIndex(step);

  return (
    <Card>
      <CardHeader>
        <CardTitle>Provisioning progress</CardTitle>
      </CardHeader>
      <CardContent>
        <ol className="space-y-3">
          {provisioningStepOrder.map((item, index) => {
            const label = getProvisioningStepLabel(item);
            const completed = index < current;
            const active = index === current;

            return (
              <li key={item} className="flex items-center gap-3 text-sm">
                <span className="inline-flex size-5 items-center justify-center rounded-full border border-border bg-background">
                  {completed ? (
                    <Check className="size-3 text-success" />
                  ) : active ? (
                    <Loader2 className="size-3 animate-spin text-info" />
                  ) : (
                    <span className="size-2 rounded-full bg-muted-foreground/60" />
                  )}
                </span>
                <span className={active ? "font-medium" : "text-muted-foreground"}>{label}</span>
              </li>
            );
          })}
        </ol>
      </CardContent>
    </Card>
  );
}

function DetailSkeleton() {
  return (
    <main className="container mx-auto flex-1 max-w-4xl px-4 py-6 md:py-8">
      <div className="space-y-6">
        <div className="space-y-3">
          <Skeleton className="h-4 w-16" />
          <div className="flex items-center gap-3">
            <Skeleton className="h-9 w-56" />
            <Skeleton className="h-5 w-24" />
          </div>
        </div>

        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-20" />
          </CardHeader>
          <CardContent className="space-y-3">
            {["detail-1", "detail-2", "detail-3", "detail-4", "detail-5", "detail-6"].map(
              (item) => (
                <Skeleton key={item} className="h-4 w-full" />
              ),
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <Skeleton className="h-6 w-20" />
          </CardHeader>
          <CardContent className="space-y-3">
            {["access-1", "access-2", "access-3", "access-4"].map((item) => (
              <Skeleton key={item} className="h-10 w-full" />
            ))}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function InstanceDetail() {
  const { id } = Route.useParams();
  const navigate = useNavigate();
  const numId = Number(id);

  const [instance, setInstance] = useState<InstanceAccess | null>(null);
  const [health, setHealth] = useState<InstanceHealth | null>(null);
  const [loading, setLoading] = useState(true);
  const [fatalError, setFatalError] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [confirmAction, setConfirmAction] = useState<"restart" | "delete" | null>(null);

  const fetchDetail = useCallback(
    async ({
      showErrorToast = false,
      setFatalOnError = false,
    }: {
      showErrorToast?: boolean;
      setFatalOnError?: boolean;
    } = {}) => {
      try {
        const [access, healthData] = await Promise.all([
          api.instances.access(numId),
          api.instances.health(numId).catch(() => null),
        ]);
        setInstance(access);
        setHealth(healthData);
        setFatalError(null);
      } catch (err) {
        const message = err instanceof Error ? err.message : "Failed to load instance";
        if (setFatalOnError) {
          setFatalError(message);
        }
        if (showErrorToast) {
          toast.error(message);
        }
      }
    },
    [numId],
  );

  useEffect(() => {
    setLoading(true);
    void fetchDetail({ showErrorToast: true, setFatalOnError: true }).finally(() =>
      setLoading(false),
    );
  }, [fetchDetail]);

  useEffect(() => {
    if (editingName) {
      nameInputRef.current?.select();
    }
  }, [editingName]);

  const pollIntervalMs = instance?.status === "provisioning" ? 10_000 : 30_000;

  useEffect(() => {
    if (!instance) {
      return;
    }

    const interval = setInterval(() => {
      if (!document.hidden) {
        void fetchDetail();
      }
    }, pollIntervalMs);

    return () => clearInterval(interval);
  }, [fetchDetail, instance, pollIntervalMs]);

  async function handleNameSave() {
    if (!instance) {
      return;
    }

    const trimmed = nameValue.trim();
    if (!trimmed || trimmed === instance.name) {
      setEditingName(false);
      return;
    }

    setNameSaving(true);
    try {
      const updated = await api.instances.update(numId, { name: trimmed });
      setInstance((prev) => (prev ? { ...prev, name: updated.name } : prev));
      toast.success("Instance renamed");
      setEditingName(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Rename failed");
    } finally {
      setNameSaving(false);
    }
  }

  async function handleConfirm() {
    if (!confirmAction) {
      return;
    }

    setActionLoading(confirmAction);
    try {
      if (confirmAction === "restart") {
        await api.instances.restart(numId);
        toast.success("Instance restarting");
        await fetchDetail({ showErrorToast: true });
      } else {
        await api.instances.delete(numId);
        toast.success("Instance deleted");
        navigate({ to: "/" });
        return;
      }
      setConfirmAction(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : `${confirmAction} failed`);
    } finally {
      setActionLoading(null);
    }
  }

  async function handleExtend() {
    setActionLoading("extend");
    try {
      const updated = await api.instances.extend(numId);
      setInstance((prev) => (prev ? { ...prev, ...updated } : prev));
      toast.success("Extended by 30 days");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Extend failed");
    } finally {
      setActionLoading(null);
    }
  }

  if (loading) {
    return <DetailSkeleton />;
  }

  if (fatalError || !instance) {
    return (
      <main className="container mx-auto flex-1 max-w-4xl px-4 py-6 md:py-8">
        <Link
          to="/"
          className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
        >
          <ArrowLeft className="size-4" /> Back
        </Link>
        <p className="text-sm text-destructive">{fatalError ?? "Instance not found"}</p>
      </main>
    );
  }

  return (
    <main className="container mx-auto flex-1 max-w-4xl px-4 py-6 md:py-8">
      <div className="space-y-6">
        <div>
          <Link
            to="/"
            className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
          >
            <ArrowLeft className="size-4" /> Back
          </Link>
          <div className="flex items-start gap-3">
            {editingName ? (
              <div className="flex items-center gap-2">
                <input
                  ref={nameInputRef}
                  className="rounded border border-input bg-muted px-2 py-0.5 text-2xl font-bold tracking-tight outline-none focus:ring-1 focus:ring-ring md:text-3xl"
                  value={nameValue}
                  onChange={(e) => setNameValue(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      void handleNameSave();
                    }
                    if (e.key === "Escape") {
                      setEditingName(false);
                    }
                  }}
                  disabled={nameSaving}
                />
                <button
                  type="button"
                  onClick={() => void handleNameSave()}
                  disabled={nameSaving}
                  className="inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent"
                >
                  <Check className="size-4 text-success" />
                </button>
                <button
                  type="button"
                  onClick={() => setEditingName(false)}
                  disabled={nameSaving}
                  className="inline-flex size-8 items-center justify-center rounded-md transition-colors hover:bg-accent"
                >
                  <X className="size-4 text-muted-foreground" />
                </button>
              </div>
            ) : (
              <div className="group flex items-center gap-2">
                <h1 className="text-2xl font-bold tracking-tight md:text-3xl">{instance.name}</h1>
                <button
                  type="button"
                  onClick={() => {
                    setNameValue(instance.name);
                    setEditingName(true);
                  }}
                  className="inline-flex size-8 items-center justify-center rounded-md opacity-0 transition-colors group-hover:opacity-100 hover:bg-accent"
                >
                  <Pencil className="size-4 text-muted-foreground" />
                </button>
              </div>
            )}
            <StatusDisplay instance={instance} />
          </div>
          <p className="mt-1 text-sm text-muted-foreground">{instance.userId}</p>
        </div>

        {instance.status === "provisioning" && (
          <ProvisioningStepper step={instance.provisioningStep} />
        )}

        <Card>
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">IP Address</dt>
              <dd className="font-mono">{instance.ip}</dd>

              <dt className="text-muted-foreground">Solana Wallet</dt>
              <dd className="font-mono">
                {instance.solanaWalletAddress ?? (
                  <span className="animate-pulse italic text-muted-foreground">
                    Initializing...
                  </span>
                )}
              </dd>

              <dt className="text-muted-foreground">SATI Agent ID</dt>
              <dd className="break-all font-mono">
                {instance.agentId ?? (
                  <span className="animate-pulse italic text-muted-foreground">
                    Initializing...
                  </span>
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
                <span className="w-16 shrink-0 text-sm text-muted-foreground">Password</span>
                <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">
                  {showPassword ? instance.rootPassword : "\u2022".repeat(16)}
                </code>
                <button
                  type="button"
                  onClick={() => setShowPassword((prev) => !prev)}
                  className="inline-flex size-8 shrink-0 items-center justify-center rounded-md transition-colors hover:bg-accent"
                >
                  {showPassword ? (
                    <EyeOff className="size-3.5 text-muted-foreground" />
                  ) : (
                    <Eye className="size-3.5 text-muted-foreground" />
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
                  <Badge variant={health.healthy ? "success" : "destructive"}>
                    {health.healthy ? "Healthy" : "Unhealthy"}
                  </Badge>
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
          <div className="flex flex-wrap gap-3">
            {instance.status === "running" ? (
              <Button asChild variant="outline">
                <a href={instance.chatUrl} target="_blank" rel="noopener noreferrer">
                  <MessageSquare className="size-4" />
                  Open Chat
                  <ExternalLink className="ml-1 size-3" />
                </a>
              </Button>
            ) : (
              <Button variant="outline" disabled>
                <MessageSquare className="size-4" />
                Open Chat
                <ExternalLink className="ml-1 size-3" />
              </Button>
            )}

            {instance.status === "running" ? (
              <Button asChild variant="outline">
                <a href={instance.terminalUrl} target="_blank" rel="noopener noreferrer">
                  <TerminalSquare className="size-4" />
                  Open Terminal
                  <ExternalLink className="ml-1 size-3" />
                </a>
              </Button>
            ) : (
              <Button variant="outline" disabled>
                <TerminalSquare className="size-4" />
                Open Terminal
                <ExternalLink className="ml-1 size-3" />
              </Button>
            )}
          </div>

          <div className="ml-auto flex flex-wrap gap-3">
            <Button
              variant="outline"
              onClick={() => setConfirmAction("restart")}
              disabled={actionLoading !== null}
            >
              <RotateCw className="size-4" />
              Restart
            </Button>
            <Button
              variant="outline"
              onClick={() => void handleExtend()}
              disabled={actionLoading !== null}
            >
              {actionLoading === "extend" ? <Loader2 className="size-4 animate-spin" /> : null}
              {actionLoading === "extend" ? "Extending..." : "Extend 30 days"}
            </Button>
            <Button
              variant="destructive"
              onClick={() => setConfirmAction("delete")}
              disabled={actionLoading !== null}
            >
              <Trash2 className="size-4" />
              Delete
            </Button>
          </div>
        </div>
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
              onClick={() => void handleConfirm()}
              disabled={actionLoading !== null}
            >
              {actionLoading && <Loader2 className="size-4 animate-spin" />}
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
      <span className="w-16 shrink-0 text-sm text-muted-foreground">{label}</span>
      <code className="flex-1 truncate rounded-md bg-muted px-3 py-2 font-mono text-sm">
        {value}
      </code>
      <CopyButton value={value} />
    </div>
  );
}
