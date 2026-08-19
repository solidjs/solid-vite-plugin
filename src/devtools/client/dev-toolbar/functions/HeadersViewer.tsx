import { For } from 'solid-js';
import { PropertySeparator, SerovalValue } from './SerovalValue.js';

import './HeadersViewer.css';
import { Text } from '../../ui/Text.js';

interface HeadersViewerProps {
  headers: Headers;
}

export function HeadersViewer(props: HeadersViewerProps) {
  return (
    <div data-solid-headers-viewer data-solid-properties>
      <For each={Array.from(props.headers.entries())}>
        {([key, value]) => (
          <div data-solid-property>
            <Text options={{ size: 'xs', weight: 'semibold', wrap: 'nowrap' }}>{key}</Text>
            <PropertySeparator />
            <SerovalValue value={value} />
          </div>
        )}
      </For>
    </div>
  );
}
