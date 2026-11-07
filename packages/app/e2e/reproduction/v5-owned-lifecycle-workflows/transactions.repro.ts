import { test,expect } from "./network-fixture"
import { runRows, selectCatalogRecords, selectPlugin, showCatalog } from "./selection"
import type { Page,Locator } from "@playwright/test"
import type { Call,Mode,Outcome } from "./sdk-fixture"

type Action="approve"|"reject"|"retry"|"apply"|"remove"|"restore"
const panel=(page:Page)=>page.getByTestId("extension-management")
const center=(page:Page)=>panel(page).getByTestId("managed-plugin-center")
const detail=(page:Page)=>panel(page).getByTestId("workflow-run-detail")
const snap=(page:Page)=>page.evaluate(()=>window.__extensionAcceptance.snapshot())
const apiFor=(action:Action)=>action==="approve"||action==="reject"?"workflowApprove":action==="retry"?"workflowRetry":action==="apply"?"pluginApply":action==="remove"?"pluginRemove":"pluginRestore"
const sourceInput=(page:Page)=>center(page).getByLabel("Plugin source (local path or public HTTPS URL)",{exact:true})
const recoveryInput=(page:Page)=>center(page).getByLabel("Recovery ID",{exact:true})
const error=(page:Page)=>panel(page).getByTestId("extension-management-error")
async function calls(page:Page,action:string){return (await snap(page)).calls.filter(c=>c.action===action)}
async function pending(page:Page,action:string){
 await expect.poll(async()=>(await calls(page,action)).filter(c=>!c.settled).length).toBe(1)
 return (await calls(page,action)).find(c=>!c.settled)!
}
async function settle(page:Page,call:Call,outcome:Outcome="ok"){
 await page.evaluate(({id,outcome})=>window.__extensionAcceptance.settle(id,outcome),{id:call.id,outcome})
}
async function ready(page:Page){
 await expect(panel(page)).toBeVisible()
 const l=(await snap(page)).application!.labels
 await expect(panel(page).getByRole("button",{name:l.refreshAll,exact:true})).toBeEnabled()
 return l
}
async function open(page:Page){await page.goto("/?scenario=node-transactions");const labels=await ready(page);await selectCatalogRecords(page,"Plugins");return labels}
async function refresh(page:Page){
 const l=(await snap(page)).application!.labels
 await panel(page).getByRole("button",{name:l.refreshAll,exact:true}).click();await ready(page)
}
async function openRun(page:Page){
 await showCatalog(page,"Workflows")
 await page.evaluate(()=>window.__extensionAcceptance.holdNext("workflowRunGet"))
 await runRows(page).click()
 await settle(page,await pending(page,"workflowRunGet"))
 await expect(detail(page)).toBeVisible()
}
function nodeButton(page:Page,action:"approve"|"reject"|"retry"){
 if(action==="retry")return detail(page).getByRole("button",{name:"Retry branch",exact:true}).first()
 return detail(page).getByRole("button",{name:action==="approve"?"Approve":"Reject",exact:true})
}
async function inspect(page:Page,name="fixture-new-plugin"){
 await showCatalog(page,"Plugins")
 await sourceInput(page).fill("  C:/Arforge/ExtensionAcceptance/memory-package  ")
 await center(page).getByRole("button",{name:"Inspect package",exact:true}).click()
 const inspection=await pending(page,"pluginInspect")
 expect(inspection.body).toEqual({source:"C:/Arforge/ExtensionAcceptance/memory-package"})
 await settle(page,inspection)
 const review=center(page).getByTestId("plugin-inspection")
 await review.getByRole("combobox",{name:"Candidate",exact:true}).selectOption(name)
 return review.getByRole("button",{name:"Install inspected plugin…",exact:true})
}
async function confirmRemove(page:Page,button:Locator,accepted:boolean){
 await button.click()
 const dialog=page.getByRole("dialog",{name:"Confirm action",exact:true})
 await expect(dialog).toBeVisible();await expect(dialog).toContainText("Remove managed Plugin fixture-plugin?")
 await dialog.getByRole("button",{name:accepted?"Confirm":"Cancel",exact:true}).click()
}
async function removeToRecovery(page:Page){
 await selectPlugin(page)
 const button=center(page).getByTestId("managed-plugin-card").filter({hasText:"fixture-plugin"}).getByRole("button",{name:"Remove…",exact:true})
 await confirmRemove(page,button,true)
 const removal=await pending(page,"pluginRemove");await settle(page,removal,"approve")
 await expect(recoveryInput(page)).toHaveValue(/^fixture-plugin-\d{8}T\d{6}-[a-f0-9]{8}$/)
 return recoveryInput(page).inputValue()
}
async function prepare(page:Page,action:Action){
 if(["approve","reject","retry"].includes(action)){await openRun(page);return nodeButton(page,action as "approve"|"reject"|"retry")}
 if(action==="apply")return inspect(page)
 if(action==="restore"){await removeToRecovery(page);return center(page).getByRole("button",{name:"Restore",exact:true})}
 return center(page).getByTestId("managed-plugin-card").getByRole("button",{name:"Remove…",exact:true})
}
async function invoke(page:Page,action:Action,button:Locator){
 if(action==="remove")await confirmRemove(page,button,true);else await button.click()
 return pending(page,apiFor(action))
}
async function assertBusy(page:Page,button:Locator,api:string,expectedCount:number){
 await expect(button).toBeDisabled()
 await button.evaluate((b:HTMLButtonElement)=>b.click())
 expect(await calls(page,api)).toHaveLength(expectedCount)
 await expect(sourceInput(page)).toBeDisabled()
 await expect(recoveryInput(page)).toBeDisabled()
}
function runData(call:Call){return (call.responseData as {data:{nodes:{node_id:string;status:string;attempt:number;error:string}[]}}).data}
async function receipt(page:Page,call:Call,reply:"once"|"reject",status:number){
 const state=await snap(page),entry=state.controlReceipts.find(r=>r.callID===call.id)
 expect(entry).toMatchObject({reply,responseStatus:status,operationRequestID:call.body.requestID,request:{
  id:"per_fixture_"+call.id,subject:{type:"control-plane",requestID:call.body.requestID,location:call.directory,actor:"user"},
 }})
 expect(entry!.request).not.toHaveProperty("sessionID")
 expect(entry!.request.subject).not.toHaveProperty("sessionID")
 expect(entry!.request.resources).toContain("filesystem:"+call.directory+"/.arforge/plugins")
 return entry!
}

