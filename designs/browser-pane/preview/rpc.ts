// Design-only transport: the actual Tack components run against disposable fixture state.
import type { Event, Method, Requests, BrowserPreview } from '../../../shared/protocol';
import { getPicture, initialPreview, items, projects, threads, models } from './fixture';
const listeners=new Set<(e:Event)=>void>();
let preview:BrowserPreview;
export function onEvent(fn:(e:Event)=>void){listeners.add(fn);return()=>void listeners.delete(fn);}
export function onConnect(_fn:()=>void){return()=>{};}
export function connect(){}
export async function call<M extends Method>(method:M,params:Requests[M]['params']):Promise<Requests[M]['result']>{
 const p=params as any;let result:any=null;
 if(method==='browser.get'||method==='browser.watch') result=preview??=initialPreview(new URLSearchParams(location.search).get('state')==='empty');
 else if(method==='browser.input') result={};
 else if(method==='browser.command'){
   preview??=initialPreview();
   if(p.input.url?.includes('error')) throw new Error('Could not reach this page. Check the address and try again.');
   await new Promise(r=>setTimeout(r,220));
   if(p.name==='preview_open'){
     let id=p.input.tabId??preview.currentTabId;
     if(!id||p.input.reuseExistingTab===false){id=crypto.randomUUID();preview={...preview,tabs:[...preview.tabs,{tabId:id,url:p.input.url??'http://localhost:3000',title:'Fieldwork — Overview'}]};}
     preview={...preview,currentTabId:id,image:getPicture()};
   } else if(p.name==='preview_close'){
     const tabs=preview.tabs.filter(t=>t.tabId!==p.input.tabId);
     preview={tabs,currentTabId:tabs[0]?.tabId,image:tabs.length?getPicture():undefined};
   } else if(p.name==='preview_navigate'){
     preview={...preview,tabs:preview.tabs.map(t=>t.tabId===preview.currentTabId?{...t,url:p.input.url,title:'Fieldwork — Overview'}:t),image:getPicture()};
   } else preview={...preview,image:getPicture()};
   listeners.forEach(fn=>fn({type:'browser',threadId:p.threadId,preview}));result=preview;
 } else if(method==='git.prs')result=[];
 else if(method==='git.branches')result={current:'main',branches:['main','design/overview']};
 else if(method==='git.info')result={branch:'main',changes:{files:2,additions:38,deletions:16},pr:null};
 else if(method==='commands.list'||method==='files.search'||method==='threads.search')result=[];
 else if(method==='thread.open')result={items,queue:[],held:false,streaming:[],approvals:[]};
 else if(method==='state.get')result={projects,threads,models,clis:[],limits:{}};
 else if(method==='chat.send')throw new Error('This concept does not send messages.');
 return result;
}
