/** Hetzner snapshot ID for VM provisioning. Update after `just build-image`. */
export const HETZNER_SNAPSHOT_ID = "363679269";

/**
 * Full OpenClaw config served to VMs at boot via /instances/config.
 * Change here to update OpenClaw settings without an image rebuild.
 *
 * Provider/model architecture:
 * - `models.mode: "replace"` hides all 700+ built-in provider models.
 *   Only providers listed in `models.providers` appear in `/models`.
 * - `models.providers` is the ONLY way to populate the model catalog.
 *   The plugin's `registerProvider()` API is for auth flows only (OAuth,
 *   API key, device code) - it does NOT add models to the resolution system.
 *   Do not pass models through plugin config expecting them to show up.
 * - Plugin config (`plugins.entries.openclaw-x402.config`) only needs
 *   `providerUrl`, `providerName`, and `keypairPath`. The `rpcUrl` field
 *   is merged at boot time from the env var (per-instance).
 */
export const OPENCLAW_BASE_CONFIG = {
  gateway: {
    mode: "local",
    port: 18789,
    bind: "loopback",
    auth: { mode: "token" },
    controlUi: { dangerouslyDisableDeviceAuth: true },
    http: { endpoints: { chatCompletions: { enabled: true } } },
  },
  update: { auto: { enabled: false }, checkOnStart: false },
  logging: { maxFileBytes: 104857600 },
  tools: { profile: "full" },
  models: {
    mode: "replace",
    providers: {
      blockrun: {
        baseUrl: "https://sol.blockrun.ai/api/v1",
        apiKey: "x402-payment",
        api: "openai-completions",
        models: [
          { id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", maxTokens: 2048 },
          { id: "anthropic/claude-opus-4.6", name: "Claude Opus 4.6", maxTokens: 2048 },
          { id: "openai/gpt-5.2", name: "GPT-5.2", maxTokens: 2048 },
          { id: "moonshot/kimi-k2.5", name: "Kimi K2.5", maxTokens: 4096 },
          { id: "deepseek/deepseek-v3.2", name: "DeepSeek V3.2", maxTokens: 4096 },
        ],
      },
    },
  },
  plugins: {
    entries: {
      "openclaw-x402": {
        enabled: true,
        config: {
          providerUrl: "https://sol.blockrun.ai",
          providerName: "blockrun",
          keypairPath: "/home/openclaw/.openclaw/agentbox/wallet-sol.json",
        },
      },
      telegram: { enabled: true },
    },
  },
  agents: {
    defaults: {
      model: { primary: "blockrun/moonshot/kimi-k2.5" },
      skipBootstrap: true,
      timeoutSeconds: 120,
      compaction: {
        mode: "default",
        reserveTokensFloor: 20000,
        memoryFlush: { enabled: true },
      },
      contextPruning: {
        mode: "cache-ttl",
        ttl: "10m",
        keepLastAssistants: 3,
        minPrunableToolChars: 20000,
      },
    },
  },
};

/** Hetzner SSH key IDs to inject into provisioned VMs. */
export const HETZNER_SSH_KEY_IDS = [107690222, 108071540];
