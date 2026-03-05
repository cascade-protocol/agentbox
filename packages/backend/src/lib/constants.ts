/** Hetzner snapshot ID for VM provisioning. Update after `just build-image`. */
export const HETZNER_SNAPSHOT_ID = "364022409";

export const CF_ZONE_ID = "fda671fa572b4c2d26de8aedcbf94f6e";
export const FACILITATOR_URL = "https://facilitator.cascade.fyi";
export const PAY_TO_ADDRESS = "7NetKx8TuRMBpqYFKZCVetkNuvWCPTrgekmGrsJwTmfN";
export const INSTANCE_BASE_DOMAIN = "agentbox.fyi";
export const HETZNER_LOCATIONS = ["nbg1", "fsn1"];
export const HETZNER_SERVER_TYPE = "cx33";

/**
 * x402 provider catalog - single source of truth for model metadata.
 * Both the OpenClaw gateway (models.providers) and the plugin (config.providers)
 * read from this. Gateway uses id/name/maxTokens; plugin uses all fields.
 *
 * Extra fields (cost, reasoning, input, contextWindow) are ignored by the gateway
 * but consumed by the plugin for cost estimation and /x_models display.
 */
const X402_PROVIDERS = {
  agentbox: {
    baseUrl: "https://inference.x402.agentbox.fyi/v1",
    models: [
      {
        id: "moonshotai/kimi-k2.5",
        name: "Kimi K2.5",
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0.15, output: 0.3, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262144,
      },
      {
        id: "minimax/minimax-m2.5",
        name: "MiniMax M2.5",
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
      },
    ],
  },
  blockrun: {
    baseUrl: "https://sol.blockrun.ai/api/v1",
    models: [
      // Sonnet 4.6 disabled: verbose, burns tokens, worse instruction following than 4.5
      // {
      //   id: "anthropic/claude-sonnet-4.6", name: "Claude Sonnet 4.6", maxTokens: 2048,
      //   reasoning: true, input: ["text", "image"],
      //   cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
      //   contextWindow: 200000,
      // },
      {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        maxTokens: 2048,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
      },
      {
        id: "anthropic/claude-opus-4.6",
        name: "Claude Opus 4.6",
        maxTokens: 2048,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 10, output: 37.5, cacheRead: 1, cacheWrite: 12.5 },
        contextWindow: 200000,
      },
      {
        id: "openai/gpt-5.2",
        name: "GPT-5.2",
        maxTokens: 2048,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.75, output: 14, cacheRead: 0.44, cacheWrite: 1.75 },
        contextWindow: 400000,
      },
      {
        id: "moonshot/kimi-k2.5",
        name: "Kimi K2.5",
        maxTokens: 4096,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.6, output: 3, cacheRead: 0.3, cacheWrite: 0.6 },
        contextWindow: 262144,
      },
      {
        id: "deepseek/deepseek-chat",
        name: "DeepSeek V3.2",
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0.23, output: 0.34, cacheRead: 0.12, cacheWrite: 0.23 },
        contextWindow: 163840,
      },
    ],
  },
  aimo: {
    baseUrl: "https://beta.aimo.network/api/v1",
    models: [
      {
        id: "anthropic/claude-sonnet-4.5",
        name: "Claude Sonnet 4.5",
        maxTokens: 2048,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
        contextWindow: 200000,
      },
      {
        id: "anthropic/claude-opus-4.6",
        name: "Claude Opus 4.6",
        maxTokens: 2048,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 10, output: 37.5, cacheRead: 1, cacheWrite: 12.5 },
        contextWindow: 200000,
      },
      {
        id: "deepseek/deepseek-v3.2",
        name: "DeepSeek V3.2",
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0.23, output: 0.34, cacheRead: 0.12, cacheWrite: 0.23 },
        contextWindow: 163840,
      },
      {
        id: "moonshot/kimi-k2.5",
        name: "Kimi K2.5",
        maxTokens: 4096,
        reasoning: false,
        input: ["text", "image"],
        cost: { input: 0.6, output: 3, cacheRead: 0.3, cacheWrite: 0.6 },
        contextWindow: 262144,
      },
      {
        id: "openai/gpt-5.2",
        name: "GPT-5.2",
        maxTokens: 2048,
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 1.75, output: 14, cacheRead: 0.44, cacheWrite: 1.75 },
        contextWindow: 400000,
      },
      {
        id: "zai-org/glm-5",
        name: "GLM-5",
        maxTokens: 4096,
        reasoning: true,
        input: ["text"],
        cost: { input: 1.02, output: 2.98, cacheRead: 0.51, cacheWrite: 1.02 },
        contextWindow: 203000,
      },
      {
        id: "zai-org/glm-4.7-flash",
        name: "GLM-4.7 Flash",
        maxTokens: 4096,
        reasoning: false,
        input: ["text"],
        cost: { input: 0.09, output: 0.37, cacheRead: 0.05, cacheWrite: 0.09 },
        contextWindow: 203000,
      },
    ],
  },
};

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
 * - Plugin config receives the same `X402_PROVIDERS` object, so model metadata
 *   (cost, reasoning, contextWindow) is defined once and shared. The gateway
 *   ignores the extra fields; the plugin uses them for cost tracking and display.
 * - The `rpcUrl` field is merged at boot time from the env var (per-instance).
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
      agentbox: {
        ...X402_PROVIDERS.agentbox,
        apiKey: "x402-payment",
        api: "openai-completions",
      },
      blockrun: {
        ...X402_PROVIDERS.blockrun,
        apiKey: "x402-payment",
        api: "openai-completions",
      },
      aimo: {
        ...X402_PROVIDERS.aimo,
        apiKey: "x402-payment",
        api: "openai-completions",
      },
    },
  },
  channels: {
    telegram: {
      linkPreview: false,
      dmPolicy: "pairing",
      groupPolicy: "open",
      groups: { "-1003579023474": { requireMention: true, historyLimit: 50 } },
      ackReaction: "\uD83D\uDC4B",
    },
  },
  plugins: {
    installs: {
      "openclaw-x402": { source: "npm", spec: "openclaw-x402@latest" },
    },
    entries: {
      "openclaw-x402": {
        enabled: true,
        config: {
          keypairPath: "/home/openclaw/.openclaw/agentbox/wallet-sol.json",
          providers: X402_PROVIDERS,
        },
      },
      telegram: { enabled: true },
    },
  },
  agents: {
    defaults: {
      model: { primary: "agentbox/moonshotai/kimi-k2.5" },
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
