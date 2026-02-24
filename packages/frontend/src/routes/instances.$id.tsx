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
import { useBalance, useSplToken, useWalletSession } from "@solana/react-hooks";
import {
  findAssociatedTokenPda as findAta2022,
  getCreateAssociatedTokenIdempotentInstruction as getCreateAta2022,
  getTransferCheckedInstruction as getTransferChecked2022,
  TOKEN_2022_PROGRAM_ADDRESS,
} from "@solana-program/token-2022";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRightLeft,
  BookOpen,
  Check,
  Copy,
  ExternalLink,
  Loader2,
  MessageSquare,
  Pencil,
  RotateCw,
  Send,
  TerminalSquare,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "../components/ui/accordion";
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

function getSolscanTxUrl(signature: string): string {
  return `https://solscan.io/tx/${signature}`;
}

const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

function WithdrawDialog({
  token,
  balance,
  usdcBalance,
  instanceId,
  ownerWallet,
  open,
  onOpenChange,
  onWithdrawn,
}: {
  token: "SOL" | "USDC";
  balance: number;
  usdcBalance: number;
  instanceId: number;
  ownerWallet: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onWithdrawn: () => void;
}) {
  const [amount, setAmount] = useState("");
  const [withdrawing, setWithdrawing] = useState(false);
  const numAmount = Number.parseFloat(amount);
  const validAmount =
    amount !== "" && !Number.isNaN(numAmount) && numAmount > 0 && numAmount <= balance;
  const showUsdcWarning = token === "SOL" && usdcBalance > 0;

  async function handleWithdraw() {
    setWithdrawing(true);
    try {
      const res = await api.instances.withdraw(instanceId, {
        token,
        amount: amount === String(balance) ? "ALL" : amount,
      });
      toast.success(
        <span>
          Withdrew {amount} {token}.{" "}
          <a
            href={getSolscanTxUrl(res.signature)}
            target="_blank"
            rel="noopener noreferrer"
            className="underline"
          >
            View on Solscan
          </a>
        </span>,
      );
      onOpenChange(false);
      setAmount("");
      onWithdrawn();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Withdrawal failed");
    } finally {
      setWithdrawing(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Withdraw {token}</DialogTitle>
          <DialogDescription>Transfer funds from the VM wallet to your wallet.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {showUsdcWarning && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              <AlertTriangle className="mt-0.5 size-4 shrink-0" />
              <span>
                Your VM wallet still has {usdcBalance.toFixed(2)} USDC. Withdrawing all SOL will
                make it impossible to withdraw USDC later (SOL is needed for transfer fees).
                Withdraw USDC first.
              </span>
            </div>
          )}
          <div className="space-y-1.5">
            <label htmlFor="withdraw-amount" className="text-sm text-muted-foreground">
              Amount
            </label>
            <div className="flex gap-2">
              <input
                id="withdraw-amount"
                className="flex-1 rounded-md border border-input bg-muted px-3 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                placeholder="0.00"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                disabled={withdrawing}
              />
              <Button
                size="sm"
                variant="outline"
                onClick={() => setAmount(String(balance))}
                disabled={withdrawing}
              >
                Max
              </Button>
            </div>
            {amount && !validAmount && (
              <p className="text-xs text-destructive">Enter an amount between 0 and {balance}</p>
            )}
          </div>
          <div className="space-y-1.5">
            <span className="text-sm text-muted-foreground">Destination</span>
            <div className="rounded-md border border-input bg-muted px-3 py-2 font-mono text-sm text-muted-foreground">
              {ownerWallet}
            </div>
          </div>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="outline" disabled={withdrawing}>
              Cancel
            </Button>
          </DialogClose>
          <Button
            variant={showUsdcWarning ? "destructive" : "default"}
            onClick={() => void handleWithdraw()}
            disabled={!validAmount || withdrawing}
          >
            {withdrawing && <Loader2 className="size-4 animate-spin" />}
            {withdrawing
              ? "Withdrawing..."
              : showUsdcWarning
                ? `Withdraw anyway`
                : `Withdraw ${amount || "0"} ${token}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function WalletBalanceCard({
  instanceId,
  vmWallet,
  ownerWallet,
}: {
  instanceId: number;
  vmWallet: string;
  ownerWallet: string;
}) {
  const { lamports, fetching: solFetching } = useBalance(vmWallet);
  const {
    balance: usdcData,
    isFetching: usdcFetching,
    refresh: refreshUsdc,
  } = useSplToken(USDC_MINT, { owner: vmWallet });
  const [withdrawToken, setWithdrawToken] = useState<"SOL" | "USDC" | null>(null);

  const sol = lamports !== null ? Number(lamports) / 1e9 : null;
  const usdc = usdcData ? Number(usdcData.uiAmount) : null;
  const loading = (solFetching && sol === null) || (usdcFetching && usdc === null);

  return (
    <>
      <Card className="shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Wallet className="size-4" />
            VM Wallet Balance
          </CardTitle>
        </CardHeader>
        <CardContent>
          {loading ? (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Loading balances...
            </div>
          ) : (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">SOL</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono">{sol !== null ? sol.toFixed(4) : "-"}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={!sol || sol <= 0}
                    onClick={() => setWithdrawToken("SOL")}
                  >
                    Withdraw
                  </Button>
                </div>
              </div>
              <div className="flex items-center justify-between text-sm">
                <span className="font-medium">USDC</span>
                <div className="flex items-center gap-2">
                  <span className="font-mono">{usdc !== null ? usdc.toFixed(2) : "-"}</span>
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 px-2 text-xs"
                    disabled={!usdc || usdc <= 0}
                    onClick={() => setWithdrawToken("USDC")}
                  >
                    Withdraw
                  </Button>
                </div>
              </div>
              <p className="text-xs text-muted-foreground">
                Withdraw funds before your agent expires - remaining balance is not automatically
                returned.
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {withdrawToken && (
        <WithdrawDialog
          token={withdrawToken}
          balance={withdrawToken === "SOL" ? (sol ?? 0) : (usdc ?? 0)}
          usdcBalance={usdc ?? 0}
          instanceId={instanceId}
          ownerWallet={ownerWallet}
          open={true}
          onOpenChange={(open) => {
            if (!open) setWithdrawToken(null);
          }}
          onWithdrawn={() => void refreshUsdc()}
        />
      )}
    </>
  );
}

function GettingStartedCard({ telegramBotUsername }: { telegramBotUsername?: string | null }) {
  return (
    <Card className="shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BookOpen className="size-4" />
          Getting Started
        </CardTitle>
      </CardHeader>
      <CardContent>
        <Accordion type="multiple" className="w-full">
          <AccordionItem value="models">
            <AccordionTrigger>Available models</AccordionTrigger>
            <AccordionContent>
              <ul className="space-y-1.5 text-sm text-muted-foreground">
                <li>
                  <span className="font-medium text-foreground">Claude Sonnet 4.6</span>{" "}
                  <span className="text-xs">(default)</span>{" "}
                  <span className="text-xs text-muted-foreground">- ~$0.05-0.09/msg</span>
                </li>
                <li>
                  <span className="font-medium text-foreground">Claude Opus 4.6</span>{" "}
                  <span className="text-xs text-muted-foreground">- ~$0.09-0.15/msg</span>
                </li>
                <li>
                  <span className="font-medium text-foreground">GPT-5.2</span>{" "}
                  <span className="text-xs text-muted-foreground">- ~$0.04-0.07/msg</span>
                </li>
                <li>
                  <span className="font-medium text-foreground">Kimi K2.5</span>{" "}
                  <span className="text-xs text-muted-foreground">- ~$0.02-0.03/msg</span>
                </li>
                <li>
                  <span className="font-medium text-foreground">DeepSeek V3.2</span>{" "}
                  <span className="text-xs text-muted-foreground">- ~$0.003-0.006/msg</span>
                </li>
              </ul>
              <p className="mt-2 text-sm text-muted-foreground">
                Costs start low and grow as the conversation gets longer (the full chat history is
                sent with each message). Start a new chat to reset costs. Switch models in the chat
                interface.
              </p>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="wallet">
            <AccordionTrigger>Agent wallet & x402</AccordionTrigger>
            <AccordionContent>
              <p className="text-sm text-muted-foreground">
                Your agent has its own Solana wallet that pays for AI models and x402 services
                automatically. $0.30 USDC is reserved for inference - the rest is available for x402
                API calls. Top up by sending USDC (SPL) on Solana mainnet to the wallet address
                shown in Details above.
              </p>
            </AccordionContent>
          </AccordionItem>

          {telegramBotUsername && (
            <AccordionItem value="telegram">
              <AccordionTrigger>Telegram commands</AccordionTrigger>
              <AccordionContent>
                <ul className="space-y-1.5 text-sm text-muted-foreground">
                  <li>
                    <code className="font-medium text-foreground">/x402_balance</code> - Check
                    wallet balance and get the address for topping up
                  </li>
                  <li>
                    <code className="font-medium text-foreground">
                      /x402_send &lt;amount|all&gt; &lt;address&gt;
                    </code>{" "}
                    - Send USDC to any Solana address
                  </li>
                </ul>
                <p className="mt-2 text-sm text-muted-foreground">
                  You can also just chat naturally - your agent responds to regular messages too.
                </p>
              </AccordionContent>
            </AccordionItem>
          )}

          <AccordionItem value="capabilities">
            <AccordionTrigger>What your agent can do</AccordionTrigger>
            <AccordionContent>
              <p className="text-sm text-muted-foreground">
                Your agent can autonomously call any x402-enabled paid API using its wallet. It can
                also discover new paid APIs in the zauth directory. Try asking in the chat:
                &quot;What x402 APIs can you find?&quot;
              </p>
            </AccordionContent>
          </AccordionItem>
        </Accordion>
      </CardContent>
    </Card>
  );
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

function useElapsed(since: string) {
  const [elapsed, setElapsed] = useState(() =>
    Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000)),
  );
  useEffect(() => {
    const id = setInterval(
      () => setElapsed(Math.max(0, Math.floor((Date.now() - new Date(since).getTime()) / 1000))),
      1000,
    );
    return () => clearInterval(id);
  }, [since]);
  const m = Math.floor(elapsed / 60);
  const s = elapsed % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function ProvisioningStepper({
  step,
  createdAt,
}: {
  step: string | null | undefined;
  createdAt: string;
}) {
  const current = getProvisioningStepIndex(step);
  const elapsed = useElapsed(createdAt);

  return (
    <Card className="shadow-sm">
      <CardHeader className="pb-2">
        <div className="flex items-baseline justify-between">
          <CardTitle className="flex items-center gap-2">
            <Loader2 className="size-4 animate-spin text-info" />
            Provisioning - {elapsed}
          </CardTitle>
          <span className="text-xs text-muted-foreground">Usually takes ~3 minutes</span>
        </div>
      </CardHeader>
      <CardContent>
        <div className="flex items-start">
          {provisioningStepOrder.map((item, index) => {
            const label = getProvisioningStepLabel(item);
            const completed = index < current;
            const active = index === current;
            const isLast = index === provisioningStepOrder.length - 1;

            return (
              <div key={item} className={`flex items-start ${isLast ? "" : "flex-1"}`}>
                <div className="flex flex-col items-center">
                  <span
                    className={`inline-flex size-7 items-center justify-center rounded-full border-2 ${
                      completed
                        ? "border-success bg-success/10"
                        : active
                          ? "animate-pulse border-info bg-info/10"
                          : "border-border bg-background"
                    }`}
                  >
                    {completed ? (
                      <Check className="size-3.5 text-success" />
                    ) : active ? (
                      <Loader2 className="size-3.5 animate-spin text-info" />
                    ) : (
                      <span className="size-2 rounded-full bg-muted-foreground/40" />
                    )}
                  </span>
                  <span
                    className={`mt-1.5 text-center text-xs leading-tight ${
                      active ? "font-medium text-foreground" : "text-muted-foreground"
                    }`}
                  >
                    {label}
                  </span>
                </div>
                {!isLast && (
                  <div className="mt-3.5 flex-1 px-1">
                    <div
                      className={`h-0.5 w-full rounded ${
                        index < current ? "bg-success" : "bg-border"
                      }`}
                    />
                  </div>
                )}
              </div>
            );
          })}
        </div>
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
          <DialogTitle>Transfer Agent</DialogTitle>
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
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [editingName, setEditingName] = useState(false);
  const [nameValue, setNameValue] = useState("");
  const [nameSaving, setNameSaving] = useState(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const [confirmAction, setConfirmAction] = useState<"restart" | "delete" | null>(null);
  const [transferOpen, setTransferOpen] = useState(false);
  const [telegramSetupOpen, setTelegramSetupOpen] = useState(false);
  const [agentName, setAgentName] = useState("");
  const [agentDescription, setAgentDescription] = useState("");
  const [agentSaving, setAgentSaving] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);

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
      toast.success("Agent renamed");
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
        toast.success("Agent restarting");
        await fetchDetail({ showErrorToast: true });
      } else {
        await api.instances.delete(numId);
        toast.success("Agent deleted");
        navigate({ to: "/dashboard" });
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
    if (!signer) return;
    setActionLoading("extend");
    try {
      const updated = await api.instances.extend(numId, signer);
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
          to="/dashboard"
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
            to="/dashboard"
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
          <ProvisioningStepper step={instance.provisioningStep} createdAt={instance.createdAt} />
        )}

        <Card className="shadow-sm">
          <CardHeader className="flex flex-row items-center justify-between space-y-0">
            <CardTitle>Details</CardTitle>
            <button
              type="button"
              onClick={() => setShowAdvanced((v) => !v)}
              className="text-xs text-muted-foreground hover:text-foreground"
            >
              {showAdvanced ? "Hide details" : "Show details"}
            </button>
          </CardHeader>
          <CardContent>
            <dl className="grid grid-cols-[auto_1fr] gap-x-6 gap-y-3 text-sm">
              {showAdvanced && (
                <>
                  <dt className="text-muted-foreground">IP Address</dt>
                  <dd className="font-mono">{instance.ip}</dd>

                  <dt className="text-muted-foreground">Image ID</dt>
                  <dd className="font-mono">{instance.snapshotId ?? "—"}</dd>
                </>
              )}

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

              <dt className="text-muted-foreground">Telegram Bot</dt>
              <dd>
                {instance.telegramBotUsername ? (
                  <a
                    href={`https://t.me/${instance.telegramBotUsername}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-primary hover:underline"
                  >
                    @{instance.telegramBotUsername}
                    <ExternalLink className="size-3" />
                  </a>
                ) : instance.status === "running" ? (
                  <span className="inline-flex items-center gap-2">
                    <span className="italic text-muted-foreground">Not configured</span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-6 px-2 text-xs"
                      onClick={() => setTelegramSetupOpen(true)}
                    >
                      <Send className="size-3" />
                      Set up
                    </Button>
                  </span>
                ) : (
                  <span className="italic text-muted-foreground">Not configured</span>
                )}
              </dd>
            </dl>
          </CardContent>
        </Card>

        <Card className="shadow-sm">
          <CardHeader>
            <CardTitle>Access</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <AccessRow label="Chat" value={instance.chatUrl} />
            <AccessRow label="Terminal" value={instance.terminalUrl} />
          </CardContent>
        </Card>

        {instance.status === "running" && instance.vmWallet && (
          <WalletBalanceCard
            instanceId={instance.id}
            vmWallet={instance.vmWallet}
            ownerWallet={instance.ownerWallet}
          />
        )}

        {instance.status === "running" && (
          <TelegramSetupDialog
            instanceId={instance.id}
            instanceName={instance.name}
            open={telegramSetupOpen}
            onOpenChange={setTelegramSetupOpen}
            onConfigured={() => void fetchDetail()}
          />
        )}

        {instance.status === "running" && (
          <GettingStartedCard telegramBotUsername={instance.telegramBotUsername} />
        )}

        {health && (
          <Card className="shadow-sm">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                Health
                <Badge variant={health.healthy ? "success" : "destructive"}>
                  {health.healthy ? "Healthy" : "Unhealthy"}
                </Badge>
              </CardTitle>
            </CardHeader>
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
              disabled={actionLoading !== null || !signer}
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
              {confirmAction === "restart" ? "Restart Agent" : "Delete Agent"}
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
          onTransferred={() => navigate({ to: "/dashboard" })}
        />
      )}
    </main>
  );
}

