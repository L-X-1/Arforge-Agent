import path from "path"

const root = path.resolve(import.meta.dir, "..")
const apply = process.argv.includes("--apply")
const hostedNotice = `---
title: Hosted model service
description: Hosted model service coordinates are not configured in this source build.
---

# Hosted model service

This source build does not assume a public Arforge domain, billing service,
model gateway, registry account, or signing identity. The previous hosted
offering is therefore unavailable instead of being relabeled as an Arforge
service.

Use [Providers](/docs/providers) to configure a provider endpoint and
credentials that you own. A future hosted service may be documented here only
after its operator supplies real deployment coordinates, terms, and support
ownership.
`

const shareNotice = `---
title: Share
description: Configure an operator-owned endpoint before sharing sessions.
---

# Share

Arforge retains the session-sharing client and protocol, but this source build
does not assume a public storage endpoint. Sharing fails closed until either:

- \`enterprise.url\` points to a service you operate that implements the share
  API; or
- an explicitly configured organization account supplies its control-plane
  endpoint and credentials.

Keep sharing disabled when no such service is available:

\`\`\`json title="arforge.json"
{
  "share": "disabled"
}
\`\`\`

Once an endpoint is configured, \`"manual"\` enables the \`/share\` command and
\`"auto"\` shares every new root session. Treat every generated link according
to the access policy of your own service; this repository makes no claim that
those links are private.
`

const organizationNotice = `---
title: Organization deployment
description: Deploy Arforge with configuration and infrastructure that your organization owns.
---

# Organization deployment

This repository does not bundle a commercial control plane, sales contact,
pricing plan, SSO service, or hosted AI gateway. It does retain the controls
needed for an organization-owned deployment: hierarchical configuration,
provider endpoints, permission rules, and optional self-hosted session sharing.

Start with a checked-in project configuration that restricts providers and
tools, then distribute organization-wide settings through infrastructure you
operate. Configure \`enterprise.url\` only when you own a compatible endpoint.
SSO, device management, audit retention, and data residency remain deployment
responsibilities rather than implied services of this source tree.
`

let files = 0
for (const [glob, notice] of [
  ["packages/web/src/content/docs/**/{zen,go}.mdx", hostedNotice],
  ["packages/web/src/content/docs/**/share.mdx", shareNotice],
  ["packages/web/src/content/docs/**/enterprise.mdx", organizationNotice],
] as const) {
  for await (const relative of new Bun.Glob(glob).scan({
    cwd: root,
    onlyFiles: true,
  })) {
    const target = path.join(root, relative)
    if ((await Bun.file(target).text()) === notice) continue
    files++
    if (apply) await Bun.write(target, notice)
  }
}

console.log(`${apply ? "Replaced" : "Would replace"} ${files} unowned service guides with neutral notices`)
if (!apply) console.log("Run again with --apply after reviewing the scope")
