// Node isolates agent-device's native dependencies from Tack's Bun sidecar.
export const DEVICE_WORKER = String.raw`
import { pathToFileURL } from 'node:url';
import { createInterface } from 'node:readline';
const config = JSON.parse(process.argv[2]);
const write = value => process.stdout.write(JSON.stringify(value) + '\n');
console.log = (...values) => console.error(...values);
const { createAgentDeviceClient, normalizeAgentDeviceError } = await import(pathToFileURL(config.entry).href);
const client = createAgentDeviceClient({stateDir:config.stateDir,session:config.session,daemonServerMode:'http'});
const controllers = new Map();
const running = new Set();
let closing;
let used=false;
async function bounded(work,ms) {
  let timer;
  try { await Promise.race([work,new Promise(resolve=>{timer=setTimeout(resolve,ms)})]) }
  finally { clearTimeout(timer) }
}
async function close() {
  if (closing) return closing;
  closing = (async()=>{
    for(const controller of controllers.values())controller.abort();
    await bounded(Promise.allSettled([...running]),1000);
    if(used)await bounded(client.sessions.close({shutdown:false}).catch(()=>{}),1000);
    // The Bun parent retires this worker's private daemon after the worker exits.
  })();
  return closing;
}
async function handle(message) {
  if(message.cancel!==undefined){controllers.get(message.cancel)?.abort();return}
  if(message.method==='close'){await close();write({id:message.id,result:{closed:true}});process.exit(0)}
  if(closing)return;
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
process.exit(0);
`;
