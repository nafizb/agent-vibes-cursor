import esbuild from "esbuild";
import { mkdir, cp } from "node:fs/promises";

const production = process.argv.includes("--production");
const watch = process.argv.includes("--watch");

/** @type {import('esbuild').BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node18",
  outfile: "dist/extension.js",
  external: ["vscode"],
  sourcemap: !production,
  minify: production,
  logLevel: "info",
};

/** @type {import('esbuild').BuildOptions} */
const webviewConfig = {
  entryPoints: ["webview/main.ts"],
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  outfile: "dist/webview.js",
  sourcemap: !production,
  minify: production,
  // Strudel pulls these in lazily; keep the bundle resilient.
  define: { "process.env.NODE_ENV": production ? '"production"' : '"development"' },
  logLevel: "info",
};

async function copyStatic() {
  await mkdir("dist", { recursive: true });
  // Strudel ships a prebuilt IIFE that resolves its AudioWorklet relative to
  // its own <script> src, so we copy the whole dist (index.js + assets/) intact.
  await cp("node_modules/@strudel/web/dist", "dist/strudel", { recursive: true });
}

if (watch) {
  const ctxExt = await esbuild.context(extensionConfig);
  const ctxWeb = await esbuild.context(webviewConfig);
  await Promise.all([ctxExt.watch(), ctxWeb.watch()]);
  await copyStatic();
  console.log("[esbuild] watching...");
} else {
  await Promise.all([
    esbuild.build(extensionConfig),
    esbuild.build(webviewConfig),
  ]);
  await copyStatic();
  console.log("[esbuild] build complete");
}
