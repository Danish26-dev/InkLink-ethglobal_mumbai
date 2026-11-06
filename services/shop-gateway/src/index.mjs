#!/usr/bin/env node
/**
 * Entry point: `npm start` (reads the environment; see .env.example).
 * Node 22+ (global fetch, --env-file). No third-party dependencies.
 */
import { createGateway, loadConfig } from './gateway.mjs';

let cfg;
try {
  cfg = loadConfig();
} catch (err) {
  console.error(`[shop-gateway] ${err.message}`);
  process.exit(2);
}

const gateway = createGateway(cfg);
const display = gateway.createDisplayServer();
display.listen(cfg.displayPort, cfg.displayHost, () => {
  console.log(`[shop-gateway] display status on http://${cfg.displayHost}:${cfg.displayPort}/display`
    + (cfg.displayToken ? ' (token required)' : ''));
});

function shutdown(signal) {
  console.log(`[shop-gateway] ${signal} received, stopping`);
  gateway.stop();
  display.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
process.once('SIGTERM', () => shutdown('SIGTERM'));
process.once('SIGINT', () => shutdown('SIGINT'));

gateway.run();
