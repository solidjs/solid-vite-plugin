import { Button as BaseButton } from 'terracotta/button';
import './Button.css';

const Button: typeof BaseButton = (props) => (
  <BaseButton type="button" data-solid-button {...props} />
);

export default Button;
