import { LINKS, openLink } from '../lib/config';

/** Launch Inklink: opens the application portal (Customer · Shopkeeper · ETHGlobal Jury). */
export function launchInklink() {
  openLink(LINKS.portal);
}

/** Open the customer app directly (no login, no wallet). */
export function openCustomerApp() {
  openLink(LINKS.app);
}
