import type { JSX } from '@solidjs/web';
import { Text, type TextProps } from './Text.js';

import './Section.css';

export interface SectionProps {
  title: string;
  options?: TextProps<'span'>['options'];
  children: JSX.Element;
}

export function Section(props: SectionProps): JSX.Element {
  return (
    <div data-solid-section>
      <Text data-solid-section-title options={{ weight: 'bold', font: 'sans', ...props.options }}>
        {props.title}
      </Text>
      <div data-solid-section-content>{props.children}</div>
    </div>
  );
}
