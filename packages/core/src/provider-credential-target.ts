import { createHash } from "node:crypto"

/** Private encrypted credential metadata; independent of process/config CAS revisions. */
export const providerCredentialTargetKey = "arforge.provider.target.v1"

export function providerCredentialTarget(
  providerID: string,
  api: { readonly type: string; readonly package?: string; readonly url?: string },
) {
  if (api.type !== "aisdk" || !api.url || !api.package) return undefined
  let url: URL
  try {
    url = new URL(api.url)
  } catch {
    return undefined
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return undefined
  return createHash("sha256")
    .update(JSON.stringify(["provider-target-v1", providerID, api.type, api.package, url.href]))
    .digest("hex")
}
