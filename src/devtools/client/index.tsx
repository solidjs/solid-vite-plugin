import { render } from '@solidjs/web';
import { pushServerFunctionCall } from './dev-toolbar/functions/tracker.js';
import { DevToolbar } from './dev-toolbar/index.js';

let dispose: (() => void) | undefined;

export { DevToolbar, pushServerFunctionCall };

export function mountDevToolbar(): () => void {
  if (dispose) return dispose;

  const host = document.createElement('div');
  host.dataset.solidDevToolbarRoot = '';
  document.body.append(host);
  const unmount = render(() => <DevToolbar />, host);

  dispose = () => {
    unmount();
    host.remove();
    dispose = undefined;
  };
  return dispose;
}
