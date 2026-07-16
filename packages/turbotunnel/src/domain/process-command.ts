export function formatProcessCommand(executable: string, args: ReadonlyArray<string>): string {
  return [executable, ...redactArguments(args)].map(formatArgument).join(" ");
}

function formatArgument(argument: string): string {
  const escaped = escapeControls(argument);
  return /^[A-Za-z0-9_./:@%+=,<>{}-]+$/u.test(escaped) ? escaped : JSON.stringify(escaped);
}

function redactArguments(args: ReadonlyArray<string>): ReadonlyArray<string> {
  let redactNext = false;
  return args.map((argument) => {
    if (redactNext) {
      redactNext = false;
      return "<redacted>";
    }
    const equals =
      /^(--?(?:[a-z0-9]+-)*(?:auth|credential|key|password|secret|token)(?:-[a-z0-9]+)*)=(.*)$/iu.exec(
        argument,
      );
    if (equals !== null) return `${equals[1]}=<redacted>`;
    if (
      /^--?(?:[a-z0-9]+-)*(?:auth|credential|key|password|secret|token)(?:-[a-z0-9]+)*$/iu.test(
        argument,
      )
    ) {
      redactNext = true;
      return argument;
    }
    if (/^(?:[A-Z0-9_]*(?:AUTH|CREDENTIAL|KEY|PASSWORD|SECRET|TOKEN)[A-Z0-9_]*)=/u.test(argument)) {
      return `${argument.slice(0, argument.indexOf("="))}=<redacted>`;
    }
    return argument;
  });
}

function escapeControls(text: string): string {
  return Array.from(text, (character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f)
      ? `\\u${codePoint.toString(16).padStart(4, "0")}`
      : character;
  }).join("");
}
