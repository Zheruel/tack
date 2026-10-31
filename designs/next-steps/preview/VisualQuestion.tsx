import { ArrowRight, ArrowUp, Check, ChevronRight, MessageCircle, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { questions } from './fixture';
import { completeAnswers, useConcept } from './state';
import { Selection } from './Selection';

const picture = new URL('../../browser-pane/preview/public/fieldwork.png', import.meta.url).href;
const choices = questions[0]!.options;
type Mode = 'focus' | 'stage' | 'inspector';

export function LayoutIllustration({ detached = false, id }: { detached?: boolean; id: string }) {
  const browser = detached ? {x:340,y:35,w:350,h:320} : {x:423,y:77,w:259,h:269};
  const chat = detached ? {x:36,y:91,w:428,h:270} : {x:36,y:45,w:648,h:302};
  const chatWidth = detached ? 270 : 252;
  return <svg className="vq-illustration" viewBox="0 0 720 400" role="img" aria-label={detached ? 'Tack chat in one window, with a separate browser window in front.' : 'Tack chat and a live browser arranged side by side in one window.'}>
    <defs><clipPath id={`${id}-page`}><rect x={browser.x+8} y={browser.y+37} width={browser.w-16} height={browser.h-45} rx="3" /></clipPath></defs>
    <rect x="7" y="7" width="706" height="386" rx="16" fill="#1b1917" />
    <rect x={chat.x+3} y={chat.y+8} width={chat.w} height={chat.h} rx="10" fill="#000" opacity=".22" />
    <rect x={chat.x} y={chat.y} width={chat.w} height={chat.h} rx="9" fill="#252220" stroke="#494137" />
    <path d={`M ${chat.x} ${chat.y+30} h ${chat.w}`} stroke="#39332d" />
    {[0,1,2].map(i=><circle key={i} cx={chat.x+14+i*10} cy={chat.y+15} r="2.8" fill="#655e54" />)}
    <text x={chat.x+58} y={chat.y+19} fill="#b0a79b" fontSize="10" fontFamily="system-ui">Tack</text>
    <rect x={chat.x+1} y={chat.y+31} width="112" height={chat.h-32} rx="5" fill="#1e1b18" />
    <text x={chat.x+14} y={chat.y+57} fill="#b0a79b" fontSize="10" fontFamily="system-ui">fieldwork</text>
    <rect x={chat.x+9} y={chat.y+68} width="95" height="32" rx="5" fill="#302a23" />
    <text x={chat.x+16} y={chat.y+87} fill="#d3c5b3" fontSize="8.5" fontFamily="system-ui">Refine the overview</text>
    {[116,134,152].map((y,i)=><rect key={y} x={chat.x+16} y={chat.y+y} width={75-i*9} height="4" rx="2" fill="#4a4238" />)}
    <text x={chat.x+129} y={chat.y+51} fill="#d6cec1" fontSize="10" fontFamily="system-ui">Refine the overview</text>
    <rect x={chat.x+154} y={chat.y+70} width={chatWidth-44} height="36" rx="8" fill="#322d27" />
    <text x={chat.x+164} y={chat.y+85} fill="#c6bcad" fontSize="8.5" fontFamily="system-ui">Give it more breathing room.</text>
    <text x={chat.x+132} y={chat.y+131} fill="#b5aa9b" fontSize="8.5" fontFamily="system-ui">I’ll check the layout in the browser.</text>
    {[150,163,176].map((y,i)=><rect key={y} x={chat.x+132} y={chat.y+y} width={chatWidth-34-i*27} height="4" rx="2" fill="#5c5245" opacity={.65-i*.12} />)}
    <rect x={chat.x+125} y={chat.y+chat.h-54} width={chatWidth-8} height="40" rx="8" fill="#29241f" stroke="#494137" />
    <text x={chat.x+137} y={chat.y+chat.h-32} fill="#8f8476" fontSize="8.5" fontFamily="system-ui">Reply</text>
    <circle cx={chat.x+chatWidth+101} cy={chat.y+chat.h-29} r="7" fill="#63533b" />
    {detached && <rect x={browser.x+4} y={browser.y+9} width={browser.w} height={browser.h} rx="10" fill="#000" opacity=".35" />}
    <rect x={browser.x} y={browser.y} width={browser.w} height={browser.h} rx="7" fill="#28241f" stroke={detached?'#8f7955':'#4e4539'} />
    <circle cx={browser.x+14} cy={browser.y+16} r="2.6" fill="#a89679" />
    <rect x={browser.x+27} y={browser.y+9} width={browser.w-54} height="15" rx="4" fill="#1d1a17" />
    <text x={browser.x+35} y={browser.y+19.5} fill="#a89b87" fontSize="7.5" fontFamily="system-ui">localhost:3000</text>
    <image href={picture} x={browser.x+8} y={browser.y+37} width={browser.w-16} height={browser.h-45} preserveAspectRatio="xMidYMin slice" clipPath={`url(#${id}-page)`} />
  </svg>;
}

export function VisualQuestion({ mode }: { mode: Mode }) {
  const [host,setHost] = useState<HTMLElement | null>(null);
  const [selected,setSelected] = useState<number | undefined>();
  const [custom,setCustom] = useState('');
  const [writing,setWriting] = useState(false);
  const [busy,setBusy] = useState(false);
  const { deferred,answers } = useConcept();
  const active = !deferred && !answers?.length;
  const panel = useRef<HTMLElement>(null);
  const ready = selected !== undefined || !!custom.trim();
  useEffect(()=>{setHost(document.querySelector(mode==='inspector'?'.thread-workspace':'.thread-chat'));},[mode]);
  useEffect(()=>{
    if (!host || !active) return;
    const chat=document.querySelector('.thread-chat')!;
    chat.classList.add(`vq-${mode}-mode`);
    const prior: {el:HTMLElement;inert:boolean}[]=[];
    if(mode!=='inspector') for(const el of Array.from(host.children)) if(el instanceof HTMLElement && !el.classList.contains('vq-layer')) {prior.push({el,inert:el.inert});el.inert=true;}
    requestAnimationFrame(()=>panel.current?.focus());
    return ()=>{chat.classList.remove(`vq-${mode}-mode`);for(const {el,inert} of prior)el.inert=inert;};
  },[host,active,mode]);
  const defer=()=>{if(busy)return;useConcept.setState({deferred:true});requestAnimationFrame(()=>document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')?.focus());};
  const send=()=>{
    if(!ready || busy)return;
    setBusy(true);
    setTimeout(()=>completeAnswers([{header:'Browser',question:questions[0]!.question,answer:custom.trim() || choices[selected!]!.label}]),220);
  };
  if(answers?.length)return null;
  if(deferred)return <div className="nx-dock"><div className="nx-waiting"><MessageCircle size={14}/><span>Browser layout is waiting</span><button onClick={()=>useConcept.setState({deferred:false})}>Answer<ChevronRight size={13}/></button></div></div>;
  if(!host)return null;
  const heading=<header className="vq-heading"><h2 id={`vq-title-${mode}`}>Where should the browser open?</h2><button className="nx-icon" disabled={busy} aria-label="Answer later" title="Answer later (Esc)" onClick={defer}><X size={15}/></button></header>;
  const own=()=>{setWriting(true);setSelected(undefined);requestAnimationFrame(()=>panel.current?.querySelector<HTMLTextAreaElement>('textarea')?.focus());};
  const footer=<footer className="vq-footer">{writing?<span/>:<button className="vq-own" disabled={busy} onClick={own}>Something else…</button>}<button className="nx-answer-action" disabled={!ready||busy} onClick={send}>{busy?'Sending…':'Use this layout'}<ArrowRight size={14}/></button></footer>;
  const form=writing && <textarea className="vq-custom" disabled={busy} aria-label="Your layout preference" placeholder="Describe the layout you have in mind…" value={custom} onChange={e=>{setCustom(e.target.value);setSelected(undefined);}} rows={2}/>;
  const choose=(i:number)=>{if(busy)return;setSelected(i);setCustom('');setWriting(false);};
  const keys=(e:React.KeyboardEvent<HTMLElement>)=>{
    if(busy || e.nativeEvent.isComposing || e.metaKey || e.ctrlKey || e.altKey)return;
    if(e.key==='Escape'){e.preventDefault();defer();return;}
    if(!(e.target instanceof HTMLTextAreaElement) && ['1','2'].includes(e.key)){e.preventDefault();choose(Number(e.key)-1);}
    if(e.key==='Enter' && !e.shiftKey && !(e.target instanceof HTMLButtonElement)){e.preventDefault();send();}
    if(mode==='focus' && e.key==='Tab'){
      const elements=Array.from(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input,textarea')??[]).filter(el=>el.getClientRects().length);
      const first=elements[0],last=elements.at(-1);
      if(e.shiftKey && (document.activeElement===first || document.activeElement===panel.current)){e.preventDefault();last?.focus();}
      else if(!e.shiftKey && document.activeElement===last){e.preventDefault();first?.focus();}
    }
  };
  const content=mode==='focus'?<>
    {heading}
    <div className="vq-card-grid" role="radiogroup" aria-label="Browser layout">{choices.map((choice,i)=><label key={choice.label} className={`vq-choice ${selected===i?'is-selected':''}`}><input type="radio" name="visual-layout" aria-label={choice.label} disabled={busy} checked={selected===i} onChange={()=>choose(i)}/><div className="vq-card-picture"><LayoutIllustration detached={i===1} id={`focus-${i}`}/></div><div className="vq-card-caption"><span className="vq-radio" aria-hidden="true">{selected===i&&<span/>}</span><span><strong>{choice.label}</strong><small>{choice.description}</small></span>{selected===i&&<Check size={14}/>}</div></label>)}</div>
    {form}{footer}
  </>:mode==='stage'?<>
    {heading}
    <div className="vq-stage-picture"><LayoutIllustration detached={selected===1} id="stage"/></div>
    <div className="vq-stage-choices" role="radiogroup" aria-label="Browser layout">{choices.map((choice,i)=><Selection key={choice.label} kind="radio" name="stage-layout" label={choice.label} description={choice.description} selected={selected===i} disabled={busy} onSelect={()=>choose(i)} shortcut={i+1}/>)}</div>
    {form}{footer}
  </>:<>
    {heading}
    <div className="vq-inspector-picture"><LayoutIllustration detached={selected===1} id="inspector"/></div>
    <div className="vq-inspector-choices" role="radiogroup" aria-label="Browser layout">{choices.map((choice,i)=><Selection key={choice.label} kind="radio" name="inspector-layout" label={choice.label} description={choice.description} selected={selected===i} disabled={busy} onSelect={()=>choose(i)} shortcut={i+1}/>)}</div>
    {form}{footer}
  </>;
  return createPortal(mode==='inspector'?<aside ref={panel} tabIndex={-1} aria-labelledby={`vq-title-${mode}`} className="vq-inspector vq-layer" onKeyDown={keys}>{content}</aside>:<div className={`vq-layer vq-${mode}-layer`}><section ref={panel} tabIndex={-1} role="dialog" aria-labelledby={`vq-title-${mode}`} className={`vq-${mode}`} onKeyDown={keys}>{content}</section></div>,host);
}
