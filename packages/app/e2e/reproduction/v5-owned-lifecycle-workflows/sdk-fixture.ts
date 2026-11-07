import { createStore } from "solid-js/store"
import { Schema } from "effect"
import { AgentCapability } from "@arforge-ai/schema/agent-capability"
import { AgentRuntime } from "@arforge-ai/schema/agent-runtime"
import { Permission } from "@arforge-ai/schema/permission"
import { InvalidRequestError } from "../../../../protocol/src/errors"
import type { PluginTransaction, PluginRemoval, PluginRestore } from "@arforge-ai/core/analysis/plugins"
import { createOperationsApiForServer, type OperationsApi } from "../../../src/utils/server"
import { ServerConnection } from "../../../src/context/server"
import { ServerScope } from "../../../src/utils/server-scope"
import type { ServerSDK } from "../../../src/context/server-sdk"
import type { useGlobal as ProductionUseGlobal } from "../../../src/context/global"
import type { useServer as ProductionUseServer } from "../../../src/context/server"

type Caps = OperationsApi["agentCapabilities"]
type LocationInfo = Awaited<ReturnType<OperationsApi["location"]["get"]>>
type Workflow = Awaited<ReturnType<Caps["workflowList"]>>["data"]["items"][number]
type Mutable<T> = T extends readonly (infer I)[] ? Mutable<I>[] : T extends object ? {-readonly [K in keyof T]:Mutable<T[K]>}:T
type Run = Mutable<Awaited<ReturnType<Caps["workflowRunGet"]>>["data"]>
type Skill = Awaited<ReturnType<Caps["skillList"]>>["data"]["items"][number]
type Plugin = Awaited<ReturnType<Caps["pluginList"]>>["data"]["items"][number]
export type Mode = "session" | "different-server" | "same-url-instance" | "location-refresh"
export type Call = { id:number; source:string; action:string; method:string; path:string;
  query:Record<string,string>; body:Record<string,unknown>; directory:string; workspace:string;
  sessionID:string; settled:boolean; responseStatus?:number; responseData?:unknown }
type Data = { workflows:Workflow[]; runs:Run[]; skills:Skill[]; plugins:Plugin[] }
type JsonValue = Awaited<ReturnType<Caps["pluginApply"]>>["data"]["transaction"]
type Inspection = { source:string; directory:string; candidates:Awaited<ReturnType<Caps["pluginInspect"]>>["data"]["candidates"] }
type Recovery = { plugin:Plugin; reason:"update"|"remove"|"rollback"; metadata:Record<string,unknown> }
type Source = { name:string; server:ServerConnection.Http; sdk:ServerSDK; datasets:Map<string,Data>; inspections:Map<string,Inspection>; recoveries:Map<string,Recovery> }
export type Outcome = "ok"|"error"|"approve"|"reject"|"read-only"
export type ControlReceipt = { request:AgentRuntime.ControlRequest; reply:Permission.Reply; operationRequestID:string; callID:number; responseStatus:number; scopeSessionID:string }
type Pending = { call:Call; success:()=>Response; resolve:(response:Response)=>void }
export type Probe = { labels:Record<string,string> }

