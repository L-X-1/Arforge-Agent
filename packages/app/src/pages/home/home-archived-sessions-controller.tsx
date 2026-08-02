import { type GlobalSession } from "@arforge-ai/sdk/v2/client"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { DialogFooter, DialogHeader, DialogTitleGroup, DialogV2 } from "@arforge-ai/ui/v2/dialog-v2"
import { useQuery, useQueryClient } from "@tanstack/solid-query"
import { createMemo, createSignal } from "solid-js"
import { useLanguage } from "@/context/language"
import { errorMessage } from "@/pages/layout/helpers"
import { sessionTitle } from "@/utils/session-title"
import { showToast } from "@/utils/toast"
import type { HomeController } from "./home-controller"
import {
  buildHomeArchivedSessionRecords,
  filterHomeArchivedSessionRecords,
  type HomeArchivedSessionRecord,
} from "./home-archived-sessions-model"

export function homeArchivedSessionsKey(server: string) {
  return ["home", "archived-sessions", server] as const
}

export function createHomeArchivedSessionsController(home: HomeController) {
  const language = useLanguage()
  const dialog = useDialog()
  const queryClient = useQueryClient()
  const [query, setQuery] = createSignal("")
  const [pending, setPending] = createSignal<{ id: string; action: "restore" | "delete" }>()
  const server = () => home.selection.value().server
  const load = useQuery(() => ({
    queryKey: homeArchivedSessionsKey(server()),
    enabled: !!home.server.focusedContext(),
    queryFn: async ({ signal }) => {
      const ctx = home.server.focusedContext()
      if (!ctx) return []
      const result = await ctx.sdk.client.experimental.session.list(
        { roots: true, archived: true, limit: 5_000 },
        { signal },
      )
      return buildHomeArchivedSessionRecords(result.data ?? [])
    },
    retry: false,
    staleTime: 15_000,
    refetchOnMount: true,
    refetchOnReconnect: true,
  }))
  const records = createMemo(() => load.data ?? [])
  const filtered = createMemo(() => filterHomeArchivedSessionRecords(records(), query()))

  const refreshActiveSessions = async () => {
    await queryClient.invalidateQueries({ queryKey: home.server.focusedSync().homeSessions.indexKey })
  }

  const fail = (cause: unknown, title: string) =>
    showToast({
      title,
      description: errorMessage(cause, title),
    })

  const restore = async (record: HomeArchivedSessionRecord) => {
    if (pending()) return
    const ctx = home.server.focusedContext()
    if (!ctx) return
    setPending({ id: record.session.id, action: "restore" })
    try {
      await ctx.sdk.client.session.update({
        sessionID: record.session.id,
        directory: record.session.directory,
        time: { archived: null },
      })
      await Promise.all([load.refetch(), refreshActiveSessions()])
      showToast({ title: language.t("home.archived.restored"), variant: "success" })
    } catch (cause) {
      fail(cause, language.t("home.archived.restoreFailed"))
    } finally {
      setPending()
    }
  }

  const remove = async (record: HomeArchivedSessionRecord) => {
    if (pending()) return
    const ctx = home.server.focusedContext()
    if (!ctx) return
    setPending({ id: record.session.id, action: "delete" })
    try {
      await ctx.sdk.client.session.delete({
        sessionID: record.session.id,
        directory: record.session.directory,
      })
      await load.refetch()
      showToast({ title: language.t("home.archived.deleted"), variant: "success" })
      dialog.close()
    } catch (cause) {
      fail(cause, language.t("session.delete.failed.title"))
    } finally {
      setPending()
    }
  }

  const confirmRemove = (record: HomeArchivedSessionRecord) => {
    const name = sessionTitle(record.session.title) || record.session.id
    void dialog.show(() => (
      <DialogV2 fit>
        <DialogHeader hideClose>
          <DialogTitleGroup
            title={language.t("home.archived.delete.title")}
            description={language.t("home.archived.delete.confirm", { name })}
          />
        </DialogHeader>
        <DialogFooter>
          <ButtonV2 variant="ghost" onClick={() => dialog.close()}>
            {language.t("common.cancel")}
          </ButtonV2>
          <ButtonV2 variant="danger" disabled={pending()?.id === record.session.id} onClick={() => void remove(record)}>
            {language.t("home.archived.delete.button")}
          </ButtonV2>
        </DialogFooter>
      </DialogV2>
    ))
  }

  return {
    copy: { language },
    data: {
      records,
      filtered,
      count: () => records().length,
      loading: () => load.isLoading,
      error: () => load.isError,
    },
    query: {
      value: query,
      set: setQuery,
    },
    session: {
      pending: (session: GlobalSession, action?: "restore" | "delete") => {
        const current = pending()
        return current?.id === session.id && (!action || current.action === action)
      },
      restore,
      confirmRemove,
    },
  }
}

export type HomeArchivedSessionsController = ReturnType<typeof createHomeArchivedSessionsController>
