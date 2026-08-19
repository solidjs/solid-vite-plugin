import { Text } from '../../ui/Text.js';
import './SerovalValue.css';

interface SerovalValueProps {
  value: string | number | boolean | undefined | null;
}

export function SerovalValue(props: SerovalValueProps) {
  return (
    <Text data-solid-seroval-value options={{ size: 'xs', weight: 'semibold', wrap: 'nowrap' }}>
      {`${props.value}`}
    </Text>
  );
}

export function PropertySeparator() {
  return <Text options={{ size: 'xs', weight: 'semibold', wrap: 'nowrap' }}>:</Text>;
}