for(const action of ["approve","reject","retry"] as const){
 test("[transactions] node "+action+" preserves failed input then sends exact payload and acknowledged state once",async({page})=>{
  const l=await open(page);await openRun(page)
  await panel(page).getByRole("combobox",{name:l.permission,exact:true}).selectOption("plan")
  await showCatalog(page,"Plugins")
  await sourceInput(page).fill("node-draft-retained")
  await showCatalog(page,"Workflows")
  const button=nodeButton(page,action);await button.click()
  const first=await pending(page,apiFor(action)),state=await snap(page)
  const expected=action==="retry"?{nodeID:"failed-branch",includeDescendants:true}:{nodeID:"approval-gate",approved:action==="approve"}
  expect(first.body).toEqual(expected)
  expect(first.path).toBe("/api/agent-capabilities/workflow-runs/run_a_"+state.active.location.workspaceID+"_ses_extension_a/"+(action==="retry"?"retry":"approve"))
  expect(first.directory).toBe(state.active.location.directory)
  await assertBusy(page,button,apiFor(action),1)
  await settle(page,first,"error")
  await expect(error(page)).toContainText("Fixture extension request rejected")
  await expect(sourceInput(page)).toHaveValue("node-draft-retained")
  await expect(panel(page).getByRole("combobox",{name:l.permission,exact:true})).toHaveValue("plan")
  await expect(button).toBeEnabled()
  const notices=action==="retry"?"Retry requested for failed-branch and its descendants.":action==="approve"?"Approval recorded.":"Rejection recorded."
  await expect(panel(page).getByText(notices,{exact:true})).toHaveCount(0)
  await button.click();const second=await pending(page,apiFor(action));expect(second.body).toEqual(first.body)
  await assertBusy(page,button,apiFor(action),2);await settle(page,second)
  await expect(error(page)).toHaveCount(0)
  await expect(panel(page).getByText(notices,{exact:true})).toBeVisible()
  const result=(await calls(page,apiFor(action))).at(-1)!;expect(result.responseStatus).toBe(200)
  if(action==="retry"){
   for(const id of ["failed-branch","branch-child"])expect(runData(result).nodes.find(n=>n.node_id===id)).toMatchObject({status:"pending",attempt:0,error:""})
  }else expect(runData(result).nodes.find(n=>n.node_id==="approval-gate")!.status).toBe(action==="approve"?"completed":"failed")
  expect(await calls(page,apiFor(action))).toHaveLength(2)
 })
}

