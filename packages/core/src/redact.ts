/**
 * Remove common secret formats before durable storage or cross-runtime transfer.
 *
 * Keep this helper dependency-free so memory, learning, feedback, and governance
 * modules can reuse it without introducing service-layer dependency cycles.
 */
export function redact(value: string) {
  return value
    .replace(/\b(?:sk|pk)-[A-Za-z0-9_-]{20,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bghp_[A-Za-z0-9]{36}\b/g, "[REDACTED_SECRET]")
    .replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bxox[baprs]-[A-Za-z0-9-]{12,}\b/g, "[REDACTED_SECRET]")
    .replace(/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED_SECRET]")
    .replace(/\b(postgresql|postgres|mysql):\/\/([^\s:/]+):([^@\s]+)@/gi, "$1://[REDACTED_SECRET]:[REDACTED_SECRET]@")
    .replace(
      /\b(api[_-]?key|secret|token|password|passwd|pwd|authorization)\s*[:=]\s*[^\s,;]+/gi,
      "$1=[REDACTED_SECRET]",
    )
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b/gi, "Bearer [REDACTED_SECRET]")
}

/** Remove runtime-resolved secret values before a result crosses an output boundary. */
export function redactSecrets(value: string, secrets: ReadonlyArray<string>) {
  return secrets
    .filter((secret) => secret.length > 0)
    .reduce((current, secret) => current.replaceAll(secret, "[REDACTED_SECRET]"), redact(value))
}
