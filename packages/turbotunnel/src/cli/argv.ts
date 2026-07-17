// OS argument vectors cannot contain NUL, so user input cannot collide with this parser escape.
const DEV_ARGUMENT_PREFIX = "\0turbotunnel-dev:";

export function prepareCliArgv(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  // Normalize --password before rewriting `tt dev -- ...` so bare --password is not
  // paired with an encoded custom-command token after `--` is stripped.
  return prepareDevArgv(normalizePasswordFlag(argv));
}

function prepareDevArgv(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  const delimiterIndex = argv.indexOf("--");
  const devIndex = argv.indexOf("dev");
  if (devIndex === -1 || delimiterIndex <= devIndex) return argv;

  return [
    ...argv.slice(0, delimiterIndex),
    ...argv.slice(delimiterIndex + 1).map(encodeDevArgument),
  ];
}

// Bare `--password` becomes `--password=` so optional Flag.string is present with an empty value.
function normalizePasswordFlag(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  const result: Array<string> = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!;
    if (argument === "--") {
      result.push(...argv.slice(index));
      break;
    }
    if (argument === "--password") {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("-")) {
        result.push("--password=");
      } else {
        result.push(`--password=${next}`);
        index += 1;
      }
      continue;
    }
    result.push(argument);
  }
  return result;
}

export function decodeDevArguments(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  return argv.map((argument) =>
    argument.startsWith(DEV_ARGUMENT_PREFIX)
      ? decodeURIComponent(argument.slice(DEV_ARGUMENT_PREFIX.length))
      : argument,
  );
}

export function parseDevArguments(argv: ReadonlyArray<string>): {
  readonly project: string | undefined;
  readonly command: ReadonlyArray<string>;
} {
  const projectArguments = argv.filter((argument) => !argument.startsWith(DEV_ARGUMENT_PREFIX));
  if (projectArguments.length > 1) {
    return { project: projectArguments.join(" "), command: [] };
  }
  return {
    project: projectArguments[0],
    command: decodeDevArguments(
      argv.filter((argument) => argument.startsWith(DEV_ARGUMENT_PREFIX)),
    ),
  };
}

function encodeDevArgument(argument: string): string {
  return `${DEV_ARGUMENT_PREFIX}${encodeURIComponent(argument)}`;
}