test('[workflows-s03 workflows-s05] workflow mixed branch state exposes real node prerequisites and truthful settled progress',async({page})=>{
 await open(page);await openRun(page)
 const root=detail(page)
 await expect(root.getByRole('progressbar',{name:'Workflow progress',exact:true})).toHaveAttribute('aria-valuenow','33')
 await expect(root).toContainText('Synthetic node failure')
 await expect(root.getByRole('button',{name:'Approve',exact:true})).toBeVisible()
 await expect(root.getByRole('button',{name:'Retry branch',exact:true}).first()).toBeVisible()
 const child=root.locator('div.min-w-0').filter({has:page.getByText('Blocked descendant',{exact:true})}).last()
 await child.locator('summary').press('Enter')
 await expect(child).toContainText('failed-branch')
 await expect(child).toContainText('Prerequisites')
 const s=await snap(page),loaded=s.calls.find(c=>c.action==='workflowRunGet')!
 const data=(loaded.responseData as {data:{nodes:{node_id:string;status:string;depends_on:string[]}[]}}).data
 expect(data.nodes.map(n=>[n.node_id,n.status,n.depends_on])).toEqual([['approval-gate','waiting_approval',[]],['failed-branch','failed',[]],['branch-child','blocked',['failed-branch']]])
 expect(await calls(page,'workflowRetry')).toHaveLength(0)
})
test("[transactions] plugin install retains reviewed token and draft through explicit reject and readonly denial before approved receipt",async({page})=>{
 await open(page);const button=await inspect(page)
 let token:string|undefined
 for(const [index,outcome] of (["reject","read-only","approve"] as const).entries()){
  await button.click();const call=await pending(page,"pluginApply")
  token??=String(call.body.token)
  expect(call.body).toEqual({token,name:"fixture-new-plugin",replace:false,requestID:expect.stringMatching(/^cpr_[0-9a-f-]{36}$/)})
  await assertBusy(page,button,"pluginApply",index+1)
  await settle(page,call,outcome)
  await receipt(page,call,outcome==="approve"?"once":"reject",outcome==="approve"?200:400)
  if(outcome!=="approve"){
   await expect(error(page)).toContainText("Permission denied")
   await expect(sourceInput(page)).toHaveValue("  C:/Arforge/ExtensionAcceptance/memory-package  ")
   await expect(center(page).getByRole("combobox",{name:"Candidate",exact:true})).toHaveValue("fixture-new-plugin")
   await expect(button).toBeEnabled()
   await expect(center(page).getByTestId("managed-plugin-card").filter({hasText:"fixture-new-plugin"})).toHaveCount(0)
   await expect(panel(page).getByText(/^Plugin transaction completed/)).toHaveCount(0)
  }
 }
 await expect(sourceInput(page)).toHaveValue("")
 await expect(center(page).getByTestId("plugin-inspection")).toHaveCount(0)
 await selectPlugin(page,"fixture-new-plugin")
 await expect(center(page).getByTestId("managed-plugin-card").filter({hasText:"fixture-new-plugin"})).toHaveAttribute("data-enabled","false")
 await expect(panel(page).getByText(/^Plugin transaction completed/)).toBeVisible()
 const writes=await calls(page,"pluginApply");expect(new Set(writes.map(c=>c.body.requestID)).size).toBe(3)
 expect(writes.map(c=>c.responseStatus)).toEqual([400,400,200])
})
test("[transactions] plugin update and rollback use replacement receipt preserve recovery on reject and restore disabled",async({page})=>{
 await open(page);const button=await inspect(page,"fixture-plugin")
 await button.click();const update=await pending(page,"pluginApply")
 expect(update.body).toMatchObject({name:"fixture-plugin",replace:true})
 await settle(page,update,"approve");expect((await receipt(page,update,"once",200)).request.action).toBe("plugin.update")
 await expect(center(page).getByTestId("managed-plugin-card")).toContainText("fixture-plugin 2.0.0")
 await expect(center(page).getByTestId("managed-plugin-card")).toHaveAttribute("data-enabled","false")
 const recovery=await recoveryInput(page).inputValue();expect(recovery).toMatch(/^fixture-plugin-\d{8}T\d{6}-[a-f0-9]{8}$/)
 const restore=center(page).getByRole("button",{name:"Restore",exact:true})
 for(const [index,outcome] of (["reject","approve"] as const).entries()){
  await restore.click();const call=await pending(page,"pluginRestore")
  expect(call.body).toEqual({recoveryID:recovery,requestID:expect.stringMatching(/^cpr_/ )})
  await assertBusy(page,restore,"pluginRestore",index+1);await settle(page,call,outcome)
  expect((await receipt(page,call,outcome==="approve"?"once":"reject",outcome==="approve"?200:400)).request.action).toBe("plugin.rollback")
  if(outcome==="reject"){await expect(recoveryInput(page)).toHaveValue(recovery);await expect(error(page)).toContainText("Permission denied");await expect(center(page).getByTestId("managed-plugin-card")).toContainText("2.0.0")}
 }
 await expect(center(page).getByTestId("managed-plugin-card")).toContainText("fixture-plugin 1.0.0")
 await expect(center(page).getByTestId("managed-plugin-card")).toHaveAttribute("data-enabled","false")
 await expect(recoveryInput(page)).not.toHaveValue(recovery)
 await expect(recoveryInput(page)).toHaveValue(/^fixture-plugin-\d{8}T\d{6}-[a-f0-9]{8}$/)
 await expect(panel(page).getByText("Plugin restored in disabled state.",{exact:true})).toBeVisible()
})
test("[transactions] plugin removal confirm cancellation sends no API then rejection and approved remove restore preserve lawful recovery",async({page})=>{
 await open(page)
 const card=center(page).getByTestId("managed-plugin-card"),remove=card.getByRole("button",{name:"Remove…",exact:true})
 await confirmRemove(page,remove,false);expect(await calls(page,"pluginRemove")).toHaveLength(0)
 await confirmRemove(page,remove,true);const rejected=await pending(page,"pluginRemove")
 expect(rejected.body).toEqual({requestID:expect.stringMatching(/^cpr_/ )});await assertBusy(page,remove,"pluginRemove",1)
 await settle(page,rejected,"reject");await receipt(page,rejected,"reject",400)
 await expect(card).toHaveAttribute("data-enabled","true");await expect(recoveryInput(page)).toHaveValue("")
 await expect(panel(page).getByText(/moved to recoverable local trash\./)).toHaveCount(0)
 await confirmRemove(page,remove,true);const accepted=await pending(page,"pluginRemove")
 expect(accepted.path).toBe("/api/agent-capabilities/plugins/fixture-plugin/remove");await settle(page,accepted,"approve")
 expect((await receipt(page,accepted,"once",200)).request.action).toBe("plugin.uninstall")
 await expect(card).toHaveCount(0)
 const recovery=await recoveryInput(page).inputValue();expect(recovery).toMatch(/^fixture-plugin-\d{8}T\d{6}-[a-f0-9]{8}$/)
 const restore=center(page).getByRole("button",{name:"Restore",exact:true});await restore.click()
 const restored=await pending(page,"pluginRestore");expect(restored.body).toMatchObject({recoveryID:recovery})
 await assertBusy(page,restore,"pluginRestore",1);await settle(page,restored,"approve");await receipt(page,restored,"once",200)
 await expect(card).toHaveAttribute("data-enabled","false");await expect(recoveryInput(page)).toHaveValue("")
 await expect(restore).toBeDisabled()
})
test("[transactions] missing recovery reports valid transaction failure after approval and retains input for explicit correction",async({page})=>{
 await open(page);const missing="fixture-plugin-20261028T120000-deadbeef"
 await recoveryInput(page).fill("  "+missing+"  ")
 const restore=center(page).getByRole("button",{name:"Restore",exact:true});await restore.click()
 const failed=await pending(page,"pluginRestore");expect(failed.body).toMatchObject({recoveryID:missing})
 await settle(page,failed,"approve");await receipt(page,failed,"once",400)
 await expect(error(page)).toContainText("Recovery is outside this workspace or no longer available")
 await expect(recoveryInput(page)).toHaveValue("  "+missing+"  ")
 await expect(panel(page).getByText("Plugin restored in disabled state.",{exact:true})).toHaveCount(0)
 await expect(restore).toBeEnabled()
 expect((await calls(page,"pluginRestore"))[0].responseStatus).toBe(400)
})
test("[transactions] blocked candidate and missing selection cannot call plugin apply",async({page})=>{
 await open(page);const button=await inspect(page,"fixture-blocked-plugin")
 await expect(button).toBeDisabled();await button.evaluate((b:HTMLButtonElement)=>b.click())
 expect(await calls(page,"pluginApply")).toHaveLength(0)
 await center(page).getByRole("combobox",{name:"Candidate",exact:true}).selectOption("")
 await expect(button).toBeDisabled();await button.evaluate((b:HTMLButtonElement)=>b.click())
 expect(await calls(page,"pluginApply")).toHaveLength(0)
})
test("[transactions] pending and failed reads keep all new action controls readonly until genuine read recovery",async({page})=>{
 const l=await open(page);await openRun(page);await inspect(page)
 await recoveryInput(page).fill("fixture-plugin-20261028T120000-deadbeef")
 const buttons=[nodeButton(page,"approve"),nodeButton(page,"reject"),nodeButton(page,"retry"),
  center(page).getByRole("button",{name:"Install inspected plugin…",exact:true}),
  center(page).getByTestId("managed-plugin-card").getByRole("button",{name:"Remove…",exact:true}),
  center(page).getByRole("button",{name:"Restore",exact:true})]
 const before=(await snap(page)).calls.length
 await page.evaluate(()=>window.__extensionAcceptance.holdNext("workflowRunList","ses_extension_a"))
 await panel(page).getByRole("button",{name:l.refreshAll,exact:true}).click();const read=await pending(page,"workflowRunList")
 for(const [index,button] of buttons.entries()){await showCatalog(page,index<3?"Workflows":"Plugins");await expect(button).toBeDisabled();await button.evaluate((b:HTMLButtonElement)=>b.click())}
 expect((await snap(page)).calls.slice(before).every(c=>c.method==="GET")).toBe(true)
 await page.evaluate(()=>window.__extensionAcceptance.rejectRead("pluginList",true));await settle(page,read)
 // The plugin read was already captured before it was rejected, so a fresh explicit read establishes stale state.
 await refresh(page);await expect(error(page)).toBeVisible()
 for(const [index,button] of buttons.entries()){await showCatalog(page,index<3?"Workflows":"Plugins");await expect(button).toBeDisabled()}
 expect((await snap(page)).calls.slice(before).every(c=>c.method==="GET")).toBe(true)
 await page.evaluate(()=>window.__extensionAcceptance.rejectRead("pluginList",false));await refresh(page)
 await expect(error(page)).toHaveCount(0);for(const [index,button] of buttons.entries()){await showCatalog(page,index<3?"Workflows":"Plugins");await expect(button).toBeEnabled()}
})

