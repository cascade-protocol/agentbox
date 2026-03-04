/** Hetzner snapshot ID for VM provisioning. Update after `just build-image`. */
export const HETZNER_SNAPSHOT_ID = "363538256";

/** LLM provider defaults - baked into codebase, not env-overridable. */
export const LLM_PROVIDER_URL = "https://sol.blockrun.ai";
export const LLM_PROVIDER_NAME = "blockrun";
export const LLM_DEFAULT_MODEL = "moonshot/kimi-k2.5";

/** Model catalog served to VMs. Change here to add/remove models without image rebuild. */
export const LLM_MODELS = [
  {
    id: "anthropic/claude-sonnet-4.6",
    name: "Claude Sonnet 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
    contextWindow: 200000,
    maxTokens: 2048,
  },
  {
    id: "anthropic/claude-opus-4.6",
    name: "Claude Opus 4.6",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
    contextWindow: 200000,
    maxTokens: 2048,
  },
  {
    id: "openai/gpt-5.2",
    name: "GPT-5.2",
    reasoning: true,
    input: ["text", "image"],
    cost: { input: 1.75, output: 14, cacheRead: 0.44, cacheWrite: 1.75 },
    contextWindow: 400000,
    maxTokens: 2048,
  },
  {
    id: "moonshot/kimi-k2.5",
    name: "Kimi K2.5",
    reasoning: false,
    input: ["text", "image"],
    cost: { input: 0.6, output: 3, cacheRead: 0.3, cacheWrite: 0.6 },
    contextWindow: 262144,
    maxTokens: 4096,
  },
  {
    id: "deepseek/deepseek-v3.2",
    name: "DeepSeek V3.2",
    reasoning: false,
    input: ["text"],
    cost: { input: 0.23, output: 0.34, cacheRead: 0.12, cacheWrite: 0.23 },
    contextWindow: 163840,
    maxTokens: 4096,
  },
];

/**
 * Base OpenClaw config served to VMs at boot via /instances/config.
 * Change here to update OpenClaw settings without an image rebuild.
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
  skills: { load: { extraDirs: ["/home/openclaw/agentbox/skills"] } },
  update: { auto: { enabled: false }, checkOnStart: false },
  logging: { maxFileBytes: 104857600 },
  tools: { profile: "full" },
  agents: {
    defaults: {
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
