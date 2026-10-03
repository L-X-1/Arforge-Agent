import { createComponent, createContext, useContext, type ParentProps } from "solid-js"

export function createSimpleContext<T, Props extends Record<string, any>>(input: {
  name: string
  init: ((input: Props) => T) | (() => T)
}) {
  const ctx = createContext<T>()

  return {
    context: ctx,
    provider: (props: ParentProps<Props>) => {
      const init = input.init(props)
      return createComponent(ctx.Provider, {
        value: init,
        get children() {
          return props.children
        },
      })
    },
    use() {
      const value = useContext(ctx)
      if (!value) throw new Error(`${input.name} context must be used within a context provider`)
      return value
    },
  }
}
