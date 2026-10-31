// Pin the native runtime with Tack. Never run Cua's installer, updater, or agent setup scripts.
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { $ } from "bun";

const VERSION = "0.38.0";
const SHA256 = "121cf20cafd2cfa69dd720e8967350c6406b22e558be6889de7a1ae3343b6d4b";
const destination = fileURLToPath(new URL("../src-tauri/resources/cua-driver/", import.meta.url));

export async function buildDesktop() {
  if (process.platform !== "darwin") throw new Error("Tack computer use currently requires macOS.");
  if (existsSync(join(destination, "version")) && readFileSync(join(destination, "version"), "utf8").trim() === VERSION && existsSync(join(destination, "cua-driver"))) return;
  const staging = mkdtempSync(join(tmpdir(), "tack-cua-build-"));
  try {
    console.log(`Preparing Cua Driver ${VERSION}…`);
    const url = `https://github.com/trycua/cua/releases/download/cua-driver-rs-v${VERSION}/cua-driver-rs-${VERSION}-darwin-universal.tar.gz`;
    const response = await fetch(url, { signal: AbortSignal.timeout(5 * 60_000) });
    if (!response.ok) throw new Error(`Cua download failed: HTTP ${response.status}`);
    const archive = Buffer.from(await response.arrayBuffer());
    if (createHash("sha256").update(archive).digest("hex") !== SHA256) throw new Error("Cua archive checksum mismatch.");
    const tarball = join(staging, "runtime.tar.gz");
    writeFileSync(tarball, archive);
    await $`tar -xzf ${tarball} -C ${staging}`.quiet();
    const files = new Bun.Glob("**/cua-driver").scanSync({ cwd: staging, onlyFiles: true });
    const binary = [...files].find((file) => !file.includes(".app/"));
    if (!binary) throw new Error("Cua archive did not contain its native runtime.");
    mkdirSync(destination, { recursive: true });
    for (const name of ["LICENSE", "THIRD_PARTY_NOTICES.md"]) {
      const file = [...new Bun.Glob(`**/${name}`).scanSync({ cwd: staging, onlyFiles: true })][0];
      if (!file) throw new Error(`Cua archive omitted ${name}.`);
      writeFileSync(join(destination, name), readFileSync(join(staging, file)));
    }
    const target = join(destination, "cua-driver");
    copyFileSync(join(staging, binary), `${target}.new`);
    chmodSync(`${target}.new`, 0o755);
    renameSync(`${target}.new`, target);
    writeFileSync(join(destination, "version"), VERSION + "\n");
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

if (import.meta.main) await buildDesktop();
