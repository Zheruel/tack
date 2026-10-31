// Publish a signed release that running copies of Tack update to.
//   bun run release 0.2.0 ["What changed"]
// Bumps the version, builds, signs the update with ~/.tauri/tack.key, and creates a GitHub
// release whose latest.json the in-app updater reads.

import { $ } from "bun";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const REPO = "Zheruel/tack";
const [version, notes = ""] = process.argv.slice(2);
if (!version || !/^\d+\.\d+\.\d+$/.test(version)) {
  console.error("usage: bun run release <x.y.z> [notes]");
  process.exit(1);
}
const keyPath = join(homedir(), ".tauri", "tack.key");
if (!existsSync(keyPath)) {
  console.error(`missing signing key at ${keyPath}`);
  process.exit(1);
}
if ((await $`git status --porcelain`.text()).trim()) {
  console.error("commit or stash your changes first");
  process.exit(1);
}

// Bump everywhere the version lives.
const bump = (file: string, from: RegExp, to: string) => writeFileSync(file, readFileSync(file, "utf8").replace(from, to));
bump("src-tauri/tauri.conf.json", /"version": "[^"]+"/, `"version": "${version}"`);
bump("src-tauri/Cargo.toml", /^version = "[^"]+"/m, `version = "${version}"`);

await $`bun run build`.env({
  ...process.env,
  TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyPath, "utf8"),
  TAURI_SIGNING_PRIVATE_KEY_PASSWORD: "",
});

const bundle = "src-tauri/target/release/bundle";
const archive = `${bundle}/macos/Tack.app.tar.gz`;
const dmg = (await $`ls ${bundle}/dmg`.text()).split("\n").find((f) => f.endsWith(".dmg"));
const signature = readFileSync(`${archive}.sig`, "utf8").trim();
const arch = process.arch === "arm64" ? "darwin-aarch64" : "darwin-x86_64";
const manifest = "latest.json";
writeFileSync(
  join(bundle, manifest),
  JSON.stringify(
    {
      version,
      notes,
      pub_date: new Date().toISOString(),
      platforms: { [arch]: { signature, url: `https://github.com/${REPO}/releases/download/v${version}/Tack.app.tar.gz` } },
    },
    null,
    2,
  ),
);

await $`git commit -am ${`Release v${version}`}`;
await $`git push`;
const sha = (await $`git rev-parse HEAD`.text()).trim();
await $`gh release create ${`v${version}`} ${archive} ${`${archive}.sig`} ${join(bundle, manifest)} ${`${bundle}/dmg/${dmg}`} --repo ${REPO} --target ${sha} --title ${`v${version}`} --notes ${notes || `Tack ${version}`}`;
console.log(`released v${version}`);
