import type { BadgeVariant } from "@/components/ui/badge";

export const statusVariant: Record<string, BadgeVariant> = {
  provisioning: "info",
  minting: "info",
  running: "success",
  stopped: "secondary",
  error: "destructive",
  deleting: "warning",
};

const fallbackStep = "vm_created";

export const provisioningStepOrder = [
  "vm_created",
  "configuring",
  "wallet_created",
  "openclaw_ready",
  "services_starting",
] as const;

const provisioningStepLabels: Record<(typeof provisioningStepOrder)[number], string> = {
  vm_created: "Starting VM...",
  configuring: "Configuring services...",
  wallet_created: "Wallet created",
  openclaw_ready: "OpenClaw ready",
  services_starting: "Almost ready...",
};

export function getStatusVariant(status: string): BadgeVariant {
  return statusVariant[status] ?? "secondary";
}

export function normalizeProvisioningStep(
  step: string | null | undefined,
): (typeof provisioningStepOrder)[number] {
  if (!step || step === fallbackStep) {
    return fallbackStep;
  }

  const knownStep = provisioningStepOrder.find((item) => item === step);
  return knownStep ?? fallbackStep;
}

export function getProvisioningStepLabel(step: string | null | undefined): string {
  return provisioningStepLabels[normalizeProvisioningStep(step)];
}

export function getProvisioningStepIndex(step: string | null | undefined): number {
  return provisioningStepOrder.indexOf(normalizeProvisioningStep(step));
}
