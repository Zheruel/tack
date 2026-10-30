// Compile the sidecar to a single binary where Tauri's externalBin expects it.
import { $ } from "bun";

const triple = process.arch === "arm64" ? "aarch64-apple-darwin" : "x86_64-apple-darwin";
await $`bun build server/index.ts --compile --minify --outfile src-tauri/binaries/tack-server-${triple}`;
