import { createWalletTransactionSigner } from "@solana/client";
import {
  address,
  appendTransactionMessageInstruction,
  createSolanaRpc,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type TransactionSigner,
} from "@solana/kit";
import { useWalletSession } from "@solana/react-hooks";
import {
  findAssociatedTokenPda as findAta2022,
  getCreateAssociatedTokenIdempotentInstruction as getCreateAta2022,
  getTransferCheckedInstruction as getTransferChecked2022,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  ArrowLeft,
  ArrowRightLeft,
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
} from "../components/ui/dialog";
import { Skeleton } from "../components/ui/skeleton";
import { env } from "../env";
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

function getSolscanTokenUrl(mint: string): string {
  return `https://solscan.io/token/${mint}`;
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
      {instance.status === "minting" && (
        <p className="animate-pulse text-xs text-muted-foreground">Minting identity NFT...</p>
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

const RPC_URL = `https://mainnet.helius-rpc.com/?api-key=${env.heliusApiKey}`;

function TransferDialog({
  nftMint,
  signer,
  open,
  onOpenChange,
  onTransferred,
}: {
  nftMint: string;
  signer: TransactionSigner;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onTransferred: () => void;
}) {
  const [destination, setDestination] = useState("");
  const [transferring, setTransferring] = useState(false);

  async function handleTransfer() {
    const dest = destination.trim();
    if (!dest || dest.length < 32 || dest.length > 44) {
      toast.error("Enter a valid Solana wallet address");
      return;
    }

    setTransferring(true);
    try {
      const rpc = createSolanaRpc(RPC_URL);
      const mint = address(nftMint);
      const destOwner = address(dest);

      const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();

      const [sourceAta] = await findAta2022({
        owner: signer.address,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });

      const [destAta] = await findAta2022({
        owner: destOwner,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });

      const createAtaIx = getCreateAta2022({
        payer: signer,
        ata: destAta,
        owner: destOwner,
        mint,
        tokenProgram: TOKEN_2022_PROGRAM_ADDRESS,
      });

      const transferIx = getTransferChecked2022({
        source: sourceAta,
        mint,
        destination: destAta,
        authority: signer,
        amount: 1n,
        decimals: 0,
      });

      const tx = pipe(
        createTransactionMessage({ version: 0 }),
        (msg) => setTransactionMessageFeePayer(signer.address, msg),
        (msg) => appendTransactionMessageInstruction(createAtaIx, msg),
        (msg) => appendTransactionMessageInstruction(transferIx, msg),
        (msg) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, msg),
      );

      const signed = await signTransactionMessageWithSigners(tx);
      const encoded = getBase64EncodedWireTransaction(signed);
      await rpc.sendTransaction(encoded, { encoding: "base64" }).send();

      toast.success("NFT transferred - syncing ownership...");
      await api.instances.sync();
      onOpenChange(false);
      onTransferred();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Transfer failed");
    } finally {
      setTransferring(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Transfer Instance</DialogTitle>
          <DialogDescription>
            Transfer this instance's NFT to another wallet. The new owner will gain access and you
            will lose it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label htmlFor="transfer-dest" className="text-sm text-muted-foreground">
            Destination wallet
          </label>
          <input
            id="transfer-dest"
            className="w-full rounded-md border border-input bg-muted px-3 py-2 font-mono text-sm outline-none focus:ring-1 focus:ring-ring"
            placeholder="Solana wallet address..."
            value={destination}
            onChange={(e) => setDestination(e.target.value)}
            disabled={transferring}
          />
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={transferring}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            onClick={() => void handleTransfer()}
            disabled={transferring || !destination.trim()}
          >
            {transferring && <Loader2 className="size-4 animate-spin" />}
            {transferring ? "Transferring..." : "Transfer"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
  const session = useWalletSession();
  const signer: TransactionSigner | null = useMemo(
    () => (session ? createWalletTransactionSigner(session).signer : null),
    [session],
  );

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
  const [transferOpen, setTransferOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentSaving, setAgentSaving] = useState(false);

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

  const pollIntervalMs =
    instance?.status === "provisioning" || instance?.status === "minting" ? 10_000 : 30_000;

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

  async function handleMint() {
    setActionLoading("mint");
    try {
      await api.instances.mint(numId);
      toast.success("Minting started");
      await fetchDetail({ showErrorToast: true });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Mint failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleExtend() {
    setActionLoading("extend");
    try {
      const updated = await api.instances.extend(numId);
      setInstance((prev) => (prev ? { ...prev, ...updated } : prev));
      toast.success("Extended by 7 days");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Extend failed");
    } finally {
      setActionLoading(null);
    }
  }

  async function handleAgentMetadataSave() {
    const name = agentName.trim() || undefined;
    const description = agentDescription.trim() || undefined;
    if (!name && !description) return;

    setAgentSaving(true);
    try {
      await api.instances.updateAgent(numId, { name, description });
      toast.success("Agent metadata updated");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Metadata update failed");
    } finally {
      setAgentSaving(false);
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
        <div className="rounded-xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur md:p-5">
          <Link
            to="/"
            className="mb-3 inline-flex items-center gap-1.5 text-sm text-muted-foreground transition-colors hover:text-foreground"
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
          <p className="mt-1 rounded-md bg-muted/60 px-2 py-1 font-mono text-xs text-muted-foreground">
            {instance.ownerWallet}
          </p>
        </div>

        {instance.status === "provisioning" && (
          <ProvisioningStepper step={instance.provisioningStep} />
        )}

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Details</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              <dt className="text-muted-foreground">IP Address</dt>
              <dd className="font-mono">{instance.ip}</dd>

              <dt className="text-muted-foreground">Owner Wallet</dt>
              <dd className="font-mono">{instance.ownerWallet}</dd>

              <dt className="text-muted-foreground">VM Wallet</dt>
              <dd className="font-mono">
                {instance.vmWallet ?? (
                  <span className="animate-pulse italic text-muted-foreground">
                    Initializing...
                  </span>
                )}
              </dd>

              <dt className="text-muted-foreground">Agent NFT</dt>
              <dd className="break-all font-mono">
                {instance.nftMint ? (
                  <a
                    href={getSolscanTokenUrl(instance.nftMint)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    {instance.nftMint}
                    <ExternalLink className="size-3" />
                  </a>
                ) : instance.status === "minting" ? (
                  <span className="animate-pulse italic text-muted-foreground">
                    Minting identity NFT...
                  </span>
                ) : (
                  <span className="inline-flex items-center gap-2">
                    <span className="italic text-muted-foreground">Not yet minted</span>
                    {instance.vmWallet && (
                      <Button
                        variant="outline"
                        size="sm"
                        className="h-6 px-2 text-xs"
                        disabled={actionLoading === "mint"}
                        onClick={() => void handleMint()}
                      >
                        {actionLoading === "mint" ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : null}
                        {actionLoading === "mint" ? "Minting..." : "Mint NFT"}
                      </Button>
                    )}
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

        <Card className="shadow-sm">
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
          <Card className="shadow-sm">
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

        {instance.nftMint && instance.status === "running" && (
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle>Agent Metadata</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-1.5">
                <label htmlFor="agent-name" className="text-sm text-muted-foreground">
                  Name
                </label>
                <input
                  id="agent-name"
                  className="w-full rounded-md border border-input bg-muted px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  placeholder={instance.name}
                  value={agentName}
                  onChange={(e) => setAgentName(e.target.value)}
                  disabled={agentSaving}
                />
              </div>
              <div className="space-y-1.5">
                <label htmlFor="agent-description" className="text-sm text-muted-foreground">
                  Description
                </label>
                <textarea
                  id="agent-description"
                  className="w-full rounded-md border border-input bg-muted px-3 py-2 text-sm outline-none focus:ring-1 focus:ring-ring"
                  rows={3}
                  placeholder="Describe what this agent does..."
                  value={agentDescription}
                  onChange={(e) => setAgentDescription(e.target.value)}
                  disabled={agentSaving}
                />
              </div>
              <Button
                size="sm"
                onClick={() => void handleAgentMetadataSave()}
                disabled={agentSaving || (!agentName.trim() && !agentDescription.trim())}
              >
                {agentSaving && <Loader2 className="size-4 animate-spin" />}
                {agentSaving ? "Saving..." : "Update Metadata"}
              </Button>
            </CardContent>
          </Card>
        )}

        <div className="flex flex-wrap gap-3 rounded-xl border border-border/60 bg-card/80 p-4 shadow-sm backdrop-blur">
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
              {actionLoading === "extend" ? "Extending..." : "Extend 7 days"}
            </Button>
            {instance.nftMint && signer && (
              <Button
                variant="outline"
                onClick={() => setTransferOpen(true)}
                disabled={actionLoading !== null}
              >
                <ArrowRightLeft className="size-4" />
                Transfer
              </Button>
            )}
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

      {instance.nftMint && signer && (
        <TransferDialog
          nftMint={instance.nftMint}
          signer={signer}
          open={transferOpen}
          onOpenChange={setTransferOpen}
          onTransferred={() => navigate({ to: "/" })}
        />
      )}
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
