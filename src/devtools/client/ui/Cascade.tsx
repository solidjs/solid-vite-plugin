import { Select as BaseSelect, SelectOption as BaseSelectOption } from 'terracotta/select';

import './Cascade.css';

export const Cascade: typeof BaseSelect = (props) => <BaseSelect data-solid-cascade {...props} />;
export const CascadeOption: typeof BaseSelectOption = (props) => (
  <BaseSelectOption data-solid-cascade-option {...props} />
);
