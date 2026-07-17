import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Context, Effect, FiberHandle, Layer, SynchronizedRef, type Scope } from "effect";
import pc from "picocolors";

export type TerminalCapabilities = {
  readonly interactive: boolean;
  readonly color: boolean;
};

type SurfaceState =
  | { readonly _tag: "Idle"; readonly opened: boolean }
  | {
      readonly _tag: "Progress";
      readonly opened: boolean;
      readonly text: string;
      readonly frame: number;
    }
  | { readonly _tag: "ChildOwned"; readonly opened: boolean }
  | { readonly _tag: "Closed"; readonly opened: boolean };

type TerminalSurfaceShape = {
  readonly capabilities: TerminalCapabilities;
  readonly progress: (text: string) => Effect.Effect<void>;
  readonly settle: (text: string) => Effect.Effect<void>;
  readonly append: (text: string) => Effect.Effect<void>;
  readonly releaseToChild: Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
};

type TerminalSurfaceOptions = {
  readonly capabilities: TerminalCapabilities;
  readonly write: (text: string) => Effect.Effect<void>;
};

export class TerminalSurface extends Context.Service<TerminalSurface, TerminalSurfaceShape>()(
  "turbotunnel/effect/TerminalSurface",
) {
  static readonly layer = (options: TerminalSurfaceOptions) =>
    Layer.effect(this, makeTerminalSurface(options));

  static readonly live = this.layer({
    capabilities: terminalCapabilities(process.env, process.stderr),
    write: (text) => Effect.sync(() => process.stderr.write(text)),
  });
}

// Full-cell braille keeps the glyph optical center aligned with Latin text.
const SPINNER_FRAMES = ["⣾", "⣽", "⣻", "⢿", "⡿", "⣟", "⣯", "⣷"] as const;
const CLEAR_LINE = "\r\u001B[2K";
const CLEAR_VIEWPORT = "\u001B[H\u001B[2J";

