/**
 * Destinations. The Inklink app is served on the same origin as this landing
 * page (/app, /shop, /demo), so those default to same-origin paths; set the
 * VITE_INKLINK_*_URL variables to point somewhere else. Community links stay
 * empty until real URLs exist — the UI never invents one.
 */
export const LINKS = {
  app: import.meta.env.VITE_INKLINK_APP_URL || '/app',
  shop: import.meta.env.VITE_INKLINK_SHOP_URL || '/shop',
  agent: import.meta.env.VITE_INKLINK_AGENT_URL || '/shop/agent',
  demo: import.meta.env.VITE_INKLINK_DEMO_URL || '/demo',
  github: import.meta.env.VITE_INKLINK_GITHUB_URL || '',
  discord: import.meta.env.VITE_INKLINK_DISCORD_URL || '',
  contact: import.meta.env.VITE_INKLINK_CONTACT_EMAIL || '',
};

/** Same-origin paths open in this tab; absolute external URLs open a new tab. */
export function openLink(url: string) {
  if (!url) return;
  if (/^https?:\/\//i.test(url) && new URL(url).origin !== window.location.origin) {
    window.open(url, '_blank', 'noopener,noreferrer');
  } else {
    window.location.assign(url);
  }
}
