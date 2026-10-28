// Imported only by the 'use server' module, so the client graph never sees
// it: its stylesheet must still reach the production client build (#456).
import './panel-badge.css';

export function PanelBadge() {
  return <span id="panel-badge" class="panel-badge">server-styled</span>;
}
