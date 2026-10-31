import type { BrowserPreview, Item, ModelOption, Project, Thread } from '../../../shared/protocol';
const now=Date.now();
export const projects:Project[]=[{id:'fieldwork',name:'fieldwork',path:'~/Projects/fieldwork',createdAt:now-86400000},{id:'tack',name:'tack',path:'~/Projects/tack',createdAt:now-86400000}];
const base={provider:'claude' as const,model:'opus',effort:'high' as const,access:'full' as const,status:'idle' as const,settled:false,createdAt:now-3600000,updatedAt:now-120000};
export const threads:Thread[]=[{...base,id:'browser-concept',projectId:'fieldwork',title:'Refine the workspace overview',context:{used:28400,window:200000}},
{...base,id:'navigation',projectId:'fieldwork',title:'Simplify the project navigation',updatedAt:now-3600000},
{...base,id:'responsive',projectId:'fieldwork',title:'Fix the mobile card layout',updatedAt:now-7200000},
{...base,id:'browser',projectId:'tack',title:'Add a browser beside the chat',updatedAt:now-8000000},
{...base,id:'composer',projectId:'tack',title:'Polish the composer',updatedAt:now-8600000}];
export const models:ModelOption[]=[{provider:'claude',value:'opus',label:'Opus',description:'Most capable',efforts:['low','medium','high','max'],group:'latest'},{provider:'codex',value:'gpt-6.1',label:'GPT-6.1',description:'Coding and everyday work',efforts:['low','medium','high','xhigh'],group:'latest'}];
export const items:Item[]=[
{id:'u1',kind:'user',text:'Give the overview a calmer feel. More breathing room, softer greens, and clearer project progress. Check it in the browser when you’re done.',ts:now-180000},
{id:'a1',kind:'assistant',text:'I’ll soften the palette, open up the spacing, and make project progress easier to scan.',ts:now-175000},
{id:'t1',kind:'tool',name:'Read',input:{file_path:'src/pages/Overview.tsx'},status:'ok',output:'Read 248 lines',ts:now-160000},
{id:'t2',kind:'tool',name:'Edit',input:{file_path:'src/pages/Overview.tsx'},status:'ok',output:'Updated',ts:now-155000},
{id:'a2',kind:'assistant',text:'The overview now has a softer sage palette and more space between sections. Each project has a quieter progress bar and a clear task count.\n\nI’m checking the layout in the browser.',ts:now-140000},
{id:'t3',kind:'tool',name:'mcp__tack__preview_open',input:{url:'http://localhost:3000'},status:'ok',output:'Opened Fieldwork — Overview',ts:now-130000},
{id:'t4',kind:'tool',name:'mcp__tack__preview_snapshot',input:{includeImage:true},status:'ok',output:'Snapshot captured',ts:now-125000},
{id:'a3',kind:'assistant',text:'The cards line up cleanly, the navigation stays readable, and the progress labels have enough contrast.\n\nThe current snapshot is open beside this chat.',ts:now-120000},
{id:'end',kind:'turn',durationMs:42000,ts:now-110000}
];
let picture='';
export async function loadPicture(){const r=await fetch('/fieldwork.png');const blob=await r.blob();picture=await new Promise<string>(resolve=>{const reader=new FileReader();reader.onload=()=>resolve(String(reader.result).split(',')[1]!);reader.readAsDataURL(blob);});}
export function initialPreview(empty=false):BrowserPreview{return empty?{tabs:[]}:{tabs:[{tabId:'app',url:'http://localhost:3000',title:'Fieldwork — Overview'},{tabId:'docs',url:'https://react.dev',title:'React documentation'}],currentTabId:'app',image:picture};}
export const getPicture=()=>picture;
