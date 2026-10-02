// esbuild bundle script for x1-confidential UI
import * as esbuild from "esbuild";
import { copyFileSync } from "fs";

const now = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 12);

// Bundle app.js -> app.bundle.js (single file, minified, with source map)
await esbuild.build({
  entryPoints: ["./public/app.js"],
  bundle: true,
  outfile: "./public/app.bundle.js",
  format: "esm",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  sourcemap: false,
  define: {
    "process.env.NODE_ENV": '"production"',
  },
  external: [], // bundle everything inline
  loader: {
    ".wasm": "binary",
  },
  banner: {
    js: `// X1 Confidential UI bundle — ${now} — client-side ZK batching (3 sigs)`,
  },
});

console.log("Bundle OK: public/app.bundle.js");

// Update index.html cache-buster
import { readFileSync, writeFileSync } from "fs";
const idx = readFileSync("./public/index.html", "utf8");
const updated = idx.replace(
  /app\.bundle\.js\?v=[^"]+/,
  `app.bundle.js?v=batch-${now}`
);
writeFileSync("./public/index.html", updated);
console.log("Cache-buster updated: batch-" + now);
