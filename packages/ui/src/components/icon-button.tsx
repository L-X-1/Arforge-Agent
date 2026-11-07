import { Button as Kobalte } from "@kobalte/core/button"
import { type ComponentProps, splitProps } from "solid-js"
import { Icon, IconProps } from "./icon"
import { useUIPresentation, type UIPresentation } from "../context/presentation"

export interface IconButtonProps extends ComponentProps<typeof Kobalte> {
  icon: IconProps["name"]
  size?: "small" | "normal" | "large"
  iconSize?: IconProps["size"]
  variant?: "primary" | "secondary" | "ghost"
  presentation?: UIPresentation
}

export function IconButton(props: ComponentProps<"button"> & IconButtonProps) {
  const presentation = useUIPresentation(() => props.presentation)
  const [split, rest] = splitProps(props, ["variant", "size", "iconSize", "class", "classList", "presentation"])
  return (
    <Kobalte
      {...rest}
      data-component="icon-button"
      data-presentation={presentation()}
      data-icon={props.icon}
      data-size={split.size || "normal"}
      data-variant={split.variant || "secondary"}
      classList={{
        ...split.classList,
        [split.class ?? ""]: !!split.class,
      }}
    >
      <Icon name={props.icon} size={split.iconSize ?? (split.size === "large" ? "normal" : "small")} />
    </Kobalte>
  )
}
