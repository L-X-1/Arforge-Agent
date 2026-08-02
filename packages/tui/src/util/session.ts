export function isDefaultTitle(title: string) {
  return /^(?:新会话|子会话|New session|Child session) - \d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(title)
}
