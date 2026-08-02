import { type ComponentProps } from "solid-js"
import logo from "../../assets/brand/arforge-logo.png"

export function WordmarkV2(props: Pick<ComponentProps<"svg">, "class">) {
  return (
    <svg
      data-component="wordmark-v2"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 720 129"
      classList={{ [props.class ?? ""]: !!props.class }}
      role="img"
      aria-label="Arforge"
    >
      <image href={logo} x="32" width="129" height="129" opacity="0.5" />
      <text
        x="190"
        y="99"
        fill="currentColor"
        opacity="0.16"
        font-family="'Geist Mono', 'SFMono-Regular', Consolas, monospace"
        font-size="112"
        font-weight="700"
        letter-spacing="3"
      >
        ARFORGE
      </text>
    </svg>
  )
}
