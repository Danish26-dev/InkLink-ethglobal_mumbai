#pragma once

// Deployment settings. Nothing here is secret, so this file is committed.
// The device token is NOT here: it lives in secrets.h (git-ignored).

// Wi-Fi. The Cirkit Designer simulator exposes an open network called "CirkitWifi".
// For a real shop, put your own network here (or load it another way).
#define CFG_WIFI_SSID     "CirkitWifi"
#define CFG_WIFI_PASSWORD ""

// Public HTTPS origin of the Inklink backend, no trailing slash.
#define CFG_BACKEND_URL   "https://inklink-backend-765131918851.asia-south1.run.app"

// Must be a shop the backend knows. A single-shop backend uses its SHOP_ID setting
// (default "shop_001"). Unknown shops get 404 SHOP_NOT_FOUND on the heartbeat.
#define CFG_SHOP_ID       "shop_001"

// Letters, digits, "_", "." and "-" only (the backend rejects anything else).
#define CFG_DEVICE_ID     "esp32-cirkit-01"
