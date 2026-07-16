import { TURBOTUNNEL_VERSION } from "@turbotunnel/contracts";
import { Context, Effect, FiberHandle, Layer, SynchronizedRef, type Scope } from "effect";

export type TerminalCapabilities = {
  readonly interactive: boolean;
  readonly color: boolean;
  readonly columns?: number;
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
  | { readonly _tag: "Stable"; readonly opened: boolean }
  | { readonly _tag: "Closed"; readonly opened: boolean };

export type TerminalSurfaceShape = {
  readonly capabilities: TerminalCapabilities;
  readonly open: Effect.Effect<void>;
  readonly progress: (text: string) => Effect.Effect<void>;
  readonly settle: (text: string) => Effect.Effect<void>;
  readonly append: (text: string) => Effect.Effect<void>;
  readonly releaseToChild: (stableText: string) => Effect.Effect<void>;
  readonly close: Effect.Effect<void>;
};

export type TerminalSurfaceOptions = {
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

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const CLEAR_LINE = "\r\u001B[2K";
const CLEAR_VIEWPORT = "\u001B[H\u001B[2J";

function makeTerminalSurface(
  options: TerminalSurfaceOptions,
): Effect.Effect<TerminalSurfaceShape, never, Scope.Scope> {
  return Effect.gen(function* () {
    const state = yield* SynchronizedRef.make<SurfaceState>({ _tag: "Idle", opened: false });
    const spinner = yield* FiberHandle.make<void>();

    const stateResult = (next: SurfaceState): readonly [void, SurfaceState] => [undefined, next];

    const openState = (current: SurfaceState): Effect.Effect<SurfaceState> => {
      if (current.opened) return Effect.succeed(current);
      const heading = options.capabilities.interactive
        ? `${CLEAR_VIEWPORT}  TURBOTUNNEL v${TURBOTUNNEL_VERSION}\n\n`
        : `Turbotunnel v${TURBOTUNNEL_VERSION}\n`;
      return options.write(heading).pipe(Effect.as({ ...current, opened: true }));
    };

    const renderProgress = (text: string, frame: number) =>
      options.write(`${CLEAR_LINE}${SPINNER_FRAMES[frame % SPINNER_FRAMES.length]} ${text}`);

    const tick = SynchronizedRef.modifyEffect(state, (current) => {
      if (current._tag !== "Progress") return Effect.succeed(stateResult(current));
      const nextFrame = (current.frame + 1) % SPINNER_FRAMES.length;
      return renderProgress(current.text, nextFrame).pipe(
        Effect.as(stateResult({ ...current, frame: nextFrame })),
      );
    });

    const spinnerLoop = Effect.gen(function* () {
      while (true) {
        yield* Effect.sleep(80);
        yield* tick;
      }
    });

    const open = SynchronizedRef.modifyEffect(state, (current) =>
      openState(current).pipe(Effect.map(stateResult)),
    );

    const progress = (text: string) =>
      SynchronizedRef.modifyEffect(state, (current) =>
        openState(current).pipe(
          Effect.flatMap((opened) => {
            if (opened._tag === "Closed") return Effect.succeed(stateResult(opened));
            if (opened._tag === "ChildOwned") {
              return options.write(`${text}\n`).pipe(Effect.as(stateResult(opened)));
            }
            if (!options.capabilities.interactive) {
              if (opened._tag === "Progress" && opened.text === text) {
                return Effect.succeed(stateResult(opened));
              }
              return options
                .write(`${text}\n`)
                .pipe(Effect.as(stateResult({ _tag: "Progress", opened: true, text, frame: 0 })));
            }
            return renderProgress(text, opened._tag === "Progress" ? opened.frame : 0).pipe(
              Effect.as(
                stateResult({
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
        Effect.andThen(
          options.capabilities.interactive
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
                if (opened._tag === "Closed") return Effect.succeed(stateResult(opened));
                const prefix =
                  options.capabilities.interactive && opened._tag === "Progress" ? CLEAR_LINE : "";
                return options
                  .write(`${prefix}${ensureNewline(text)}`)
                  .pipe(Effect.as(stateResult({ _tag: "Stable", opened: true })));
              }),
            ),
          ),
        ),
      );

    const append = (text: string) =>
      SynchronizedRef.modifyEffect(state, (current) =>
        openState(current).pipe(
          Effect.flatMap((opened) => {
            if (opened._tag === "Closed") return Effect.succeed(stateResult(opened));
            if (options.capabilities.interactive && opened._tag === "Progress") {
              const frame = SPINNER_FRAMES[opened.frame % SPINNER_FRAMES.length];
              return options
                .write(`${CLEAR_LINE}${ensureNewline(text)}${frame} ${opened.text}`)
                .pipe(Effect.as(stateResult(opened)));
            }
            return options.write(ensureNewline(text)).pipe(Effect.as(stateResult(opened)));
          }),
        ),
      );

    const releaseToChild = (stableText: string) =>
      FiberHandle.clear(spinner).pipe(
        Effect.andThen(
          SynchronizedRef.modifyEffect(state, (current) =>
            openState(current).pipe(
              Effect.flatMap((opened) => {
                if (opened._tag === "Closed") return Effect.succeed(stateResult(opened));
                const finishProgress =
                  options.capabilities.interactive && opened._tag === "Progress"
                    ? options.write(`${CLEAR_LINE}  ${stableText}\n`)
                    : Effect.void;
                return finishProgress.pipe(
                  Effect.as(stateResult({ _tag: "ChildOwned", opened: true })),
                );
              }),
            ),
          ),
        ),
      );

    const close = FiberHandle.clear(spinner).pipe(
      Effect.andThen(
        SynchronizedRef.modifyEffect(state, (current) => {
          if (current._tag === "Closed") return Effect.succeed(stateResult(current));
          const cleanup =
            options.capabilities.interactive && current._tag === "Progress"
              ? options.write(`${CLEAR_LINE}\n`)
              : Effect.void;
          return cleanup.pipe(Effect.as(stateResult({ _tag: "Closed", opened: current.opened })));
        }),
      ),
    );

    yield* Effect.addFinalizer(() => close);

    return TerminalSurface.of({
      capabilities: options.capabilities,
      open,
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
  stream: { readonly isTTY?: boolean; readonly columns?: number },
): TerminalCapabilities {
  const interactive = stream.isTTY === true && env.CI === undefined && env.TERM !== "dumb";
  return {
    interactive,
    color: interactive && env.NO_COLOR === undefined,
    ...(stream.columns === undefined ? {} : { columns: stream.columns }),
  };
}

function ensureNewline(text: string): string {
  return text.endsWith("\n") ? text : `${text}\n`;
}
