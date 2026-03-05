import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "smoke",
    environment: "node",
    include: ["**/*.test.ts"],
    testTimeout: 600_000,
  },
});