function makeTerminalSurface(
  options: TerminalSurfaceOptions,
): Effect.Effect<TerminalSurfaceShape, never, Scope.Scope> {
  return Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<SurfaceState>({ _tag: "Idle", opened: false });
    const spinner = yield* FiberHandle.make<void>();
    const colors = pc.createColors(options.capabilities.color);

    const stateResult = <A>(value: A, next: SurfaceState): readonly [A, SurfaceState] => [
      value,
      next,
    ];

    const openState = (current: SurfaceState): Effect.Effect<SurfaceState> => {
      if (current._tag === "Closed" || current.opened) return Effect.succeed(current);
      const heading = options.capabilities.interactive
        ? `${CLEAR_VIEWPORT}${colors.cyan(`. turbotunnel ${TURBOTUNNEL_VERSION}`)}\n\n`
        : `. turbotunnel ${TURBOTUNNEL_VERSION}\n\n`;
      return options.write(heading).pipe(Effect.as({ ...current, opened: true }));
    };

    const renderProgress = (text: string, frame: number) =>
      options.write(
        `${CLEAR_LINE}${colors.cyan(SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "")} ${text}`,
      );

    const tick = SynchronizedRef.modifyEffect(state, (current) => {
      if (current._tag !== "Progress") return Effect.succeed(stateResult(undefined, current));
      const nextFrame = (current.frame + 1) % SPINNER_FRAMES.length;
      return renderProgress(current.text, nextFrame).pipe(
        Effect.as(stateResult(undefined, { ...current, frame: nextFrame })),
      );
    });

    const spinnerLoop = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(80);
        yield* tick;
      }
    });

    const progress = (text: string) =>
      SynchronizedRef.modifyEffect(state, (current) =>
        openState(current).pipe(
          Effect.flatMap((opened) => {
            if (opened._tag === "Closed") return Effect.succeed(stateResult(false, opened));
            if (opened._tag === "ChildOwned") {
              return options
                .write(`${colors.cyan("·")} ${text}\n`)
                .pipe(Effect.as(stateResult(false, opened)));
            }
            if (!options.capabilities.interactive) {
              if (opened._tag === "Progress" && opened.text === text) {
                return Effect.succeed(stateResult(false, opened));
              }
              return options
                .write(`${text}\n`)
                .pipe(
                  Effect.as(stateResult(false, { _tag: "Progress", opened: true, text, frame: 0 })),
                );
            }
            return renderProgress(text, opened._tag === "Progress" ? opened.frame : 0).pipe(
              Effect.as(
                stateResult(true, {
                  _tag: "Progress",
                  opened: true,
                  text,
                  frame: opened._tag === "Progress" ? opened.frame : 0,
                }),
              ),
            );
          }),
        ),
      ).pipe(
        Effect.flatMap((shouldSpin) =>
          shouldSpin
            ? FiberHandle.run(spinner, { onlyIfMissing: true })(spinnerLoop).pipe(Effect.asVoid)
            : Effect.void,
        ),
      );

    const settle = (text: string) =>
      FiberHandle.clear(spinner).pipe(
        Effect.andThen(
          SynchronizedRef.modifyEffect(state, (current) =>
            openState(current).pipe(
              Effect.flatMap((opened) => {
                if (opened._tag === "Closed") {
                  return Effect.succeed(stateResult(undefined, opened));
                }
                const prefix =
                  options.capabilities.interactive && opened._tag === "Progress" ? CLEAR_LINE : "";
                return options
                  .write(`${prefix}${ensureNewline(text)}`)
                  .pipe(Effect.as(stateResult(undefined, { _tag: "Idle", opened: true })));
              }),
            ),
          ),
        ),
      );

    const append = (text: string) =>
      SynchronizedRef.modifyEffect(state, (current) =>
        openState(current).pipe(
          Effect.flatMap((opened) => {
            if (opened._tag === "Closed") {
              return Effect.succeed(stateResult(undefined, opened));
            }
            if (options.capabilities.interactive && opened._tag === "Progress") {
              const frame = SPINNER_FRAMES[opened.frame % SPINNER_FRAMES.length];
              return options
                .write(`${CLEAR_LINE}${ensureNewline(text)}${frame} ${opened.text}`)
                .pipe(Effect.as(stateResult(undefined, opened)));
            }
            return options
              .write(ensureNewline(text))
              .pipe(Effect.as(stateResult(undefined, opened)));
          }),
        ),
      );

    const releaseToChild = FiberHandle.clear(spinner).pipe(
      Effect.andThen(
        SynchronizedRef.modifyEffect(state, (current) =>
          openState(current).pipe(
            Effect.map((opened) =>
              stateResult(
                undefined,
                opened._tag === "Closed" ? opened : { _tag: "ChildOwned" as const, opened: true },
              ),
            ),
          ),
        ),
      ),
    );

    const close = FiberHandle.clear(spinner).pipe(
      Effect.andThen(
        SynchronizedRef.modifyEffect(state, (current) => {
          if (current._tag === "Closed") {
            return Effect.succeed(stateResult(undefined, current));
          }
          const cleanup =
            options.capabilities.interactive && current._tag === "Progress"
              ? options.write(`${CLEAR_LINE}\n`)
              : Effect.void;
          return cleanup.pipe(
            Effect.as(stateResult(undefined, { _tag: "Closed", opened: current.opened })),
          );
        }),
      ),
    );

    yield* Effect.addFinalizer(() => close);

    return TerminalSurface.of({
      capabilities: options.capabilities,
      progress,
      settle,
      append,
      releaseToChild,
      close,
    });
  });
}

export function terminalCapabilities(
  env: NodeJS.ProcessEnv,
  stream: { readonly isTTY?: boolean },
): TerminalCapabilities {
  const interactive = stream.isTTY === true && env.CI === undefined && env.TERM !== "dumb";
  return {
    interactive,
    color: interactive && env.NO_COLOR === undefined,
  };
}

function ensureNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
