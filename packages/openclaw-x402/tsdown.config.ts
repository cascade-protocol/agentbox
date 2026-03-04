import { defineConfig } from "tsdown";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    fixedExtension: false,
    dts: false,
    clean: true,
    treeshake: true,
  },
  {
    entry: { "bin/cli": "src/bin/cli.ts" },
    format: ["esm"],
    fixedExtension: false,
    dts: false,
    clean: false,
    treeshake: true,
    banner: { js: "#!/usr/bin/env node" },
  },
]);
