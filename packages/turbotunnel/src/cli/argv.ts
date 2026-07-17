// OS argument vectors cannot contain NUL, so user input cannot collide with this parser escape.
const DEV_ARGUMENT_PREFIX = "\0turbotunnel-dev:";

export function prepareCliArgv(argv: ReadonlyArray<string>): ReadonlyArray<string> {
  const delimiterIndex = argv.indexOf("--");
  const devIndex = argv.indexOf("dev");
  if (devIndex === -1 || delimiterIndex <= devIndex) return argv;

  return [
    ...argv.slice(0, delimiterIndex),
    ...argv.slice(delimiterIndex + 1).map(encodeDevArgument),
  ];
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