const origin=location.origin
const scenario=new URL(location.href).searchParams.get("scenario") ?? "baseline"
const calls:Call[]=[], violations:string[]=[], nativeAttempts:string[]=[]
const pending=new Map<number,Pending>(), holds:{action:string;source:string;sessionID?:string}[]=[]
const sources=new Map<string,Source>()
const approvals:{requestID:string;callID:number;decision:string;source:string;directory:string}[]=[]
const controlReceipts:ControlReceipt[]=[], controlRequests=new Map<number,AgentRuntime.ControlRequest>()
const transactionActions=["pluginApply","pluginRemove","pluginRestore"]
let probe:(()=>Probe)|undefined, rejectReads=new Set<string>()
export const [control,setControl]=createStore({source:"a",sessionID:"ses_extension_a",locationVersion:"a",mounted:true,tab:"arforge-extensions"})
const clone=<T,>(value:T):T=>JSON.parse(JSON.stringify(value)) as T
function unexpected(message:string):never {violations.push(message);throw new Error(message)}
function strict<T extends object>(value:T,label:string):T {return new Proxy(value,{get(target,key,receiver){
  if(typeof key==="symbol"||key==="then"||key==="toJSON")return Reflect.get(target,key,receiver)
  if(!(key in target))return unexpected("Unexpected extension dependency: "+label+"."+String(key))
  return Reflect.get(target,key,receiver)
}})}
const wireJSON=(value:unknown):JsonValue=>JSON.parse(JSON.stringify(value)) as JsonValue
const json=(data:unknown,status=200)=>new Response(JSON.stringify(data),{status,headers:{"content-type":"application/json"}})
const failed=(message="Fixture extension request rejected",status=400)=>json({_tag:status===401?"UnauthorizedError":"InvalidRequestError",message},status)
export function infoFor(source=control.source,version=control.locationVersion):LocationInfo {
 const directory="C:/Arforge/ExtensionAcceptance/"+source+"/workspace-"+version
 return {directory,workspaceID:"wrk_ext_"+source+"_"+version,project:{id:"prj_ext_"+source,directory}}
}
function workflow(info:LocationInfo):Workflow{return {path:info.directory+"/.arforge/workflows/review.json",valid:true,name:"Fixture review "+info.workspaceID,
 description:"Memory-only workflow definition",schema_version:1,nodes:1,edges:0,has_approval:false}}
function runFor(source:string,info:LocationInfo,sessionID:string,extra:Partial<Run>={}):Run{
 const date=new Date().toISOString()
 return {schema_version:1,run_id:"run_"+source+"_"+info.workspaceID+"_"+sessionID,session_id:sessionID,
 name:"Run "+source+"/"+info.workspaceID+"/"+sessionID,description:"Controlled API snapshot, no Core execution",
 source_path:workflow(info).path,workspace:info.directory,permission_mode:"acceptEdits",status:"running",max_parallel:4,
 created_at:date,updated_at:date,started_at:date,finished_at:null,last_error:"",
 progress:{settled:0,total:1,percent:0,by_status:{pending:1}},
 nodes:[{node_id:"fixture-step",title:"Review fixture data",kind:"agent",access:"read",status:"pending",attempt:0,max_attempts:1,
 depends_on:[],continue_on_error:false,condition:null,output:"",error:"",started_at:null,finished_at:null}],...extra}
}
function skill(info:LocationInfo):Skill{return {id:"fixture-skill",name:"Fixture skill",description:"Synthetic local skill",version:"1.0.0",
 source:"project",path:info.directory+"/.arforge/skills/fixture",entrypoint:"SKILL.md",license:"MIT",tags:[],enabled:true,problems:[]}}
function plugin(info:LocationInfo):Plugin{return {name:"fixture-plugin",version:"1.0.0",description:"Synthetic managed plugin",
 hooks:[],tools:[],manifest_path:info.directory+"/.arforge/plugins/fixture/manifest.json",entrypoint:"plugin.js",
 source:"workspace",sha256:"a".repeat(64),permissions:[],egress:[],secrets:[],compatibility:{api_version:1,platforms:["win32"]},
 signature:{status:"verified",signed_digest:"a".repeat(64)},security:{status:"passed",findings:[],scanned_files:1,scanned_bytes:64},
 enabled:true,problems:[],managed:true}}
