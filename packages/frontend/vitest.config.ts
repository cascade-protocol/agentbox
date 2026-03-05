import react from "@vitejs/plugin-react";
import { defineProject } from "vitest/config";

export default defineProject({
  plugins: [react()],
  test: {
    name: "frontend",
    environment: "happy-dom",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
