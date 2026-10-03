import { ButtonV2 } from "@arforge-ai/ui/v2/button-v2"
import { Dialog, DialogBody, DialogFooter, DialogHeader, DialogTitle } from "@arforge-ai/ui/v2/dialog-v2"
import { DividerV2 } from "@arforge-ai/ui/v2/divider-v2"
import { TextInputV2 } from "@arforge-ai/ui/v2/text-input-v2"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import { type Component, Show, createEffect, createSignal, createUniqueId, onCleanup, onMount } from "solid-js"
import { useLanguage } from "@/context/language"
import { type ServerConnection } from "@/context/server"
import { useServerManagementController } from "../dialog-select-server"
import "./settings-v2.css"
import "./management-review.css"

export const DialogServerV2: Component<{
  mode: "add" | "edit"
  server?: ServerConnection.Http
}> = (props) => {
  const dialog = useDialog()
  const language = useLanguage()
  const controller = useServerManagementController({
    onSelect: () => dialog.close(),
    navigateOnAdd: false,
  })
  const [opened, setOpened] = createSignal(false)
  const formID = createUniqueId()

  onMount(() => {
    if (props.mode === "add") controller.startAdd()
    if (props.mode === "edit" && props.server) controller.startEdit(props.server)
    setOpened(true)
  })

  onCleanup(() => {
    controller.resetForm()
  })

  createEffect(() => {
    if (!opened()) return
    if (controller.isFormMode()) return
    dialog.close()
  })

  const keyDown = (event: KeyboardEvent) => {
    if (event.key !== "Enter" || event.isComposing || controller.formBusy()) return
    event.preventDefault()
    controller.submitForm()
  }

  const title = () =>
    props.mode === "add" ? language.t("dialog.server.add.title") : language.t("dialog.server.edit.title")

  const submitLabel = () => {
    if (controller.formBusy()) return language.t("dialog.server.add.checking")
    if (props.mode === "add") return language.t("dialog.server.add.button")
    return language.t("common.save")
  }

  return (
    <Dialog fit class="settings-v2-server-dialog">
      <DialogHeader hideClose={true}>
        <DialogTitle>{title()}</DialogTitle>
      </DialogHeader>
      <DividerV2 />
      <DialogBody class="flex w-full min-w-0 flex-1 flex-col px-4 pt-4 pb-2">
        <div class="flex w-full min-w-0 flex-col gap-6" aria-busy={controller.formBusy()}>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label for={`${formID}-url`} class="settings-v2-server-dialog-label">{language.t("dialog.server.add.url")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              id={`${formID}-url`}
              aria-label={language.t("dialog.server.add.url")}
              aria-describedby={controller.formError() ? `${formID}-error` : undefined}
              value={controller.formValue()}
              placeholder={language.t("dialog.server.add.placeholder")}
              invalid={!!controller.formError()}
              disabled={controller.formBusy()}
              autofocus
              onInput={(event) => controller.handleFormChange()(event.currentTarget.value)}
              onKeyDown={keyDown}
            />
            <Show when={controller.formError()}>
              <span id={`${formID}-error`} role="alert" class="settings-v2-server-dialog-error">{controller.formError()}</span>
            </Show>
          </div>
          <div class="flex w-full min-w-0 flex-col gap-2">
            <label for={`${formID}-name`} class="settings-v2-server-dialog-label">{language.t("dialog.server.add.name")}</label>
            <TextInputV2
              type="text"
              appearance="large"
              class="!w-full self-stretch"
              id={`${formID}-name`}
              aria-label={language.t("dialog.server.add.name")}
              value={controller.formName()}
              placeholder={language.t("dialog.server.add.namePlaceholder")}
              disabled={controller.formBusy()}
              onInput={(event) => controller.handleFormNameChange()(event.currentTarget.value)}
              onKeyDown={keyDown}
            />
          </div>
          <div class="grid w-full min-w-0 grid-cols-2 gap-4">
            <div class="flex min-w-0 flex-col gap-2">
              <label for={`${formID}-username`} class="settings-v2-server-dialog-label">{language.t("dialog.server.add.username")}</label>
              <TextInputV2
                type="text"
                appearance="large"
                class="!w-full self-stretch"
                id={`${formID}-username`}
              aria-label={language.t("dialog.server.add.username")}
              value={controller.formUsername()}
                placeholder={language.t("dialog.server.add.usernamePlaceholder")}
                disabled={controller.formBusy()}
                onInput={(event) => controller.handleFormUsernameChange()(event.currentTarget.value)}
                onKeyDown={keyDown}
              />
            </div>
            <div class="flex min-w-0 flex-col gap-2">
              <label for={`${formID}-password`} class="settings-v2-server-dialog-label">{language.t("dialog.server.add.password")}</label>
              <TextInputV2
                type="password"
                appearance="large"
                class="!w-full self-stretch"
                id={`${formID}-password`}
              aria-label={language.t("dialog.server.add.password")}
              value={controller.formPassword()}
                placeholder={language.t("dialog.server.add.passwordPlaceholder")}
                disabled={controller.formBusy()}
                onInput={(event) => controller.handleFormPasswordChange()(event.currentTarget.value)}
                onKeyDown={keyDown}
              />
            </div>
          </div>
        </div>
      </DialogBody>
      <DialogFooter>
        <ButtonV2 variant="neutral" disabled={controller.formBusy()} onClick={() => dialog.close()}>
          {language.t("common.cancel")}
        </ButtonV2>
        <ButtonV2 variant="contrast" disabled={controller.formBusy()} onClick={controller.submitForm}>
          {submitLabel()}
        </ButtonV2>
      </DialogFooter>
    </Dialog>
  )
}
