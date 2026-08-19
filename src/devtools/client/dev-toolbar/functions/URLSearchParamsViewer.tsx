import { createMemo, For, Loading, Show } from 'solid-js';
import type { JSX } from '@solidjs/web';
import { Section } from '../../ui/Section.js';
import { PropertySeparator, SerovalValue } from './SerovalValue.js';

interface URLSearchParamsViewerInnerProps {
  source: URLSearchParams;
}

function URLSearchParamsViewerInner(props: URLSearchParamsViewerInnerProps): JSX.Element {
  return (
    <Section title="URLSearchParams" options={{ size: 'sm' }}>
      <div data-solid-properties>
        <For each={Array.from(props.source.entries())}>
          {([key, value]) => (
            <div data-solid-property>
              <SerovalValue value={`"${key}"`} />
              <PropertySeparator />
              <SerovalValue value={`"${JSON.stringify(value)}"`} />
            </div>
          )}
        </For>
      </div>
    </Section>
  );
}

export interface URLSearchParamsViewerProps {
  source: URLSearchParams | Promise<URLSearchParams>;
}

export function URLSearchParamsViewer(props: URLSearchParamsViewerProps) {
  const data = createMemo(async () => await props.source);

  return (
    <Loading>
      <Show when={data()} keyed>
        {(current) => <URLSearchParamsViewerInner source={current} />}
      </Show>
    </Loading>
  );
}
