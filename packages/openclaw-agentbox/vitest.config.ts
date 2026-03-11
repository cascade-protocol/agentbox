import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "openclaw-agentbox",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
