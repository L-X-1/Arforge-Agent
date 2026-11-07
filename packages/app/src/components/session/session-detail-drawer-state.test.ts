import { describe, expect, test } from "bun:test"
import { canRestoreSessionDetailFocus, createSessionDetailRegistry, sessionDetailInsets } from "./session-detail-drawer-state"

type Request = { scope: string; current: () => boolean }

describe("session detail source and closing lifetime", () => {
  test("falls back without a mounted host and rejects a stale source", () => {
    const changes: unknown[] = []
    const registry = createSessionDetailRegistry<Request>((entry) => changes.push(entry))
    expect(registry.present({scope:"server/project/session",current:()=>true})).toBe(false)
    const host = registry.register()
    expect(registry.present({scope:"server/project/session",current:()=>false})).toBe(false)
    expect(changes).toEqual([])
    host.dispose()
  })
  test("an old close cannot dismiss a new session opening", () => {
    let entry: {id:number;request:Request} | undefined
    const registry = createSessionDetailRegistry<Request>((value) => entry=value)
    const host=registry.register()
    expect(registry.present({scope:"server/project/session1",current:()=>true})).toBe(true)
    const oldID=entry!.id
    expect(registry.present({scope:"server/project/session2",current:()=>true})).toBe(true)
    expect(registry.close(oldID)).toBe(false)
    expect(entry!.request.scope).toBe("server/project/session2")
    expect(registry.close(entry!.id)).toBe(true)
    expect(entry).toBeUndefined()
    host.dispose()
  })
  test("server, project, session or owner invalidation drops the old content", () => {
    for (const scope of ["server", "project", "session", "closed-owner"]) {
      let live=true
      let entry: unknown
      const registry=createSessionDetailRegistry<Request>((value)=>entry=value)
      const host=registry.register()
      registry.present({scope,current:()=>live})
      expect(entry).toBeDefined()
      live=false
      registry.invalidate()
      expect(entry).toBeUndefined()
      host.dispose()
    }
  })
  test("disposing another host does not close the active host's request", () => {
    let entry: unknown
    const registry=createSessionDetailRegistry<Request>((value)=>entry=value)
    const old=registry.register()
    const active=registry.register()
    registry.present({scope:"server/project/session",current:()=>true})
    old.dispose()
    expect(entry).toBeDefined()
    active.dispose()
    expect(entry).toBeUndefined()
    expect(registry.present({scope:"server/project/session",current:()=>true})).toBe(false)
  })
  test("closing or replacing an opening cancels its pending full-dialog continuation", () => {
    let entry: {id:number} | undefined
    const registry=createSessionDetailRegistry<Request & {onClose:()=>void}>((value)=>entry=value)
    const host=registry.register()
    let oldLive=true
    registry.present({scope:"first",current:()=>oldLive,onClose:()=>{oldLive=false}})
    const oldID=entry!.id
    let nextLive=true
    registry.present({scope:"next",current:()=>nextLive,onClose:()=>{nextLive=false}})
    expect(oldLive).toBe(false)
    expect(registry.close(oldID)).toBe(false)
    expect(nextLive).toBe(true)
    registry.close(entry!.id)
    expect(nextLive).toBe(false)
    host.dispose()
  })
  test("measures top and bottom titlebars instead of imposing one fixed edge", () => {
    expect(sessionDetailInsets({layoutHeight:800,viewportTop:0,viewportHeight:800,bottomPreference:false,
      header:{top:0,bottom:52,height:52}})).toEqual({top:52,bottom:0})
    expect(sessionDetailInsets({layoutHeight:800,viewportTop:0,viewportHeight:800,bottomPreference:true,
      header:{top:748,bottom:800,height:52}})).toEqual({top:0,bottom:52})
  })
  test("the visual viewport excludes keyboard-covered space without double-counting a hidden bottom bar", () => {
    expect(sessionDetailInsets({layoutHeight:800,viewportTop:20,viewportHeight:440,bottomPreference:true,
      header:{top:748,bottom:800,height:52}})).toEqual({top:20,bottom:340})
    expect(sessionDetailInsets({layoutHeight:800,viewportTop:0,viewportHeight:800,bottomPreference:true})).toEqual({top:0,bottom:44})
  })
  test("close restoration respects a user's newly focused control", () => {
    const close=document.createElement("button")
    const next=document.createElement("button")
    document.body.append(close,next)
    close.focus()
    expect(canRestoreSessionDetailFocus(close)).toBe(true)
    close.remove()
    expect(canRestoreSessionDetailFocus(close)).toBe(true)
    next.focus()
    expect(canRestoreSessionDetailFocus(close)).toBe(false)
    next.remove()
  })
})
