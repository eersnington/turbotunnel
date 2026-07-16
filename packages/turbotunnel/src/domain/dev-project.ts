import { Effect } from "effect";

import { CliConfigError, DevScriptNotFound } from "../errors.js";

export type PackageManager = "npm" | "pnpm" | "yarn" | "bun";

export type DevProject = {
  readonly root: string;
  readonly packageJsonPath: string;
  readonly packageManager: PackageManager;
  readonly scripts: Readonly<Record<string, string>>;
};

export type DevCommandInput = {
  readonly port?: number;
  readonly command: ReadonlyArray<string>;
};

export type DevLaunch = {
  readonly executable: string;
  readonly args: ReadonlyArray<string>;
  readonly port: number;
  readonly framework: Framework | undefined;
};

export type Framework = "next" | "vite" | "astro" | "nuxt" | "storybook";

const FRAMEWORK_EXECUTABLES: ReadonlyArray<readonly [Framework, ReadonlyArray<string>]> = [
  ["next", ["next"]],
  ["vite", ["vite"]],
  ["astro", ["astro"]],
  ["nuxt", ["nuxt", "nuxt3", "nuxi"]],
  ["storybook", ["storybook", "start-storybook", "@storybook/cli"]],
];

export const customCommandPort = Effect.fn("customCommandPort")(function* (
  command: ReadonlyArray<string>,
): Effect.fn.Return<number | undefined, CliConfigError> {
  const framework = frameworkFromExecutable(command[0]);
  const flags = framework === "next" ? ["--port", "-p"] : ["--port"];
  for (let index = 1; index < command.length; index += 1) {
    const argument = command[index];
    if (argument === undefined) continue;
    if (flags.includes(argument)) {
      return yield* parseCommandPort(command[index + 1]);
    }
    if (argument.startsWith("--port=")) {
      return yield* parseCommandPort(argument.slice("--port=".length));
    }
  }
  return undefined;
});

export const resolveDevLaunch = Effect.fn("resolveDevLaunch")(function* (
  project: DevProject,
  input: DevCommandInput,
  port: number,
): Effect.fn.Return<DevLaunch, DevScriptNotFound | CliConfigError> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    return yield* new CliConfigError({ message: "Port must be an integer from 1 to 65535." });
  }

  if (input.command.length > 0) {
    const [executable, ...originalArgs] = input.command;
    if (executable === undefined || executable.length === 0) {
      return yield* new CliConfigError({
        message: "Custom dev command executable cannot be empty.",
      });
    }
    const framework = frameworkFromExecutable(executable);
    const hasPort = hasCustomPortArgument(originalArgs, framework);
    const args =
      framework === undefined
        ? hasPort
          ? [...removePortArguments(originalArgs, framework), "--port", String(port)]
          : originalArgs
        : appendFrameworkPort(originalArgs, framework, port);
    return { executable, args, port, framework };
  }

  const devScript = project.scripts.dev;
  if (devScript === undefined) {
    return yield* new DevScriptNotFound({
      path: project.packageJsonPath,
      message: `No \`dev\` script was found in ${project.packageJsonPath}. Add one or pass a command after \`tt dev --\`. No child process or tunnel was started.`,
    });
  }

  const framework = frameworkFromScript(devScript);
  const frameworkArgs = appendFrameworkPort([], framework, port);
  return {
    executable: project.packageManager,
    args: packageManagerDevArgs(project.packageManager, frameworkArgs),
    port,
    framework,
  };
});

function packageManagerDevArgs(
  packageManager: PackageManager,
  frameworkArgs: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (frameworkArgs.length === 0) return ["run", "dev"];
  return packageManager === "npm"
    ? ["run", "dev", "--", ...frameworkArgs]
    : ["run", "dev", ...frameworkArgs];
}

function appendFrameworkPort(
  args: ReadonlyArray<string>,
  framework: Framework | undefined,
  port: number,
): ReadonlyArray<string> {
  if (framework === undefined) return args;
  const withoutPort = removePortArguments(args, framework);
  switch (framework) {
    case "next":
      return [...withoutPort, "-p", String(port)];
    case "vite":
      return [...withoutPort, "--port", String(port), "--strictPort"];
    case "astro":
    case "nuxt":
    case "storybook":
      return [...withoutPort, "--port", String(port)];
  }
}

function removePortArguments(
  args: ReadonlyArray<string>,
  framework: Framework | undefined,
): ReadonlyArray<string> {
  const result: Array<string> = [];
  const flags = framework === "next" ? ["--port", "-p"] : ["--port"];
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (argument === undefined) continue;
    if (flags.includes(argument)) {
      index += 1;
      continue;
    }
    if (argument.startsWith("--port=")) continue;
    if (framework === "vite" && argument === "--strictPort") continue;
    result.push(argument);
  }
  return result;
}

function frameworkFromExecutable(executable: string | undefined): Framework | undefined {
  if (executable === undefined) return undefined;
  const name = executable.replaceAll("\\", "/").split("/").at(-1)?.toLowerCase();
  return FRAMEWORK_EXECUTABLES.find(([, names]) => name !== undefined && names.includes(name))?.[0];
}

function frameworkFromScript(script: string | undefined): Framework | undefined {
  if (script === undefined) return undefined;
  const executables = script.split(/\s+/u);
  return FRAMEWORK_EXECUTABLES.find(([framework, names]) =>
    names.some((name) => executables.includes(name) || executables.includes(framework)),
  )?.[0];
}

function hasCustomPortArgument(
  args: ReadonlyArray<string>,
  framework: Framework | undefined,
): boolean {
  const flags = framework === "next" ? ["--port", "-p"] : ["--port"];
  return args.some((argument) => flags.includes(argument) || argument.startsWith("--port="));
}

function parseCommandPort(value: string | undefined): Effect.Effect<number, CliConfigError> {
  if (value === undefined || !/^\d+$/u.test(value)) {
    return Effect.fail(
      new CliConfigError({
        message: "Custom dev command port must be an integer from 1 to 65535.",
      }),
    );
  }
  const port = Number(value);
  return Number.isInteger(port) && port >= 1 && port <= 65_535
    ? Effect.succeed(port)
    : Effect.fail(
        new CliConfigError({
          message: "Custom dev command port must be an integer from 1 to 65535.",
        }),
      );
}
