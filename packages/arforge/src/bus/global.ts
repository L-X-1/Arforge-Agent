import { EventEmitter } from "events"
import { Identifier } from "@/id/id"
import type { Database } from "@arforge-ai/core/database/database"

export type GlobalEvent = {
  directory?: string
  project?: string
  workspace?: string
  principal?: Database.Principal
  payload: any
}

class GlobalBusEmitter extends EventEmitter<{
  event: [GlobalEvent]
}> {
  override emit(eventName: "event", event: GlobalEvent): boolean {
    if (event.payload && typeof event.payload === "object" && !("id" in event.payload)) {
      event.payload.id = event.payload.syncEvent?.id ?? Identifier.create("evt", "ascending")
    }
    return super.emit(eventName, event)
  }
}

export const GlobalBus = new GlobalBusEmitter()
