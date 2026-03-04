import { AsyncLocalStorage } from "node:async_hooks";

export const payerStore = new AsyncLocalStorage<{ payer?: string }>();
