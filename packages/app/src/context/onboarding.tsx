import { createSimpleContext } from "@arforge-ai/ui/context"
import { createStore } from "solid-js/store"
import { Persist, persisted } from "@/utils/persist"

export const ARFORGE_ONBOARDING_VERSION = 1

export const { use: useOnboarding, provider: OnboardingProvider } = createSimpleContext({
  name: "Onboarding",
  gate: false,
  init: () => {
    const [state, setState, , ready] = persisted(
      Persist.global("product-onboarding.v1"),
      createStore({ version: ARFORGE_ONBOARDING_VERSION, dismissed: false }),
    )

    return {
      ready,
      visible: () => ready() && !state.dismissed,
      dismiss() {
        setState({ version: ARFORGE_ONBOARDING_VERSION, dismissed: true })
      },
      restart() {
        setState({ version: ARFORGE_ONBOARDING_VERSION, dismissed: false })
      },
    }
  },
})
