import { type ComponentProps } from "solid-js"
import logo from "../assets/brand/arforge-logo.png"

export const Mark = (props: { class?: string }) => {
  return (
    <img
      data-component="logo-mark"
      classList={{ [props.class ?? ""]: !!props.class }}
      src={logo}
      alt=""
      aria-hidden="true"
    />
  )
}

export const Splash = (props: Pick<ComponentProps<"img">, "ref" | "class">) => {
  return (
    <img
      ref={props.ref}
      data-component="logo-splash"
      classList={{ [props.class ?? ""]: !!props.class }}
      src={logo}
      alt="Arforge"
    />
  )
}

export const Logo = (props: { class?: string }) => {
  return (
    <svg
      data-component="logo"
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 296 64"
      classList={{ [props.class ?? ""]: !!props.class }}
      role="img"
      aria-label="Arforge"
    >
      <image href={logo} width="64" height="64" />
      <text
        x="80"
        y="44"
        fill="var(--icon-strong-base)"
        font-family="'Geist Mono', 'SFMono-Regular', Consolas, monospace"
        font-size="38"
        font-weight="700"
        letter-spacing="1.5"
      >
        ARFORGE
      </text>
    </svg>
  )
}
