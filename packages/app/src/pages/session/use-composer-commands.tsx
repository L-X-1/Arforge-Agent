import { useCommand, type CommandOption } from "@/context/command"
import { useLanguage } from "@/context/language"
import { useLocal } from "@/context/local"
import { showToast } from "@/utils/toast"
import { useDialog } from "@arforge-ai/ui/context/dialog"
import {
  captureModelComposerFocus,
  captureModelEntry,
  resolveModelBinding,
  type BoundModelSelection,
} from "@/components/prompt-input/model-binding"
import { useSessionLayout } from "./session-layout"
import { createSessionOwnership } from "./session-ownership"

const withCategory = (category: string) => {
  return (option: Omit<CommandOption, "category">): CommandOption => ({
    ...option,
    category,
  })
}

export const useComposerCommands = (input: { model?: BoundModelSelection } = {}) => {
  const command = useCommand()
  const dialog = useDialog()
  const language = useLanguage()
  const local = useLocal()
  const { sessionKey } = useSessionLayout()
  const sessionOwnership = createSessionOwnership(sessionKey)
  const model: BoundModelSelection = input.model ?? local.model
  const modelBinding = () => resolveModelBinding(model, local.model, local.modelSelection)
  const modelCommand = withCategory(language.t("command.category.model"))
  const agentCommand = withCategory(language.t("command.category.agent"))

  const chooseModel = async () => {
    const owner = sessionOwnership.capture()
    const entry = captureModelEntry({ model: () => model, binding: modelBinding })
    const restoreFocus = captureModelComposerFocus(
      document.querySelector<HTMLElement>('[data-component="prompt-input"]'),
      entry.current,
    )
    const restoreComposer = () => {
      // Defer past dialog teardown, then check both session ownership and binding scope.
      requestAnimationFrame(() => owner.run(restoreFocus))
    }
    const { DialogSelectModel } = await import("@/components/dialog-select-model")
    owner.run(() => {
      if (!entry.current()) return
      void dialog.show(
        () => <DialogSelectModel model={entry.model} binding={entry.binding} />,
        restoreComposer,
      )
    })
  }

  command.register("composer", () => [
    modelCommand({
      id: "model.choose",
      title: language.t("command.model.choose"),
      description: language.t("command.model.choose.description"),
      keybind: "mod+'",
      slash: "model",
      onSelect: chooseModel,
    }),
    modelCommand({
      id: "model.variant.cycle",
      title: language.t("command.model.variant.cycle"),
      description: language.t("command.model.variant.cycle.description"),
      keybind: "shift+mod+d",
      onSelect: async () => {
        try {
          await model.variant.cycle()
        } catch (error) {
          showToast({
            title: language.t("common.requestFailed"),
            description: error instanceof Error ? error.message : String(error),
          })
        }
      },
    }),
    agentCommand({
      id: "agent.cycle",
      title: language.t("command.agent.cycle"),
      description: language.t("command.agent.cycle.description"),
      keybind: "mod+.",
      slash: "agent",
      disabled: !local.agent.visible(),
      onSelect: () => local.agent.move(1),
    }),
    agentCommand({
      id: "agent.cycle.reverse",
      title: language.t("command.agent.cycle.reverse"),
      description: language.t("command.agent.cycle.reverse.description"),
      keybind: "shift+mod+.",
      disabled: !local.agent.visible(),
      onSelect: () => local.agent.move(-1),
    }),
  ])
}
