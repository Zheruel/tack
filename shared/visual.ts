// One document and theme for the inline surface and the agent's headless preview.
export const VISUAL_MAX_HEIGHT = 20_000;
export const VISUAL_MAX_HTML = 512_000;

export interface VisualReference {
  id: string;
  title: string;
  height?: number;
}

export const VISUAL_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";

export const VISUAL_CSS = `
:root{color-scheme:dark;--ink:#efe9e0;--dim:#b0a79b;--faint:#8f877d;--line:#35302b;--raised:#252220;--accent:#c9a35b;--ok:#8fb38a;--danger:#e0796b;
--background:#1c1a18;--foreground:var(--ink);--muted:var(--raised);--muted-foreground:var(--dim);--card:var(--raised);--card-foreground:var(--ink);--border:var(--line);--primary:var(--accent);--primary-foreground:var(--background);--ring:var(--accent);
--font:-apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;--mono:"JetBrains Mono",ui-monospace,Menlo,monospace;
--series-1:#c9a35b;--series-2:#80b9b3;--series-3:#a99ac8;--series-4:#dc9778;--series-5:#8fb38a;--series-6:#8eafd1;
font:14px/1.55 var(--font);color:var(--ink);background:transparent;font-synthesis:none;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}html,body{margin:0;padding:0}body{display:flow-root;overflow-wrap:break-word}body>*{max-width:100%}
svg,canvas,img{max-width:100%}img{height:auto}svg{vertical-align:middle}button,input,select,textarea{font:inherit;color:inherit}
button,select,input[type=range],input[type=checkbox]{cursor:pointer}button{border:1px solid var(--line);border-radius:8px;background:var(--raised);padding:6px 11px;transition:background .15s,border-color .15s}button:hover{border-color:var(--accent)}button:disabled{opacity:.45;cursor:default}
input:not([type=range]):not([type=checkbox]):not([type=radio]),select,textarea{max-width:100%;background:var(--background);border:1px solid var(--line);border-radius:8px;padding:6px 9px}input[type=range],input[type=checkbox],input[type=radio]{accent-color:var(--accent)}
:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button[aria-pressed=true],button[aria-selected=true]{border-color:var(--accent);background:color-mix(in srgb,var(--accent) 13%,transparent)}
h1,h2,h3,p{margin:0}h1{font-size:22px;line-height:1.25;font-weight:500;letter-spacing:-.035em}h2{font-size:16px;line-height:1.4;font-weight:500;letter-spacing:-.015em}h3{font-size:14px;font-weight:500}small{font-size:12px;color:var(--dim)}a{color:var(--accent)}code,pre{font-family:var(--mono)}table{border-collapse:collapse;width:100%;font-variant-numeric:tabular-nums}td,th{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}th{font-size:12px;font-weight:500;color:var(--dim)}
.viz-stack{display:grid;gap:20px}.viz-row{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.viz-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,220px),1fr));gap:20px}.viz-muted{color:var(--dim)}.viz-value{font-size:32px;line-height:1.1;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.viz-label{font-size:12px;color:var(--dim)}.viz-panel{padding:18px;border-radius:12px;background:var(--raised)}
@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important;scroll-behavior:auto!important}}
`;

// This is a sandbox bridge, not app IPC. Only the owning iframe may report its size or errors.
function bootstrap(channel: string) {
  return `(()=>{const channel=${JSON.stringify(channel).replaceAll("<", "\\u003c")};
const send=(type,data)=>parent.postMessage({tackVisual:channel,type,...data},"*");
let previous=0,frame=0;const measure=()=>{cancelAnimationFrame(frame);frame=requestAnimationFrame(()=>{const b=document.body;if(!b)return;const height=Math.ceil(Math.max(b.getBoundingClientRect().height,b.scrollHeight));if(height!==previous){previous=height;send("size",{height})}})};
addEventListener("error",e=>send("error",{message:String(e.message||"A resource could not load").slice(0,500)}));
addEventListener("unhandledrejection",e=>send("error",{message:String(e.reason?.message||e.reason||"A script failed").slice(0,500)}));
addEventListener("message",e=>{if(e.source!==parent||e.data?.tackVisual!==channel||e.data.type!=="theme")return;for(const [name,value] of Object.entries(e.data.variables||{})){if(/^--[a-z0-9-]+$/.test(name)&&typeof value==="string")document.documentElement.style.setProperty(name,value)}measure()});
document.addEventListener("click",e=>{const link=e.target.closest?.("a[href]");if(link&&!link.getAttribute("href").startsWith("#"))e.preventDefault()},true);
document.addEventListener("submit",e=>e.preventDefault(),true);window.open=()=>null;
const ready=()=>{new ResizeObserver(measure).observe(document.body);new MutationObserver(measure).observe(document.body,{childList:true,subtree:true,characterData:true});document.fonts?.ready.then(measure);measure();send("ready",{})};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready,{once:true});else ready();addEventListener("load",measure);addEventListener("resize",measure);
})();`;
}

export function visualDocument(html: string, channel: string): string {
  const head = `<meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${VISUAL_CSP}"><style>${VISUAL_CSS}</style><script>${bootstrap(channel)}</script>`;
  // Put policy before any generated markup, including malformed full documents.
  // HTML parsing tolerates nested document wrappers; inserting into an untrusted
  // head could otherwise leave scripts or resource requests ahead of the policy.
  return `<!doctype html><html><head>${head}</head><body>${html}</body></html>`;
}

export function visualReference(output?: string): VisualReference | undefined {
  try {
    const value = JSON.parse(output ?? "").visual;
    if (typeof value?.id !== "string" || typeof value.title !== "string") return undefined;
    return { id: value.id, title: value.title, ...(typeof value.height === "number" && { height: value.height }) };
  } catch {
    return undefined;
  }
}
