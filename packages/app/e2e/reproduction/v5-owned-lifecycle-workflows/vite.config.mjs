import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { createAppPlugin } from '../../../vite.js'
const root=import.meta.dirname
export default {root,envDir:false,publicDir:false,cacheDir:resolve(root,"../../.playwright-temp/v5-owned-lifecycle-workflows/vite"),server:{hmr:false,warmup:{clientFiles:["../../../src/index.css","./main.tsx"]},fs:{allow:[resolve(root,"../../../../..")]}},plugins:[{name:'formal-lifecycle-connection-boundary',enforce:'pre',resolveId(id,importer){const from=importer?.replaceAll('\\','/').split('?')[0];if(!from?.endsWith('/src/context/server-sdk.tsx'))return;const normalized=id.replace(/\.tsx?$/,'');if(['./global','./server','@/context/global','@/context/server'].includes(normalized)){const file="goal"==='queue'?(normalized.endsWith('global')?'global-fixture.ts':'server-fixture.ts'):'boundary-fixture.ts';return resolve(root,file)}}},...createAppPlugin({solidHot:false})]}
