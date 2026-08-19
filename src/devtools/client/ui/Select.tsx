import { Select as BaseSelect, SelectOption as BaseSelectOption } from 'terracotta/select';

import './Select.css';

export const Select: typeof BaseSelect = (props) => <BaseSelect data-solid-select {...props} />;
export const SelectOption: typeof BaseSelectOption = (props) => (
  <BaseSelectOption data-solid-select-option {...props} />
);
