import { Context, Effect, Layer } from "effect";

export type CliMessage =
  | {
      readonly _tag: "Text";
      readonly stream: "stdout" | "stderr";
      readonly text: string;
    }
  | {
      readonly _tag: "Json";
      readonly stream: "stdout" | "stderr";
      readonly value: unknown;
    };

export type CliOutputShape = {
  readonly write: (message: CliMessage) => Effect.Effect<void>;
};

export class CliOutput extends Context.Service<CliOutput, CliOutputShape>()(
  "turbotunnel/effect/CliOutput",
) {
  static readonly live = Layer.succeed(
    this,
    this.of({
      write: (message) =>
        Effect.sync(() => {
          const text = message._tag === "Json" ? JSON.stringify(message.value) : message.text;
          const stream = message.stream === "stdout" ? process.stdout : process.stderr;
          stream.write(ensureNewline(text));
        }),
    }),
  );
}

function ensureNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
