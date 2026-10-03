// Capability URLs are transient credentials, not diagnostic identifiers.
export const redactPreviewResourceURLs = (value: string) => value.replace(
  /http:\/\/127\.0\.0\.2:\d+\/resources\/[a-f0-9]{64}(?=\/|\b)/gi,
  "http://127.0.0.2:[port]/resources/[redacted]",
)
