import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";

/** Source and output locations used to build a standalone gateway deployment. */
export type BuildGatewayDeploymentInput = {
  readonly gatewayRoot: string;
  readonly contractsRoot: string;
  readonly outputDir: string;
};

/** Builds the standalone Vercel deployment artifact owned by the gateway package. */
export async function buildGatewayDeployment(input: BuildGatewayDeploymentInput): Promise<void> {
  await rm(input.outputDir, { recursive: true, force: true });
  await mkdir(join(input.outputDir, "src"), { recursive: true });

  await cp(join(input.gatewayRoot, "vercel"), input.outputDir, { recursive: true });
  await copyTypeScriptDirectory(
    join(input.gatewayRoot, "src"),
    join(input.outputDir, "src", "gateway"),
    (text) => text.replaceAll('from "@turbotunnel/contracts"', 'from "../contracts/index.js"'),
  );
  await copyTypeScriptDirectory(
    join(input.contractsRoot, "src"),
    join(input.outputDir, "src", "contracts"),
    (text) => text,
  );

  const serverPath = join(input.outputDir, "api", "server.ts");
  const server = await readFile(serverPath, "utf8");
  await writeFile(
    serverPath,
    server.replace('from "@turbotunnel/gateway"', 'from "../src/gateway/index.js"'),
  );

  await writeFile(
    join(input.outputDir, "package.json"),
    `${JSON.stringify(deploymentPackage(), null, 2)}\n`,
  );
  await writeFile(
    join(input.outputDir, "tsconfig.json"),
    `${JSON.stringify(deploymentTsconfig(), null, 2)}\n`,
  );
  await assertStandalone(input.outputDir);
}

async function copyTypeScriptDirectory(
  source: string,
  target: string,
  transform: (text: string) => string,
): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".turbo") {
      continue;
    }

    const sourcePath = join(source, entry.name);
    const targetPath = join(target, entry.name);
    if (entry.isDirectory()) {
      await copyTypeScriptDirectory(sourcePath, targetPath, transform);
      continue;
    }

    if (sourcePath.endsWith(".ts")) {
      await writeFile(targetPath, transform(await readFile(sourcePath, "utf8")));
      continue;
    }

    await cp(sourcePath, targetPath);
  }
}

function deploymentPackage() {
  return {
    name: "turbotunnel-gateway-deployment",
    version: TURBOTUNNEL_VERSION,
    private: true,
    type: "module",
    dependencies: {
      effect: "4.0.0-beta.92",
      nanoid: "^5.1.6",
      ws: "^8.18.3",
    },
    devDependencies: {
      "@types/node": "^22.15.3",
      "@types/ws": "^8.18.1",
      typescript: "6.0.3",
    },
  } as const;
}

function deploymentTsconfig() {
  return {
    compilerOptions: {
      target: "ES2022",
      lib: ["ES2022"],
      module: "NodeNext",
      moduleResolution: "NodeNext",
      strict: true,
      strictNullChecks: true,
      esModuleInterop: true,
      skipLibCheck: true,
      forceConsistentCasingInFileNames: true,
    },
    include: ["api", "src"],
  } as const;
}

async function assertStandalone(outputDir: string): Promise<void> {
  const workspaceImports = [
    "@turbotunnel/gateway",
    "@turbotunnel/contracts",
    "@turbotunnel/typescript-config",
  ];
  const matches = await filesContainingAny(outputDir, workspaceImports);
  if (matches.length > 0) {
    throw new Error(`Gateway deployment contains workspace-only imports in ${matches.join(", ")}.`);
  }

  for (const relativePath of [
    "api/server.ts",
    "src/gateway/index.ts",
    "src/contracts/index.ts",
    "package.json",
    "tsconfig.json",
    "vercel.json",
  ]) {
    const path = join(outputDir, relativePath);
    const info = await stat(path).catch((cause: unknown) => {
      throw new Error(`Gateway deployment is missing ${relativePath}.`, { cause });
    });
    if (!info.isFile()) {
      throw new Error(`Gateway deployment path is not a file: ${relativePath}.`);
    }
  }
}

async function filesContainingAny(
  directory: string,
  needles: ReadonlyArray<string>,
): Promise<Array<string>> {
  const matches: Array<string> = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.name === "node_modules" || entry.name === ".vercel") {
      continue;
    }

    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      matches.push(...(await filesContainingAny(path, needles)));
      continue;
    }
    if (!path.endsWith(".ts") && !path.endsWith(".json")) {
      continue;
    }

    const text = await readFile(path, "utf8");
    if (needles.some((needle) => text.includes(needle))) {
      matches.push(path);
    }
  }
  return matches;
}

const gatewayRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await buildGatewayDeployment({
    gatewayRoot,
    contractsRoot: resolve(gatewayRoot, "..", "contracts"),
    outputDir: join(gatewayRoot, "dist", "deployment"),
  });
}
