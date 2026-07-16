import { homedir } from "node:os";
import { join } from "node:path";

import { Context, Layer } from "effect";

export type AppPathsShape = {
  readonly configPath: string;
  readonly deployDir: string;
  readonly runtimeDir: string;
};

export class AppPaths extends Context.Service<AppPaths, AppPathsShape>()(
  "turbotunnel/effect/AppPaths",
) {
  static readonly live = Layer.sync(this, () => {
    const root = join(homedir(), ".turbotunnel");
    return this.of({
      configPath: join(root, "config.json"),
      deployDir: join(root, "relay"),
      runtimeDir: join(root, "runtime"),
    });
  });
}
