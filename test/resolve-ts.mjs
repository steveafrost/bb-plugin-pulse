// Lets tests import server.ts, whose relative imports are extensionless for `bb plugin build`.
import * as mod from "node:module";

if (typeof mod.registerHooks === "function") {
  mod.registerHooks({
    resolve(specifier, context, next) {
      if (/^\.\.?\//.test(specifier) && !/\.[cm]?[jt]sx?$/.test(specifier)) {
        try { return next(`${specifier}.ts`, context); } catch { /* fall through */ }
      }
      return next(specifier, context);
    },
  });
} else {
  mod.register("./resolve-ts-loader.mjs", import.meta.url);
}
