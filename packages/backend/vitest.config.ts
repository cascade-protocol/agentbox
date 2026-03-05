import { defineProject } from "vitest/config";

export default defineProject({
  test: {
    name: "backend",
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
