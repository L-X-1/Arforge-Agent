const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto')
const suites = ['system-overview-scope','agent-extension-scope','skill-lifecycle-scope','experience-candidate-scope','provider-scope','personal-workspace-scope','control-scope','tenant-platform-scope','artifact-evidence-scope','runtime-insight']
const root = path.resolve(__dirname,'../..'), output = path.join(__dirname,'generated-tests')
const audit = path.resolve(__dirname,'../../../../../../docs/ui-redesign/interaction-audit-v3-20261029')
fs.mkdirSync(output,{recursive:true})
const manifest = []
for (const suite of suites) {
  const source = path.join(root,suite,suite+'.repro.ts'), original = fs.readFileSync(source,'utf8')
  if (!original.includes('from "@playwright/test"')) throw new Error('Unexpected test import: '+suite)
  const generated = original.replace('from "@playwright/test"','from "../network-fixture"')
  fs.writeFileSync(path.join(output,suite+'.repro.ts'),generated)
  const files = ['main.tsx',suite+'.repro.ts','playwright.config.ts','vite.config.ts','index.html'].map(file=>{
    const absolute=path.join(root,suite,file)
    return {file:absolute.replaceAll('\\','/'),sha256:crypto.createHash('sha256').update(fs.readFileSync(absolute)).digest('hex')}
  })
  manifest.push({suite,files,assertionTransformation:'Only test import redirects to an automatic network fence; all original assertions unchanged.',fixtureContext:'Add required DialogProvider when absent; no production component change.'})
}
fs.writeFileSync(path.join(audit,'management-broad-reviewed-manifest.json'),JSON.stringify({reviewedAt:new Date().toISOString(),suites:manifest,host:'mock fixtures only; static loopback GET/HEAD; no backend, full app prebuild, git or install',workers:1},null,2))
console.log('Prepared '+suites.length+' unchanged assertion suites with an isolated network fence.')
