import { NewSessionCompose } from "@/pages/new-session"

/**
 * Render beneath app.tsx's real draft providers, with its draftId in the URL.
 * Do not mount directly under the global home route: its SDK and prompt scopes
 * must come from the same draft that the submit owner promotes into a session.
 */
export function HomeCompose() {
  return <NewSessionCompose placement="home" />
}
