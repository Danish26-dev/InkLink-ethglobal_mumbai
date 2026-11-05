/**
 * External destinations. Leave empty until real URLs exist — the UI only
 * links to configured destinations and never invents one.
 */
export const LINKS = {
  app: import.meta.env.VITE_INKLINK_APP_URL || '',
  github: import.meta.env.VITE_INKLINK_GITHUB_URL || '',
  discord: import.meta.env.VITE_INKLINK_DISCORD_URL || '',
  contact: import.meta.env.VITE_INKLINK_CONTACT_EMAIL || '',
};
