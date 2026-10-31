// A project's favicon, found the way T3 Code does: well-known icon files, then the <link rel="icon"> in its HTML.

import { existsSync, statSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join, normalize, sep } from "node:path";

const CANDIDATES = [
  "favicon.svg",
  "favicon.ico",
  "favicon.png",
  "public/favicon.svg",
  "public/favicon.ico",
  "public/favicon.png",
  "app/favicon.ico",
  "app/icon.svg",
  "app/icon.png",
  "src/favicon.ico",
  "src/favicon.svg",
  "src/app/favicon.ico",
  "src/app/icon.svg",
  "src/app/icon.png",
  "web/public/favicon.svg",
  "web/public/favicon.ico",
  "web/public/favicon.png",
  "assets/icon.svg",
  "assets/icon.png",
  "assets/logo.svg",
  "assets/logo.png",
  "icon.svg",
  "icon.png",
  "logo.svg",
  "logo.png",
  ".idea/icon.svg",
];

const SOURCES = ["index.html", "public/index.html", "src/index.html", "web/index.html", "app/root.tsx", "src/root.tsx", "app/routes/__root.tsx", "src/routes/__root.tsx"];

// Anchored at <link so a big file isn't rescanned from every character.
const LINK_RE = /<link\b(?=[^>]*\brel=["'](?:icon|shortcut icon)["'])(?=[^>]*\bhref=["']([^"'?]+))[^>]*>/i;
const OBJECT_RE = /\brel\s*:\s*["'](?:icon|shortcut icon)["']/i;
const HREF_RE = /\bhref\s*:\s*["']([^"'?]+)/i;

const MAX_BYTES = 256 * 1024;
const TYPES: Record<string, string> = { ".svg": "image/svg+xml", ".png": "image/png", ".ico": "image/x-icon", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const HIT_TTL_MS = 10 * 60_000;
const MISS_TTL_MS = 60_000;

const cache = new Map<string, { at: number; icon: Promise<string | null> }>();

export function projectIcon(root: string): Promise<string | null> {
  const hit = cache.get(root);
  if (hit && Date.now() - hit.at < HIT_TTL_MS) return hit.icon;
  const icon = find(root).catch(() => null);
  cache.set(root, { at: Date.now(), icon });
  // A missing icon is retried sooner, in case the project grows one.
  icon.then((v) => v === null && setTimeout(() => cache.get(root)?.icon === icon && cache.delete(root), MISS_TTL_MS).unref());
  return icon;
}

async function find(root: string): Promise<string | null> {
  for (const rel of [...CANDIDATES, ...(await linked(root))]) {
    const url = await load(root, rel);
    if (url) return url;
  }
  return null;
}

// Icon paths named by the project's HTML or root route, resolved from public/ or the root.
async function linked(root: string): Promise<string[]> {
  const out: string[] = [];
  for (const source of SOURCES) {
    const file = join(root, source);
    if (!existsSync(file)) continue;
    const text = await readFile(file, "utf8").catch(() => "");
    let href = text.match(LINK_RE)?.[1];
    if (!href) for (const run of text.split("}")) if (OBJECT_RE.test(run) && (href = run.match(HREF_RE)?.[1])) break;
    if (!href || /^(https?:|data:)/.test(href)) continue;
    const clean = href.replace(/^\//, "");
    out.push(join("public", clean), clean);
  }
  return out;
}

async function load(root: string, rel: string): Promise<string | null> {
  const file = normalize(join(root, rel));
  if (!file.startsWith(root + sep)) return null; // stays inside the project
  const type = TYPES[extname(file).toLowerCase()];
  if (!type) return null;
  try {
    const stat = statSync(file);
    if (!stat.isFile() || stat.size > MAX_BYTES || stat.size === 0) return null;
    return `data:${type};base64,${(await readFile(file)).toString("base64")}`;
  } catch {
    return null;
  }
}
