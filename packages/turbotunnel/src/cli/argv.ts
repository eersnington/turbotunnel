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
  return argv.map((argument) => {
    if (!argument.startsWith(DEV_ARGUMENT_PREFIX)) return argument;
    try {
      return decodeURIComponent(argument.slice(DEV_ARGUMENT_PREFIX.length));
    } catch {
      return argument;
    }
  });
}

function encodeDevArgument(argument: string): string {
  return `${DEV_ARGUMENT_PREFIX}${encodeURIComponent(argument)}`;
}
