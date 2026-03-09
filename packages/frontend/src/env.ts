export const env = {
  apiUrl: import.meta.env.VITE_API_URL ?? "",
  instanceBaseDomain: import.meta.env.VITE_INSTANCE_BASE_DOMAIN ?? "agentbox.fyi",
  heliusApiKey: import.meta.env.VITE_HELIUS_API_KEY ?? "",
  enableInstanceCreation: import.meta.env.VITE_ENABLE_INSTANCE_CREATION ?? false,
  privyAppId: (import.meta.env.VITE_PRIVY_APP_ID as string) || "cmmi1ag9e03jd0dl8zmussizw",
} as const;