function dataFor(source:Source,info:LocationInfo):Data{
 const existing=source.datasets.get(info.directory);if(existing)return existing
 const empty=scenario==="empty"
 const makeRun=(sessionID:string)=>{const run=runFor(source.name,info,sessionID);if(scenario==="node-transactions"){
  const base=run.nodes[0]!
  run.status="paused";run.nodes=[
   {...base,node_id:"approval-gate",title:"Frozen approval gate",kind:"approval",status:"waiting_approval"},
   {...base,node_id:"failed-branch",title:"Failed branch",status:"failed",attempt:1,max_attempts:2,error:"Synthetic node failure"},
   {...base,node_id:"branch-child",title:"Blocked descendant",status:"blocked",depends_on:["failed-branch"],error:"Upstream failed"},
  ];run.progress={settled:1,total:3,percent:100/3,by_status:{waiting_approval:1,failed:1,blocked:1}}
 };if(scenario==="completed") { run.status="completed";run.finished_at=new Date().toISOString();run.progress={settled:1,total:1,percent:100,by_status:{completed:1}};run.nodes=run.nodes.map(node=>({...node,status:"completed",attempt:1,output:"Isolated completed node receipt",finished_at:run.finished_at})) };return run}
 const data:Data={workflows:empty?[]:[workflow(info)],runs:empty?[]:[
 makeRun("ses_extension_a"),makeRun("ses_extension_b")],
 skills:empty?[]:[skill(info)],plugins:empty?[]:[plugin(info)]}
 source.datasets.set(info.directory,data);return data
}
async function answer(call:Call,response:Response){call.settled=true;call.responseStatus=response.status;call.responseData=await response.clone().json();return response}
function holdFor(call:Call){const i=holds.findIndex(h=>h.action===call.action&&h.source===call.source&&(!h.sessionID||h.sessionID===call.sessionID))
 if(i<0)return false;holds.splice(i,1);return true}
