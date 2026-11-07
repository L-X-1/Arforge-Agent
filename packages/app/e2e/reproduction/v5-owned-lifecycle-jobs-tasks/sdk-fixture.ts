import { seedTasks, seedJobs, lifecycleRoute } from "./lifecycle-data"
import { createStore } from "solid-js/store"
import { ServerConnection } from "../../../src/context/server"
import type { ServerSDK } from "../../../src/context/server-sdk"
import { createOperationsApiForServer, type OperationsApi } from "../../../src/utils/server"
import { ServerScope } from "../../../src/utils/server-scope"
type Schedule = Awaited<ReturnType<OperationsApi["scheduledPrompts"]["get"]>>
type Wait = Exclude<Awaited<ReturnType<OperationsApi["waits"]["active"]>>,null>
type Call = { id:number; source:string; sessionID:string; action:string; method:string; path:string; body:any; settled:boolean; outcome?:string }
type Outcome = "success" | "http-error" | "host-error"
type Session = { tasks:ReturnType<typeof seedTasks>; jobs:ReturnType<typeof seedJobs>; schedules:Schedule[]; triggers:Record<string,Record<string,unknown>[]>; wait?:Wait }
const [state,setState]=createStore({source:"a",sessionID:"ses_automation_a",mounted:true})
const sources=new Map<string,ReturnType<typeof makeSource>>()
const calls:Call[]=[],violations:string[]=[],nativeAttempts:string[]=[]
const pending:{call:Call;resolve:(outcome:Outcome)=>void}[]=[]
const copy=<T,>(x:T):T=>structuredClone(x)
const json=(data:unknown)=>Response.json({data})
const reject=(message:string,status=409)=>Response.json({message},{status})
function unexpected(message:string):never{violations.push(message);throw new Error(message)}
function strict<T extends object>(object:T,label:string):T{return new Proxy(object,{get(target,key,receiver){if(typeof key==="symbol"||key==="then"||key==="toJSON")return Reflect.get(target,key,receiver);if(!(key in target))unexpected("Unexpected SDK dependency "+label+"."+String(key));return Reflect.get(target,key,receiver)}})}
function seed(sessionID:string):Session{return {tasks:seedTasks(sessionID),jobs:seedJobs(sessionID),schedules:[1,2].map((n)=>({id:"sch_"+n,sessionID,name:n===1?"Morning review":"Missed review",cron:"0 9 * * *",prompt:"Review fixture "+n,recurring:false,durable:true,enabled:true,status:n===2?"missed":"scheduled",revision:1,lastError:"",time:{created:1_790_000_000_000,updated:1_790_000_000_000,expires:4_070_908_800_000}})),triggers:{local:[{id:"trg_local",name:"Local review",prompt:"Local prompt"}],remote:[{id:"trg_remote",name:"Remote review",prompt:"Remote prompt"}]},wait:{waitID:"wait_owned",sessionID,reason:"Waiting for fixture approval",durationSeconds:120,checkInInterval:5,startedAt:Date.now(),elapsedSeconds:2,remainingSeconds:118,checkInCount:0}}}
function makeSource(name:string,url:string){
 const server:ServerConnection.Http={type:"http",http:{url}},sessions=new Map<string,Session>(),hold=new Set<string>(),outcomes=new Map<string,Outcome>()
 let active=false
 const ensure=(id:string)=>{let session=sessions.get(id);if(!session){session=seed(id);sessions.set(id,session)}return session}
 const profiles:Awaited<ReturnType<OperationsApi["triggers"]["profiles"]>>={items:[{name:"local",kind:"local",baseUrl:"",timeout:30,headerNames:[]},{name:"remote",kind:"http",baseUrl:"https://fixture.invalid",timeout:30,headerNames:[]}],count:2}
 const fetcher=(async(input:RequestInfo|URL,init?:RequestInit)=>{
  const request=new Request(input,init),u=new URL(request.url),p=u.pathname,method=request.method
  if(u.origin!==new URL(url).origin)return unexpected("Wrong origin "+u.origin)
  const match=/^\/api\/session\/([^/]+)(?:\/(.*))?$/.exec(p),sessionID=match?decodeURIComponent(match[1]!):"",tail=match?.[2]??"",session=ensure(sessionID)
  const body=method==="GET"?undefined:await request.text().then(x=>x?JSON.parse(x):undefined)
  const extra = lifecycleRoute({tail,method,body,session,sessionID})
  let action="",produce:()=>Response
  if(p==="/api/session/active"&&method==="GET"){action="activity";produce=()=>json(active?{[state.sessionID]:{}}:{})}
  else if(p==="/api/trigger/profile"&&method==="GET"){action="profiles";produce=()=>json(profiles)}
  else if(p==="/api/integration"&&method==="GET"){action="integrations";produce=()=>json([{id:"int_fixture",name:"Fixture service",methods:[{type:"key"}],connections:[{type:"credential",id:"cred_job_fixture",label:"Fixture credential"}]}])}
  else if(match&&tail===""&&method==="GET"){action="identity";produce=()=>json({id:sessionID,title:name+" automation session",tags:[],projectID:"global",location:{directory:"C:/Arforge/AutomationFixture"},cost:0,tokens:{input:0,output:0,reasoning:0,cache:{read:0,write:0}},time:{created:1,updated:1}})}
  else if(extra){ action=extra.action;produce=extra.produce }
  else if(tail==="team"&&method==="GET"){action="team";produce=()=>Response.json({_tag:"TeamNotFoundError",message:"Fixture has no team"},{status:404})}
  else if(tail==="checkpoint"&&method==="GET"){action="checkpoints";produce=()=>json([])}
  else if(tail==="personal-job"&&method==="GET"){action="personal:list";produce=()=>json([])}
  else if(tail==="personal-job/dispatch"&&method==="POST"){action="personal:dispatch";produce=()=>json({recovered:0,attempted:0,completed:0,failed:0,skipped:0})}
  else if(tail==="schedule"&&method==="GET"){action="schedule:list";const snapshot=copy(session.schedules);produce=()=>json(snapshot)}
  else if(tail==="schedule"&&method==="POST"){action="schedule:create";produce=()=>{const item:Schedule={...session.schedules[0]!,...body,id:"sch_created_"+calls.length,sessionID,status:"scheduled",revision:1};session.schedules.push(item);return json(item)}}
  else if(tail.startsWith("schedule/")){
   const [,id,operation]=tail.split("/");action="schedule:"+(operation??(method==="GET"?"get":method==="PATCH"?"update":"delete"))
   const snapshot=copy(session.schedules.find(s=>s.id===id))
   produce=()=>{const index=session.schedules.findIndex(s=>s.id===id),item=session.schedules[index];if(!item)return reject("Fixture schedule missing",404);if(method==="GET")return json(snapshot);if(body?.expectedRevision!==item.revision)return reject("Fixture schedule revision conflict");if(method==="DELETE"){session.schedules.splice(index,1);return new Response(null,{status:204})}const next:Schedule={...item,...(method==="PATCH"?body:{}),revision:item.revision+1,status:operation?"running":item.status};delete (next as any).expectedRevision;session.schedules[index]=next;return json(next)}
  }else if(tail.startsWith("trigger/")){
   const [,profile,id,operation]=tail.split("/"),items=session.triggers[profile!]??[]
   const kind=profile==="local"?"local":"http",mode=operation??(method==="GET"?(id?"get":"list"):method==="POST"?"create":"update")
   action="trigger:"+mode;const snapshot=copy(id?items.find(i=>i.id===id):items)
   produce=()=>{let data:unknown=snapshot;if(mode==="get"&&!snapshot)return reject("Fixture trigger missing",404);if(mode==="create"){data={...body.body,id:"trg_created_"+calls.length};items.push(data as Record<string,unknown>)}if(mode==="update"){const i=items.findIndex(x=>x.id===id);if(i<0)return reject("Fixture trigger missing",404);items[i]={...body.body,id};data=items[i]}return json({profile,kind,action:mode,status:200,ok:true,data})}
  }else if(match&&tail==="history"&&method==="GET"){action="wait:history";produce=()=>Response.json({data:[],hasMore:false})}
  else if(match&&tail==="permission"&&method==="GET"){action="wait:permissions";produce=()=>json([])}
  else if(tail==="wait"&&method==="GET"){action="wait:active";const snapshot=copy(session.wait??null);produce=()=>json(snapshot)}
  else if(/^wait\/[^/]+\/wake$/.test(tail)&&method==="POST"){action="wait:wake";produce=()=>{if(!session.wait||tail.split("/")[1]!==session.wait.waitID)return reject("Wrong wait owner",404);const value={...session.wait,wakeRequested:true};session.wait=undefined;return json(value)}}
  else return unexpected("Unexpected automation request "+method+" "+p)
  const call:Call={id:calls.length+1,source:name,sessionID,action,method,path:p,body,settled:false};calls.push(call)
  const response=(outcome:Outcome)=>{call.settled=true;call.outcome=outcome;if(outcome==="http-error")return reject("Fixture operation rejected",method==="GET"?400:409);if(outcome==="host-error"){const profile=tail.split("/")[1];return json({profile,kind:"http",action:action.split(":")[1],status:503,ok:false,data:{message:"Fixture internal host detail"}})}return produce()}
  if(hold.has(action))return new Promise<Response>(resolve=>pending.push({call,resolve:(outcome)=>resolve(response(outcome))}))
  const outcome=outcomes.get(action)??"success";outcomes.delete(action);return response(outcome)
 }) as typeof globalThis.fetch
 const sdk=strict({server,url,scope:ServerScope.fromServerKey(ServerConnection.key(server)),operationsApi:createOperationsApiForServer({server:server.http,fetch:fetcher})},name)as unknown as ServerSDK
 return {name,server,sdk,sessions,ensure,hold,outcomes,setActive:(value:boolean)=>{active=value}}
}
sources.set("a",makeSource("a","http://automation-a.invalid"))
const active=()=>sources.get(state.source)??unexpected("Missing source")
export const mockServer={get current(){return active().server}}
export const mockGlobal={ensureServerCtx(connection:ServerConnection.Any){if(connection!==active().server)unexpected("Stale connection used current SDK");return {sdk:active().sdk}}}
export function forbidNative(action:string):never{nativeAttempts.push(action);throw new Error(action)}
export const fixture={state,
 scenario(name:string){const session=active().ensure(state.sessionID);if(name==="empty-tasks")session.tasks=[];if(name==="empty-jobs")session.jobs=[]},
 advanceTask(){const s=active().ensure(state.sessionID);s.tasks[0]={...s.tasks[0]!,revision:s.tasks[0]!.revision+1}},
 snapshot(){return copy({calls,pending:pending.map(x=>x.call),violations,nativeAttempts,state:{...state}})},
 hold(action:string){active().hold.add(action)},clearHold(action:string){active().hold.delete(action)},
 failNext(action:string,outcome:Outcome="http-error"){active().outcomes.set(action,outcome)},
 release(action:string,outcome:Outcome="success",source=state.source){const index=pending.findIndex(x=>x.call.action===action&&x.call.source===source);if(index<0)return unexpected("No pending "+action);pending.splice(index,1)[0]!.resolve(outcome)},
 advanceSchedule(){const session=active().ensure(state.sessionID);session.schedules[0]={...session.schedules[0]!,revision:5,prompt:"Latest server prompt"}},
 active(value:boolean){active().setActive(value)},
 switchSession(){setState("sessionID","ses_automation_b")},
 switchSource(sameURL=false){const name="source-"+sources.size;const url=sameURL?active().server.http.url:"http://automation-b.invalid";sources.set(name,makeSource(name,url));setState("source",name)},
 unmount(){setState("mounted",false)},
}
declare global{interface Window{__automationAcceptance:typeof fixture}}
window.__automationAcceptance=fixture
