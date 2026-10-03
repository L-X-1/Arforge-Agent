export const documentPolicyHeader = "Document-Policy"
export const jsCallStacksDocumentPolicy = "include-js-call-stacks-in-crash-reports"

// Only the application-owned, built renderer receives this policy. Remote
// browser pages retain their own policies. Network schemes support configured
// remote servers; they do not grant permission to execute remote scripts.
export const rendererContentSecurityPolicy = [
  "default-src 'none'",
  "base-uri 'self' http://127.0.0.2:*",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "script-src-attr 'none'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: http: https:",
  "font-src 'self' data: https:",
  "connect-src 'self' http: https: ws: wss: data: blob:",
  "media-src 'self' data: blob: http: https:",
  "worker-src 'self' blob:",
  "frame-src 'self' data: blob: http://127.0.0.2:*",
].join("; ")

export function withRendererDocumentPolicy(response: Response, file: string) {
  if (!file.toLowerCase().endsWith(".html")) return response
  const headers = new Headers(response.headers)
  headers.set(documentPolicyHeader, jsCallStacksDocumentPolicy)
  headers.set("Content-Security-Policy", rendererContentSecurityPolicy)
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}
