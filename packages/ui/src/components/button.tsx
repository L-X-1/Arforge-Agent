import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, type JSX, Show, splitProps } from "solid-js"
import { Spinner } from "./spinner"
import { Icon, IconProps } from "./icon"
import { useUIPresentation, type UIPresentation } from "../context/presentation"

export interface ButtonProps
  extends ComponentProps<typeof Kobalte>,
    Pick<ComponentProps<"button">, "class" | "classList" | "children"> {
  size?: "small" | "normal" | "large"
  variant?: "primary" | "secondary" | "ghost"
  icon?: IconProps["name"]
  busyLabel?: JSX.Element
  presentation?: UIPresentation
}

export function Button(props: ButtonProps) {
  const presentation = useUIPresentation(() => props.presentation)
  const [split, rest] = splitProps(props, [
    "variant",
    "size",
    "icon",
    "class",
    "classList",
    "busyLabel",
    "presentation",
  ])
  return (
    <Kobalte
      {...rest}
      data-component="button"
      data-presentation={presentation()}
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      data-icon={split.icon}
      data-busy-label={split.busyLabel !== undefined ? "" : undefined}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Show
        when={split.busyLabel !== undefined}
        fallback={
          <>
            <Show when={split.icon}>
              <Icon name={split.icon!} size="small" />
            </Show>
            {props.children}
          </>
        }
      >
        <span data-slot="button-state-label">
          <span
            aria-hidden={props["aria-busy"] === true || props["aria-busy"] === "true"}
            style={{ visibility: props["aria-busy"] === true || props["aria-busy"] === "true" ? "hidden" : "visible" }}
          >
            <Show when={split.icon}>
              <Icon name={split.icon!} size="small" />
            </Show>
            {props.children}
          </span>
          <span
            aria-hidden={props["aria-busy"] !== true && props["aria-busy"] !== "true"}
            style={{ visibility: props["aria-busy"] === true || props["aria-busy"] === "true" ? "visible" : "hidden" }}
          >
            <Spinner />
            {split.busyLabel}
          </span>
        </span>
      </Show>
    </Kobalte>
  )
}
