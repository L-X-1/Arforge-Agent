import { getFilename } from "@arforge-ai/core/util/path"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { useMutation } from "@tanstack/solid-query"
import { createMemo } from "solid-js"
import { createStore } from "solid-js/store"
import { useGlobal } from "@/context/global"
import { type LocalProject } from "@/context/layout"
import { captureProjectMetadata, resolveProjectMetadataID, updateProjectMetadata } from "@/context/project-metadata"
import { ServerConnection, useServer } from "@/context/server"
import { useServerSDK } from "@/context/server-sdk"

export function createEditProjectModel(props: { project: LocalProject; server: ServerConnection.Any }) {
  const dialog = useDialog()
  const global = useGlobal()
  const server = useServer()
  const ownerSDK = useServerSDK()
  const selectedSDK = ownerSDK()
  const conn = props.server
  const key = ServerConnection.key(conn)
  const source = global.ensureServerCtx(conn)
  const origin = captureProjectMetadata(
    source,
    server.projects.forServer(key).list,
    props.project,
    () =>
      ownerSDK.isAlive() &&
      ownerSDK() === selectedSDK &&
      global.servers.list().some((item) => ServerConnection.key(item) === key) &&
      global.ensureServerCtx(conn) === source,
  )
  const folderName = createMemo(() => getFilename(props.project.worktree))
  const defaultName = createMemo(() => props.project.name || folderName())
  const [store, setStore] = createStore({
    name: defaultName(),
    color: props.project.icon?.color,
    iconOverride: props.project.icon?.override,
    startup: props.project.commands?.start ?? "",
    dragOver: false,
    iconHover: false,
  })
  let iconInput: HTMLInputElement | undefined

  function selectFile(file: File) {
    if (!file.type.startsWith("image/")) return
    const reader = new FileReader()
    reader.onload = (event) => {
      const result = event.target?.result
      if (typeof result !== "string") return
      setStore("iconOverride", result)
      setStore("iconHover", false)
    }
    reader.readAsDataURL(file)
  }

  function drop(event: DragEvent) {
    event.preventDefault()
    setStore("dragOver", false)
    const file = event.dataTransfer?.files[0]
    if (file) selectFile(file)
  }

  function dragOver(event: DragEvent) {
    event.preventDefault()
    setStore("dragOver", true)
  }

  function dragLeave() {
    setStore("dragOver", false)
  }

  function inputChange(event: Event) {
    const file = (event.currentTarget as HTMLInputElement).files?.[0]
    if (file) selectFile(file)
  }

  function iconClick() {
    if (store.iconOverride && store.iconHover) {
      setStore("iconOverride", "")
      return
    }
    iconInput?.click()
  }

  const save = useMutation(() => ({
    mutationFn: async (input: {
      dialogID: string
      name: string
      start: string
      color: string | undefined
      override: string | undefined
    }) => {
      if (!origin) return
      const { dialogID, name, start, color, override } = input
      const current = () => dialog.active?.id === dialogID && origin.current()
      if (!current()) return
      const request = { ...origin, current }
      const id = request.id ?? (await resolveProjectMetadataID(request))
      if (!id || !current()) return

      if (id !== "global") {
        const result = await updateProjectMetadata(
          { ...request, id },
          {
            name,
            icon: { color: color || "", override: override || "" },
            commands: { start },
          },
        )
        if (!result || !current()) return
        if (result === "saved") {
          const cached = origin.sync.data.project.find((item) => item.id === id)
          const savedOverride = cached ? cached.icon?.override : override
          origin.sync.project.icon(origin.worktree, savedOverride || undefined)
        }
        if (current()) dialog.close()
        return
      }

      origin.sync.project.meta(origin.worktree, {
        name,
        icon: { color: color || undefined, override: override || undefined },
        commands: { start: start || undefined },
      })
      if (current()) dialog.close()
    },
  }))

  function submit(event: SubmitEvent) {
    event.preventDefault()
    const active = dialog.active
    if (save.isPending || !active || !origin?.current()) return
    const name = store.name.trim()
    save.mutate({
      dialogID: active.id,
      name: name === folderName() ? "" : name,
      start: store.startup.trim(),
      color: store.color,
      override: store.iconOverride,
    })
  }

  return {
    store,
    setStore,
    folderName,
    defaultName,
    save,
    submit,
    drop,
    dragOver,
    dragLeave,
    inputChange,
    iconClick,
    close() {
      dialog.close()
    },
    setIconInput(input: HTMLInputElement) {
      iconInput = input
    },
  }
}
