import { ServerConnection } from '../../../src/context/server'
// Preserve the real server identity helpers consumed by the current SDK and
// settings module graph; only the fixture's connection accessor is replaced.
export * from '../../../src/context/server'
import { ServerScope } from '../../../src/utils/server-scope'
const directory='C:/Isolated/Lifecycle/Main'
const entries=[{type:'main',directory},{type:'copy',directory:'C:/Isolated/Lifecycle/Copy-A',strategy:'git_worktree'}]
const calls:{name:string,input:unknown,outcome:string}[]=[],failures=new Set<string>()
async function call(name:string,input:unknown,run:()=>unknown){const hit={name,input:structuredClone(input),outcome:'pending'};calls.push(hit);if(failures.delete(name)){hit.outcome='403';throw new Error('403 Isolated project-copy path is not writable')}const result=run();hit.outcome='success';return structuredClone(result)}
const unsupported=async()=>{throw new Error('Unrelated operations are unsupported in this bounded project-copy fixture')}
const operationsApi={location:{get:()=>call('location.get',{},()=>({directory,project:{id:'prj_fixture',directory},workspaceID:'workspace-a'}))},projectCopies:{
 list:(input:unknown)=>call('copy.list',input,()=>entries),
 create:(input:any)=>call('copy.create',input,()=>{if(input.projectID!=='prj_fixture'||input.location.directory!==directory||input.strategy!=='git_worktree')throw new Error('Wrong project-copy source');const row={type:'copy',directory:input.directory,strategy:input.strategy};entries.push(row);return row}),
 refresh:(input:unknown)=>call('copy.refresh',input,()=>({updated:entries.length})),
 remove:(input:any)=>call('copy.remove',input,()=>{if(input.force!==false||input.projectID!=='prj_fixture')throw new Error('Unsafe copy removal request');entries.splice(entries.findIndex(x=>x.directory===input.directory),1);return true}),
},privateOperations:{overview:unsupported},tenantPlatform:{overview:unsupported,listSecrets:unsupported},artifacts:{ownerContext:unsupported}}
const server:ServerConnection.Http={type:'http',http:{url:'http://isolated-copy.invalid'}}
const sdk={server,url:server.http.url,scope:ServerScope.fromServerKey(ServerConnection.key(server)),operationsApi}
export const useGlobal=()=>({ensureServerCtx:()=>({sdk})})
export const useServer=()=>({current:server})
Object.assign(window,{__lifecycleCopies:{calls,fail:(name:string)=>failures.add(name),snapshot:()=>({calls,entries,unusedFaults:[...failures]})}})
