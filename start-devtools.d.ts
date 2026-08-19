declare module "virtual:solid-devtools" {
  import type { JSX } from "@solidjs/web";

  export function DevToolbar(props: { children?: JSX.Element }): JSX.Element;
}
