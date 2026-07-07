import kleur from "kleur";
import { Effect } from "effect";

export type OutputRow = {
  readonly glyph?: "✓" | "!" | "▲";
  readonly label: string;
  readonly value: string;
};

const LABEL_WIDTH = 16;

export function color(value: string, apply: (text: string) => string): string {
  if (process.env.NO_COLOR !== undefined) {
    return value;
  }

  return apply(value);
}

export function successGlyph(): string {
  return color("✓", kleur.green);
}

export function warningGlyph(): string {
  return color("!", kleur.yellow);
}

export function url(value: string): string {
  return color(value, kleur.cyan);
}

export function bold(value: string): string {
  return color(value, kleur.bold);
}

export function dim(value: string): string {
  return color(value, kleur.dim);
}

export function formatRows(rows: ReadonlyArray<OutputRow>): string {
  return rows
    .map((row) => {
      const gutter = row.glyph === undefined ? "  " : `${formatGlyph(row.glyph)} `;
      return `${gutter}${row.label.padEnd(LABEL_WIDTH)} ${row.value}`;
    })
    .join("\n");
}

export function writeHuman(text: string): Effect.Effect<void> {
  return Effect.sync(() => writeHumanSync(text));
}

export function writeHumanSync(text: string): void {
  process.stderr.write(text.endsWith("\n") ? text : `${text}\n`);
}

export function writeMachineJson(value: unknown): Effect.Effect<void> {
  return Effect.sync(() => {
    process.stdout.write(`${JSON.stringify(value)}\n`);
  });
}

export function wantsJsonOutput(argv: ReadonlyArray<string>): boolean {
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === "--format" && argv[index + 1] === "json") {
      return true;
    }

    if (value === "--format=json") {
      return true;
    }
  }

  return false;
}

function formatGlyph(glyph: "✓" | "!" | "▲"): string {
  switch (glyph) {
    case "✓":
      return successGlyph();
    case "!":
      return warningGlyph();
    case "▲":
      return color("▲", kleur.cyan);
  }
}
