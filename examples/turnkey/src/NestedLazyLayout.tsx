import type { ParentProps } from 'solid-js';

export default function NestedLazyLayout(props: ParentProps) {
  return <section id="nested-layout">{props.children}</section>;
}
