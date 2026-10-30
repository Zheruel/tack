// Compile the sidecar to a single binary where Tauri's externalBin expects it.
import { $ } from "bun";

const triple = (await $`rustc -vV`.text()).match(/host: (\S+)/)![1];
await $`bun build server/index.ts --compile --minify --outfile src-tauri/binaries/tack-server-${triple}`;