async function switchAway(page:Page,mode:Mode|"unmount"){
 if(mode==="unmount"){await page.evaluate(()=>window.__extensionAcceptance.unmount());await expect(panel(page)).toHaveCount(0);return}
 if(mode==="location-refresh"){
  await page.evaluate(()=>window.__extensionAcceptance.holdNext("location.get"))
  await page.evaluate(()=>window.__extensionAcceptance.switchScope("location-refresh"))
  const l=(await snap(page)).application!.labels
  await page.getByTestId("production-extensions-host").locator(".arforge-control-center-header").getByRole("button",{name:l.refreshParent,exact:true}).click()
  const location=await pending(page,"location.get");await expect(panel(page)).toHaveCount(0);await settle(page,location)
 }else await page.evaluate(mode=>window.__extensionAcceptance.switchScope(mode),mode)
 await ready(page)
 await selectCatalogRecords(page,"Workflows")
 const state=await snap(page)
 await expect(runRows(page)).toContainText("Run "+state.active.source+"/"+state.active.location.workspaceID+"/"+state.active.sessionID)
 await showCatalog(page,"Plugins")
}
for(const action of ["approve","retry","apply","remove","restore"] as const){
 for(const mode of ["session","different-server","location-refresh","unmount"] as const){
  test("[transactions] "+action+" late acknowledged result is fenced after "+mode,async({page})=>{
   await open(page);const button=await prepare(page,action),old=await invoke(page,action,button)
   const oldSource=old.source,oldDirectory=old.directory
   await switchAway(page,mode)
   const before=(await snap(page)).calls.length
   const currentCards=mode==="unmount"?[]:await center(page).getByTestId("managed-plugin-card").evaluateAll(cards=>cards.map(card=>({text:card.textContent,enabled:card.getAttribute("data-enabled")})))
   await settle(page,old,["apply","remove","restore"].includes(action)?"approve":"ok")
   const after=await snap(page);expect(after.calls.slice(before)).toEqual([])
   const completed=after.calls.find(c=>c.id===old.id)!;expect(completed.responseStatus).toBe(200)
   expect(completed.source).toBe(oldSource);expect(completed.directory).toBe(oldDirectory)
   if(mode==="unmount"){await expect(panel(page)).toHaveCount(0);return}
   await expect(detail(page)).toHaveCount(0);await expect(error(page)).toHaveCount(0)
   await expect(sourceInput(page)).toHaveValue("");await expect(recoveryInput(page)).toHaveValue("")
   await expect(center(page).getByTestId("plugin-inspection")).toHaveCount(0)
   expect(await center(page).getByTestId("managed-plugin-card").evaluateAll(cards=>cards.map(card=>({text:card.textContent,enabled:card.getAttribute("data-enabled")})))).toEqual(currentCards)
   await expect(panel(page).getByText(/Approval recorded\.|Retry requested for |Plugin transaction completed\.|moved to recoverable local trash\.|Plugin restored in disabled state\./)).toHaveCount(0)
  })
 }
}
