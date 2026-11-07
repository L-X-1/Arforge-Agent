import { render } from "solid-js/web"
import { Show } from "solid-js"
import { createStore } from "solid-js/store"
import { applyTheme, arforgeDefaultTheme } from "@arforge-ai/ui/theme"
import { LanguageProvider } from "../../../src/context/language"
import { PlatformProvider } from "../../../src/context/platform"
import { SessionWaitSourcesPanel } from "../../../src/components/session/session-wait-sources-panel"
import { createOperationsApiForServer } from "../../../src/utils/server"
import "../../../src/index.css"

applyTheme(arforgeDefaultTheme, "arforge-default")
const [state,setState]=createStore({source:"a",directory:"C:/owned",sessionID:"ses_parent",mounted:true,scenario:"approval",hold:""})
const calls: {source:string;path:string;sessionID:string}[]=[], violations:string[]=[], pending:{source:string;release:()=>void}[]=[]
function source(name:string) {
  const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
    const req=new Request(input,init),url=new URL(req.url),directory=state.directory,scenario=state.scenario
    const sessionID=/\/session\/([^/]+)/.exec(url.pathname)?.[1]??state.sessionID
    calls.push({source:name,path:url.pathname,sessionID})
    if(req.method!=="GET") {violations.push(req.method+" "+url.pathname);throw Error("Read-only sources issued a write")}
    const assistantMessageID="msg_"+name,callID="call_"+name,parentRunID="run_"+name,childRunID="run_child_"+name,childSessionID="ses_child_"+name
    const base=(seq:number)=>({id:"evt_"+seq,durable:{aggregateID:sessionID,seq,version:1},location:{directory}})
    const event=(seq:number,type:string,data:Record<string,unknown>)=>({...base(seq),type,data:{sessionID,timestamp:seq,assistantMessageID,...data}})
    let response:Response
    if(url.pathname.endsWith("/history")) {
      const events=[event(1,"session.next.step.started",{runID:parentRunID,agent:"build",model:{id:"owned",providerID:"local"}}),event(2,"session.next.tool.called",{callID,tool:"task",input:scenario==="background"?{background:true}:{},provider:{executed:false}})]
      if(scenario!=="approval") events.push(event(3,"session.next.tool.progress",{callID,content:[],structured:{parentSessionId:sessionID,sessionId:childSessionID,durableRunID:childRunID}}))
      if(scenario==="settled")events.push(event(4,"session.next.tool.success",{callID,content:[],structured:{},provider:{executed:false}}))
      const after=Number(url.searchParams.get("after")??0)
      // Always paginate, including a later terminal event. The UI must not stop on page1.
      response=Response.json({data:after===0?events.slice(0,2):events.slice(2),hasMore:after===0&&events.length>2})
    } else if(url.pathname.endsWith("/permission"))response=Response.json({data:scenario==="approval"?[{id:"per_"+name,sessionID,action:"task",resources:["explore"],source:{type:"tool",messageID:assistantMessageID,callID}}]:[]})
    else if(url.pathname.endsWith("/children"))response=Response.json({parentRunID,children:[{childRunID,sessionID:childSessionID,status:scenario==="missing"?"completed":"running",resultReceiptStatus:scenario==="missing"?"missing":"pending",depth:1,objectiveDigest:"a".repeat(64)}]})
    else {violations.push(url.pathname);throw Error("Unexpected source request "+url.pathname)}
    if(state.hold&&url.pathname.endsWith("/"+state.hold))await new Promise<void>(release=>pending.push({source:name,release}))
    return response
  }) as typeof fetch
  return createOperationsApiForServer({server:{url:"http://wait-"+name+".invalid"},fetch:fetcher})
}
const sources=new Map([["a",source("a")]])
const fixture={state,calls,violations,pending,
  scenario(value:string){setState("scenario",value)},hold(value:string){setState("hold",value)},
  release(){setState("hold","");pending.splice(0).forEach(p=>p.release())},
  switchSource(){const name="source"+sources.size;sources.set(name,source(name));setState("source",name)},
  switchSession(){setState("sessionID","ses_new")},switchDirectory(){setState("directory","C:/new-directory")},unmount(){setState("mounted",false)}}
declare global {interface Window {__waitSources:typeof fixture}}
window.__waitSources=fixture
const forbidden=()=>{violations.push("native action");throw Error("Native actions unavailable in owned headless fixture")}
render(()=><PlatformProvider value={{platform:"web",openLink:forbidden,restart:async()=>forbidden(),back:forbidden,forward:forbidden,notify:async()=>forbidden()}}><LanguageProvider locale="en"><main class="p-6 max-w-3xl"><Show when={state.mounted}><SessionWaitSourcesPanel api={sources.get(state.source)!} sessionID={state.sessionID} location={{directory:state.directory}} /></Show></main></LanguageProvider></PlatformProvider>,document.getElementById("root")!)
