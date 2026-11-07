export default {name:'bounded-project-copy-guard-observation',enforce:'pre',transform(code,id){
 if(id.replaceAll('\\','/').split('?')[0].endsWith('/packages/ui/src/context/dialog.tsx')) return code.replace('const close = (id?: string) => {','const close = (id?: string) => { (window.__lifecycleDialogEvents ??= []).push({event:"close",id,stack:new Error().stack});').replace('const push = (element: DialogElement, owner: Owner, onClose?: () => void) => {','const push = (element: DialogElement, owner: Owner, onClose?: () => void) => { (window.__lifecycleDialogEvents ??= []).push({event:"push",stack:new Error().stack});')
 if(!id.replaceAll('\\','/').split('?')[0].endsWith('/src/components/control-center/dialog-control-center.tsx'))return
 const start=code.indexOf('  const remove = async (directory: string) => {')
 if(start<0)throw Error('Project-copy diagnostic source anchor changed')
 const end=code.indexOf('\n  return (',start),part=code.slice(start,end)
 const original='const isCurrent = () =>\n      confirmation.canWrite() && state.entries.some((entry) => entry.type === "copy" && entry.directory === directory)'
 if(!part.includes(original))throw Error('Project-copy guard source anchor changed')
 const replacement='const isCurrent = () => { const sourceCurrent=confirmation.isCurrent(), writable=confirmation.canWrite(), exists=state.entries.some((entry) => entry.type === "copy" && entry.directory === directory); (window.__lifecycleCopyDiagnostics ??= []).push({sourceCurrent,writable,exists,directory,loading:state.loading,saving:state.saving,fresh:reads.fresh(),entries:state.entries.map(e=>({type:e.type,directory:e.directory}))}); return writable && exists }'
 return code.slice(0,start)+part.replace(original,replacement)+code.slice(end)
}}