const childReads=["workflowList","workflowRunList","skillList","nativeSkills","pluginList"]
async function transport(source:Source,raw:RequestInfo|URL,init?:RequestInit):Promise<Response>{
 const url=new URL(raw instanceof Request?raw.url:String(raw))
 const method=init?.method??(raw instanceof Request?raw.method:"GET")
 const headers=new Headers(init?.headers??(raw instanceof Request?raw.headers:undefined))
 if(url.origin!==origin||url.username||url.password||headers.has("authorization")||headers.has("cookie"))
  return unexpected("Unexpected extension transport origin or credentials")
 const query=Object.fromEntries(url.searchParams),body=typeof init?.body==="string"?JSON.parse(init.body) as Record<string,unknown>:{}
 const path=url.pathname
 let action=path==="/api/location"&&method==="GET"?"location.get":
 path==="/api/agent-capabilities/workflows"&&method==="GET"?"workflowList":
 path==="/api/agent-capabilities/workflow-runs"&&method==="GET"?"workflowRunList":
 path==="/api/agent-capabilities/skills"&&method==="GET"?"skillList":
 path==="/api/skill"&&method==="GET"?"nativeSkills":
 path==="/api/agent-capabilities/plugins"&&method==="GET"?"pluginList":
 path==="/api/agent-capabilities/customizations"&&method==="GET"?"customizationList":
 path==="/api/agent-capabilities/skill-lifecycle/candidates"&&method==="GET"?"skillLifecycleCandidateList":
 path==="/api/agent-capabilities/experience/sources"&&method==="GET"?"experienceSourceList":
 path==="/api/agent-capabilities/workflows/preview"&&method==="POST"?"workflowPreview":
 path==="/api/agent-capabilities/workflow-runs/start"&&method==="POST"?"workflowStart":
 /^\/api\/agent-capabilities\/workflow-runs\/[^/]+\/control$/.test(path)&&method==="POST"?"workflowControl":
 /^\/api\/agent-capabilities\/workflow-runs\/[^/]+$/.test(path)&&method==="GET"?"workflowRunGet":
 path==="/api/agent-capabilities/skills/fixture-skill/enabled"&&method==="POST"?"skillSetEnabled":
 path==="/api/agent-capabilities/skills/refresh"&&method==="POST"?"skillRefresh":
 path==="/api/agent-capabilities/plugins/fixture-plugin/enabled"&&method==="POST"?"pluginSetEnabled":
 path==="/api/agent-capabilities/plugins/install/inspect"&&method==="POST"?"pluginInspect":
 path==="/api/agent-capabilities/plugins/install/apply"&&method==="POST"?"pluginApply":
 /^\/api\/agent-capabilities\/plugins\/[^/]+\/remove$/.test(path)&&method==="POST"?"pluginRemove":
 path==="/api/agent-capabilities/plugins/restore"&&method==="POST"?"pluginRestore":
 /^\/api\/agent-capabilities\/workflow-runs\/[^/]+\/approve$/.test(path)&&method==="POST"?"workflowApprove":
 /^\/api\/agent-capabilities\/workflow-runs\/[^/]+\/retry$/.test(path)&&method==="POST"?"workflowRetry":""
 if(!action)return unexpected("Forbidden/unimplemented extension API: "+method+" "+path)
 const currentInfo=infoFor(source.name)
 const directory=action==="location.get"?currentInfo.directory:query["location[directory]"]??""
 const workspace=action==="location.get"?currentInfo.workspaceID??"":query["location[workspace]"]??""
 if(action!=="location.get"&&(!directory.startsWith("C:/Arforge/ExtensionAcceptance/"+source.name+"/")||!workspace))
  return unexpected("Missing or cross-source extension location")
 const info:LocationInfo=action==="location.get"?currentInfo:{directory,workspaceID:workspace,project:{id:"prj_ext_"+source.name,directory}}
 const sessionID=query.sessionID??(typeof body.sessionID==="string"?body.sessionID:"")
 if(action==="workflowRunList"&&(!["ses_extension_a","ses_extension_b"].includes(sessionID)||query.limit!=="50"))
  return unexpected("Workflow run list lost current session/limit")
 const call:Call={id:calls.length+1,source:source.name,action,method,path,query,body,directory,workspace,sessionID,settled:false};calls.push(call)
 const data=dataFor(source,info),captured=clone(data)
 const wrapped=(data:unknown)=>json({location:info,data})
 const skillsPage=(skills:Skill[]):Awaited<ReturnType<Caps["skillList"]>>["data"]=>({count:skills.length,enabled_count:skills.filter(s=>s.enabled).length,items:skills,roots:[info.directory+"/.arforge/skills"]})
 const pluginsPage=(plugins:Plugin[]):Awaited<ReturnType<Caps["pluginList"]>>["data"]=>({count:plugins.length,items:plugins,roots:[info.directory+"/.arforge/plugins"]})
 const apiError=(kind:string,message:string)=>json(new InvalidRequestError({kind,message}),400)
 const pluginName=action==="pluginRemove"?decodeURIComponent(path.split("/")[4]??""):String(body.name??"")
 const operation=action==="pluginApply"?(body.replace?"plugin.update":"plugin.install"):action==="pluginRemove"?"plugin.uninstall":action==="pluginRestore"?"plugin.rollback":""
 if(transactionActions.includes(action)){
  if(typeof body.requestID!=="string"||!/^cpr_[0-9a-f-]{36}$/.test(body.requestID))return unexpected("Plugin transaction lost generated request identity")
  const resources=["filesystem:"+directory+"/.arforge/plugins",action==="pluginRestore"?"recovery:"+body.recoveryID:"plugin:"+pluginName]
  const request=Schema.decodeUnknownSync(AgentRuntime.ControlRequest)({id:"per_fixture_"+call.id,
   subject:{type:"control-plane",id:"ctl_fixture_"+source.name,location:directory,project:info.project.id,
    actor:"user",principalRef:"prn_fixture_"+source.name,requestID:body.requestID},action:operation,resources,metadata:{domain:"plugin-center",version:1}})
  controlRequests.set(call.id,request)
 }
 const recoveryFor=(item:Plugin,reason:Recovery["reason"])=>{
  const recoveryID=item.name+"-20261028T120000-"+call.id.toString(16).padStart(8,"0")
  const metadata={recovery_id:recoveryID,name:item.name,reason,removed_at:new Date().toISOString(),path:directory+"/.arforge/plugin-trash/"+recoveryID}
  source.recoveries.set(recoveryID,{plugin:clone(item),reason,metadata});return metadata
 }
 const updateRun=(runID:string,mutate:(run:Run)=>Run|Response)=>{
  const run=data.runs.find(r=>r.run_id===runID);if(!run)return apiError("agent-management-run-not-found","Fixture workflow run was not found")
  const changed=mutate(clone(run));if(changed instanceof Response)return changed
  Schema.decodeUnknownSync(AgentCapability.WorkflowRun)(changed)
  data.runs=data.runs.map(r=>r.run_id===runID?changed:r);return wrapped(changed)
 }
 const success=():Response=>{
  if(rejectReads.has(action))return failed("Fixture "+action+" read rejected")
  if(action==="location.get")return json(info)
  if(action==="workflowList"){const page:Awaited<ReturnType<Caps["workflowList"]>>["data"]={schema_version:1,items:captured.workflows,count:captured.workflows.length};return wrapped(page)}
  if(action==="workflowRunList"){const items=captured.runs.filter(r=>r.session_id===sessionID);const page:Awaited<ReturnType<Caps["workflowRunList"]>>["data"]={schema_version:1,items,count:items.length};return wrapped(page)}
  if(action==="skillList"||action==="skillRefresh")return wrapped(skillsPage(captured.skills))
  if(action==="nativeSkills"){const data:Awaited<ReturnType<OperationsApi["skills"]["list"]>>["data"]=scenario==="empty"?[]:[{name:"Fixture runtime skill",location:info.directory+"/.arforge/skills/fixture",content:"Synthetic skill",description:"Memory-only runtime projection"}];return wrapped(data)}
  if(action==="pluginList")return wrapped(pluginsPage(captured.plugins))
  if(action==="customizationList"){const data:Awaited<ReturnType<Caps["customizationList"]>>["data"]={commands:{count:0,enabled_count:0,items:[]},hooks:{count:0,enabled_count:0,items:[]},roots:[]};return wrapped(data)}
  if(action==="skillLifecycleCandidateList"){const data:Awaited<ReturnType<Caps["skillLifecycleCandidateList"]>>["data"]={schema_version:1,count:0,items:[]};return wrapped(data)}
  if(action==="experienceSourceList"){const data:Awaited<ReturnType<Caps["experienceSourceList"]>>["data"]={schema_version:1,count:0,items:[]};return wrapped(data)}
  if(action==="workflowPreview"){const result:Awaited<ReturnType<Caps["workflowPreview"]>>["data"]={schema_version:1,name:"Preview "+info.workspaceID,source_path:String(body.path),success:true,dry_run:true,
   steps:[{id:"fixture-step",title:"Read-only preview step",status:"planned",output:"Fixture preview only",error:"",access:"read",depends_on:[],max_attempts:1}],edges:[],node_kinds:{"fixture-step":"agent"}};return wrapped(result)}
  if(action==="workflowStart"){const run=runFor(source.name,info,sessionID,{run_id:"started_"+source.name+"_"+workspace+"_"+sessionID+"_"+call.id,name:"Started "+source.name+"/"+workspace+"/"+sessionID,
    permission_mode:String(body.permissionMode),max_parallel:Number(body.maxParallel)});data.runs.push(run);return wrapped(run)}
  if(action==="workflowApprove"||action==="workflowRetry"){
   const runID=decodeURIComponent(path.split("/")[4]??"")
   return updateRun(runID,run=>{
    const node=run.nodes.find(n=>n.node_id===body.nodeID);if(!node)return apiError("agent-management-node-not-found","Fixture node was not found")
    if(action==="workflowApprove"){
     if(node.status!=="waiting_approval"||typeof body.approved!=="boolean")return apiError("agent-management-node-not-pending","Node is not waiting for approval")
     node.status=body.approved?"completed":"failed";node.output=body.approved?JSON.stringify({approved:true,comment:"",downstream:[]}):""
     node.error=body.approved?"":"approval rejected";node.finished_at=new Date().toISOString();run.status="running"
    }else{
     if(!["failed","blocked","rejected"].includes(node.status))return apiError("agent-management-node-not-retryable","Node cannot be retried")
     if(body.includeDescendants!==true)return unexpected("Retry omitted descendant branch")
     const affected=new Set([node.node_id]);let changed=true
     while(changed){changed=false;for(const item of run.nodes)if(!affected.has(item.node_id)&&item.depends_on.some(id=>affected.has(id))){affected.add(item.node_id);changed=true}}
     run.nodes=run.nodes.map(item=>affected.has(item.node_id)?{...item,status:"pending",attempt:0,output:"",error:"",started_at:null,finished_at:null}:item);run.status="running"
    }
    run.updated_at=new Date().toISOString();const counts:Record<string,number>={};for(const item of run.nodes)counts[item.status]=(counts[item.status]??0)+1
    const settled=run.nodes.filter(n=>["completed","failed","skipped","cancelled"].includes(n.status)).length
    run.progress={settled,total:run.nodes.length,percent:settled/run.nodes.length*100,by_status:counts};return run
   })
  }
  if(action==="workflowRunGet"||action==="workflowControl"){
   const runID=decodeURIComponent(path.split("/")[4]??""),current=data.runs.find(r=>r.run_id===runID)
   if(!current)return failed("Fixture workflow run was not found")
   if(action==="workflowRunGet")return wrapped(current)
   const status=body.action==="pause"?"paused":body.action==="resume"?"running":body.action==="cancel"?"cancelled":""
   if(!status)return unexpected("Unknown workflow control action")
   const next={...current,status,updated_at:new Date().toISOString()}
   data.runs=data.runs.map(r=>r.run_id===runID?next:r);return wrapped(next)
  }
  if(action==="skillSetEnabled"||action==="pluginSetEnabled"){
   if(typeof body.enabled!=="boolean"||typeof body.requestID!=="string"||!/^cpr_[0-9a-f-]{36}$/.test(body.requestID))
    return unexpected("Controlled extension toggle lost request ID or intent")
   if(action==="skillSetEnabled"){data.skills=data.skills.map(s=>({...s,enabled:body.enabled as boolean}));const result:Awaited<ReturnType<Caps["skillSetEnabled"]>>["data"]={skill_id:"fixture-skill",enabled:body.enabled,changed:true,skills:skillsPage(data.skills)};return wrapped(result)}
   data.plugins=data.plugins.map(p=>({...p,enabled:body.enabled as boolean}));return wrapped(pluginsPage(data.plugins))
  }
  if(transactionActions.includes(action)){
   let transaction:PluginTransaction|PluginRemoval|PluginRestore
   if(action==="pluginApply"){
    const inspection=source.inspections.get(String(body.token));if(!inspection||inspection.directory!==directory)return apiError("agent-management-inspection-not-found","Plugin inspection expired or is outside this workspace")
    const candidate=inspection.candidates.find(c=>c.name===body.name);if(!candidate)return apiError("agent-management-plugin-not-found","Select an inspected plugin")
    if(candidate.security.status==="blocked"||candidate.problems.length)return apiError("agent-management-invalid-plugin-manifest","Candidate blocked by security or compatibility review")
    const current=data.plugins.find(p=>p.name===candidate.name)
    if(Boolean(current)!==Boolean(body.replace))return apiError("agent-management-plugin-conflict","Plugin replace intent no longer matches installed state")
    const recovery=current?recoveryFor(current,"update"):null
    const installed:Plugin={...candidate,manifest_path:directory+"/.arforge/plugins/"+candidate.name+"/plugin.json",source:"profile",managed:true,enabled:false}
    transaction={name:installed.name,version:installed.version,path:directory+"/.arforge/plugins/"+installed.name,source:inspection.source,sha256:installed.sha256,security:installed.security,enabled:false,updated:!!current,recovery}
    data.plugins=[...data.plugins.filter(p=>p.name!==installed.name),installed];source.inspections.delete(String(body.token))
   }else if(action==="pluginRemove"){
    const current=data.plugins.find(p=>p.name===pluginName&&p.managed);if(!current)return apiError("agent-management-plugin-not-found","Managed plugin not found")
    transaction={name:current.name,removed:true,recoverable:true,recovery:recoveryFor(current,"remove")};data.plugins=data.plugins.filter(p=>p.name!==current.name)
   }else{
    const key=String(body.recoveryID),entry=source.recoveries.get(key)
    if(!entry||!String(entry.metadata.path).startsWith(directory+"/"))return apiError("agent-management-recovery-not-found","Recovery is outside this workspace or no longer available")
    const current=data.plugins.find(p=>p.name===entry.plugin.name)
    if(current&&entry.reason==="remove")return apiError("agent-management-plugin-already-installed","Plugin is already installed")
    const recovery=current?recoveryFor(current,"rollback"):null
    const restored={...entry.plugin,enabled:false};data.plugins=[...data.plugins.filter(p=>p.name!==restored.name),restored];source.recoveries.delete(key)
    transaction={name:restored.name,restored:true,path:directory+"/.arforge/plugins/"+restored.name,enabled:false,recovery}
   }
   const result:Awaited<ReturnType<Caps["pluginApply"]>>["data"]={transaction:wireJSON(transaction),plugins:pluginsPage(data.plugins)}
   Schema.decodeUnknownSync(AgentCapability.PluginTransactionResult)(result);return wrapped(result)
  }
  if(action==="pluginInspect"){
   const {managed,...candidate}=plugin(info)
   if(scenario==="node-transactions"){
    const token=call.id.toString(16).padStart(32,"0"),fresh={...candidate,name:"fixture-new-plugin",version:"2.0.0",enabled:false,source:"external" as const}
    const result:AgentCapability.PluginInspection={token,source:String(body.source),expires_in_seconds:120,selection_required:true,
     candidates:[fresh,{...candidate,version:"2.0.0",enabled:false,source:"external" as const},{...fresh,name:"fixture-blocked-plugin",security:{...fresh.security,status:"blocked",findings:[{rule:"undeclared-egress",severity:"blocking",path:"plugin.json",message:"Fixture candidate is blocked"}]}}]}
    Schema.decodeUnknownSync(AgentCapability.PluginInspection)(result)
    const candidates:Inspection["candidates"]=JSON.parse(JSON.stringify(result.candidates))
    source.inspections.set(token,{source:String(body.source),directory,candidates});return wrapped(result)
   }
   const result:Awaited<ReturnType<Caps["pluginInspect"]>>["data"]={token:"fixture-inspection-not-a-credential",source:String(body.source),expires_in_seconds:120,selection_required:false,
    candidates:[{...candidate,enabled:false,security:{status:"blocked",findings:[{rule:"undeclared-egress",severity:"blocking",path:"fixture-manifest.json",message:"Fixture candidate is blocked"}],scanned_files:1,scanned_bytes:64}}]}
   return wrapped(result)
  }
  return unexpected("No extension success projection: "+action)
 }
 const readOnly=method==="GET"
 if(readOnly&&!holdFor(call))return answer(call,success())
 return new Promise<Response>(resolve=>pending.set(call.id,{call,success,resolve}))
}
function makeSource(name:string,sameURL=false){
 const server:ServerConnection.Http={type:"http",http:{url:origin+(sameURL?"/source-a":"/source-"+name)}}
 const source={name,server,datasets:new Map<string,Data>(),inspections:new Map<string,Inspection>(),recoveries:new Map<string,Recovery>()} as Source
 const fetch=Object.assign((input:RequestInfo|URL,init?:RequestInit)=>transport(source,input,init),{preconnect:()=>unexpected("No real transport preconnect")}) as typeof globalThis.fetch
 source.sdk=strict({server,url:server.http.url,scope:ServerScope.fromServerKey(ServerConnection.key(server)),operationsApi:createOperationsApiForServer({server:server.http,fetch})},"source-"+name) as unknown as ServerSDK
 sources.set(name,source)
}
makeSource("a")
if(scenario==="location-gate")holds.push({action:"location.get",source:"a"})
if(scenario==="read-error")rejectReads.add("pluginList")
export const connection=()=>sources.get(control.source)!.server
export const mockGlobal=strict({ensureServerCtx(conn:ServerConnection.Any){const source=sources.get(control.source)!;if(conn!==source.server)return unexpected("Inactive extension source");return {sdk:source.sdk}}},"global") as unknown as ReturnType<typeof ProductionUseGlobal>
export const mockServer={get current(){return connection()}} as ReturnType<typeof ProductionUseServer>
export function bindProbe(value:(()=>Probe)|undefined){probe=value}
export function forbidNative(name:string):never{nativeAttempts.push(name);throw new Error("Forbidden native action "+name)}
async function flush(){for(let i=0;i<8;i++)await Promise.resolve();await new Promise<void>(r=>requestAnimationFrame(()=>r()))}
export const fixture={
 snapshot:()=>({active:{source:control.source,sessionID:control.sessionID,location:infoFor(),mounted:control.mounted},
  calls:clone(calls),pendingIDs:[...pending.keys()],violations:[...violations],nativeAttempts:[...nativeAttempts],
  approvals:clone(approvals),controlReceipts:clone(controlReceipts),controlRequests:clone([...controlRequests.values()]),application:probe?.(),childReads:[...childReads]}),
 async settle(id:number,outcome:Outcome="ok"){
  const entry=pending.get(id);if(!entry)throw new Error("No pending extension API "+id);pending.delete(id)
  const transactional=transactionActions.includes(entry.call.action)
  const controlled=transactional||["pluginSetEnabled","skillSetEnabled"].includes(entry.call.action)
  if(controlled&&!["approve","reject","read-only"].includes(outcome))return unexpected("Control approval must be explicitly decided in memory")
  if(controlled)approvals.push({requestID:String(entry.call.body.requestID),callID:id,decision:outcome,source:entry.call.source,directory:entry.call.directory})
  const request=controlRequests.get(id)
  const denied=transactional&&["reject","read-only"].includes(outcome)
  const response=denied?json(new InvalidRequestError({kind:"agent-management-blocked-error",message:outcome==="read-only"?"Permission denied: fixture workspace is read-only":"Permission denied for "+request?.action}),400):outcome==="error"?failed():outcome==="reject"?failed("Fixture control approval rejected",401):entry.success()
  if(request){controlReceipts.push({request,reply:Permission.Reply.make(outcome==="approve"?"once":"reject"),operationRequestID:String(entry.call.body.requestID),callID:id,responseStatus:response.status,scopeSessionID:entry.call.sessionID})}
  entry.resolve(await answer(entry.call,response));await flush()
 },
 holdNext(action:string,sessionID?:string){holds.push({action,source:control.source,sessionID})},
 rejectRead(action:string,value:boolean){if(value)rejectReads.add(action);else rejectReads.delete(action)},
 async switchScope(mode:Mode){if(mode==="session")setControl("sessionID","ses_extension_b");else if(mode==="location-refresh")setControl("locationVersion","b");else{makeSource("b",mode==="same-url-instance");setControl("source","b")}await flush()},
 async unmount(){setControl("mounted",false);await flush()},
 navigate(value:string){if(value!=="arforge-extensions")unexpected("Unexpected fixture navigation "+value);setControl("tab",value)},
}
export type ExtensionFixture=typeof fixture
declare global{interface Window{__extensionAcceptance:ExtensionFixture}}
window.__extensionAcceptance=fixture
