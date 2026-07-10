import { defineConfig } from "rolldown";

export default defineConfig({
  input: "src/main.ts",
  platform: "node",
  output: {
    file: "dist/main.js",
    format: "esm",
  },
});
