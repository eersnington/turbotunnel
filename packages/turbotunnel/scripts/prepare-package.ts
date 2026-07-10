import { cp, mkdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const cliRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const gatewayTemplateDir = join(cliRoot, "gateway-template");

await rm(gatewayTemplateDir, { recursive: true, force: true });
await mkdir(join(gatewayTemplateDir, "src"), { recursive: true });

await cp(join(cliRoot, "..", "gateway", "vercel"), gatewayTemplateDir, { recursive: true });
await cp(join(cliRoot, "..", "gateway", "src"), join(gatewayTemplateDir, "src", "gateway"), {
  recursive: true,
});
await cp(join(cliRoot, "..", "contracts", "src"), join(gatewayTemplateDir, "src", "contracts"), {
  recursive: true,
});

await assertFile(join(cliRoot, "dist", "main.js"));
await assertFile(join(gatewayTemplateDir, "api", "server.ts"));
await assertFile(join(gatewayTemplateDir, "src", "gateway", "index.ts"));
await assertFile(join(gatewayTemplateDir, "src", "contracts", "index.ts"));

async function assertFile(path: string): Promise<void> {
  const stats = await stat(path).catch((cause: unknown) => {
    throw new Error(`Expected package file was not created: ${path}`, { cause });
  });

  if (!stats.isFile()) {
    throw new Error(`Expected package path to be a file: ${path}`);
  }
}
