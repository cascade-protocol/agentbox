import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: ["packages/*", "tests/*"],
    passWithNoTests: true,
    coverage: {
      provider: "v8",
      include: ["packages/**/src/**/*.{ts,tsx}"],
    },
  },
});
