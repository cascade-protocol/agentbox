import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "openclaw-x402",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