const TELEGRAM_TOKEN_RE = /^\d+:[A-Za-z0-9_-]{35}$/;
const POLL_INTERVAL = 5_000;
const POLL_TIMEOUT = 90_000;

type TelegramPhase = "form" | "starting" | "live" | "error" | "timeout";

function TelegramSetupDialog({
  instanceId,
  instanceName,
  open,
  onOpenChange,
  onConfigured,
}: {
  instanceId: number;
  instanceName: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConfigured: () => void;
}) {
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [phase, setPhase] = useState<TelegramPhase>("form");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const pollStartRef = useRef<number>(0);
  const isValid = TELEGRAM_TOKEN_RE.test(token.trim());
  const suggestedName = instanceName
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
  const suggestedUsername = `ab_${instanceName.replace(/-/g, "_")}_bot`;

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const checkStatus = useCallback(async () => {
    try {
      const res = await api.instances.telegramStatus(instanceId);

      if (res.status === "live") {
        setPhase("live");
        stopPolling();
        toast.success("Telegram bot is live!");
        onConfigured();
        onOpenChange(false);
      } else if (res.status === "error") {
        setPhase("error");
        setErrorMsg(res.error ?? "Unknown error");
        stopPolling();
      }
    } catch {
      // Transient failure, keep polling
    }

    if (pollStartRef.current && Date.now() - pollStartRef.current > POLL_TIMEOUT) {
      setPhase("timeout");
      stopPolling();
    }
  }, [instanceId, stopPolling, onConfigured, onOpenChange]);

  const startPolling = useCallback(() => {
    stopPolling();
    setPhase("starting");
    pollStartRef.current = Date.now();
    void checkStatus();
    pollRef.current = setInterval(() => void checkStatus(), POLL_INTERVAL);
  }, [checkStatus, stopPolling]);

  // Clean up polling on unmount / close
  useEffect(() => {
    if (!open) {
      stopPolling();
      setPhase("form");
      setToken("");
      setErrorMsg(null);
    }
    return () => stopPolling();
  }, [open, stopPolling]);

  async function handleSubmit() {
    setSubmitting(true);
    try {
      await api.instances.telegram(instanceId, token.trim());
      toast.success("Bot token configured - checking connection...");
      startPolling();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to connect bot");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Send className="size-4" />
            Set Up Telegram Bot
          </DialogTitle>
          <DialogDescription>Connect a Telegram bot to chat with your agent.</DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {phase === "starting" && (
            <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" />
              Waiting for agent to connect bot...
            </div>
          )}

          {phase === "timeout" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-sm text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                Agent is still starting. Your bot will be ready shortly.
              </div>
              <Button size="sm" variant="outline" className="w-full" onClick={startPolling}>
                Check again
              </Button>
            </div>
          )}

          {phase === "error" && (
            <div className="space-y-2">
              <div className="flex items-center gap-2 rounded-md border border-destructive/50 bg-destructive/10 px-3 py-2 text-sm text-destructive">
                <X className="size-4 shrink-0" />
                {errorMsg}
              </div>
              <Button
                size="sm"
                variant="outline"
                className="w-full"
                onClick={() => {
                  setPhase("form");
                  setToken("");
                  setErrorMsg(null);
                }}
              >
                Try again
              </Button>
            </div>
          )}

          {phase === "form" && (
            <>
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
                    in Telegram and send{" "}
                    <code className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 text-xs">
                      /newbot
                      <CopyButton value="/newbot" />
                    </code>
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground">
                    2
                  </span>
                  <span>
                    For the name, send:{" "}
                    <code className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 text-xs">
                      {suggestedName}
                      <CopyButton value={suggestedName} />
                    </code>
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground">
                    3
                  </span>
                  <span>
                    For the username, send:{" "}
                    <code className="inline-flex items-center gap-1 rounded bg-muted px-1 py-0.5 text-xs">
                      {suggestedUsername}
                      <CopyButton value={suggestedUsername} />
                    </code>
                  </span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex size-5 shrink-0 items-center justify-center rounded-full border border-border bg-background text-xs font-medium text-foreground">
                    4
                  </span>
                  <span>Copy the bot token and paste it below</span>
                </li>
              </ol>

              <div className="space-y-2">
                <input
                  className="w-full rounded-md border border-input bg-muted px-3 py-2 font-mono text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
                  placeholder="123456789:ABCdefGHI..."
                  value={token}
                  onChange={(e) => setToken(e.target.value)}
                  disabled={submitting}
                />
                <Button
                  size="sm"
                  className="w-full"
                  disabled={!isValid || submitting}
                  onClick={() => void handleSubmit()}
                >
                  {submitting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Send className="size-3.5" />
                  )}
                  {submitting ? "Configuring on agent..." : "Connect Bot"}
                </Button>
                {token.length > 0 && !isValid && (
                  <p className="text-xs text-destructive">
                    Token format: digits, colon, then 35 characters
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
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
