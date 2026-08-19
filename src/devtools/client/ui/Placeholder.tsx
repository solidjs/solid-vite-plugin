import type { JSX } from '@solidjs/web';
import './Placeholder.css';

export interface PlaceholderProps {
  children?: JSX.Element;
}

export default function Placeholder(props: PlaceholderProps): JSX.Element {
  return <div data-solid-placeholder>{props.children}</div>;
}
