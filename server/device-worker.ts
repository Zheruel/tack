// Node isolates agent-device's native dependencies from Tack's Bun sidecar.
export const DEVICE_WORKER = String.raw`
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
const config = JSON.parse(process.argv[2]);
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
console.log = (...values) => console.error(...values);
const { createAgentDeviceClient, normalizeAgentDeviceError } = await import(pathToFileURL(config.entry).href);
const client = createAgentDeviceClient({stateDir:config.stateDir,session:config.session,daemonServerMode:'http'});
const controllers = new Map();
const running = new Set();
let closing;
let used=false;
async function close() {
  if (closing) return closing;
  closing = (async()=>{
    for(const controller of controllers.values())controller.abort();
    await Promise.allSettled([...running]);
    if(used)await Promise.race([client.sessions.close({shutdown:false}).catch(()=>{}),new Promise(r=>setTimeout(r,5000))]);
    await new Promise(resolve=>{
      const child=spawn(process.execPath,[config.cli,'daemon','stop','--state-dir',config.stateDir],{env:{...process.env,AGENT_DEVICE_NO_UPDATE_NOTIFIER:'1'},stdio:'ignore'});
      const timer=setTimeout(()=>{child.kill('SIGKILL');resolve()},5000);
      child.on('error',()=>{clearTimeout(timer);resolve()});child.on('exit',()=>{clearTimeout(timer);resolve()});
    });
  })();
  return closing;
}
async function handle(message) {
  if(message.cancel!==undefined){controllers.get(message.cancel)?.abort();return}
  if(message.method==='close'){await close();write({id:message.id,result:{closed:true}});process.exit(0)}
  const controller = new AbortController();controllers.set(message.id,controller);
  used=true;
  const options={...message.input,...config.target,signal:controller.signal};
  try {
    let result;
    switch(message.method){
      case 'openApp':result=await client.apps.open({...options,noRecord:true});break;
      case 'snapshot':result=await client.capture.snapshot({...options,interactiveOnly:true});break;
      case 'fill':result=await client.interactions.fill({...options,verify:true,settle:true,timeoutMs:3000});break;
      case 'type':result=await client.interactions.type(options);break;
      default:throw Error('Unknown device operation');
    }
    write({id:message.id,result});
  } catch(error) { write({id:message.id,error:normalizeAgentDeviceError(error)}) }
  finally {controllers.delete(message.id)}
}
write({ready:true});
for await(const line of createInterface({input:process.stdin,crlfDelay:Infinity})){
  let message;try{message=JSON.parse(line)}catch{continue}
  if(message.method==='close'){void handle(message);continue}
  const job=handle(message);running.add(job);job.finally(()=>running.delete(job));
}
await close();
`;
