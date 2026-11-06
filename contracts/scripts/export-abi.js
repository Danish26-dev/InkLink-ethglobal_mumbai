// Copy the compiled ABI to the backend (services/backend/app/abi/InklinkRegistry.json).
// Run after `npm run compile`. The backend loads it from INKLINK_REGISTRY_ABI_PATH or this default.
const fs = require("fs");
const path = require("path");

const src = path.join(__dirname, "..", "artifacts", "contracts", "InklinkRegistry.sol", "InklinkRegistry.json");
const dst = path.join(__dirname, "..", "..", "services", "backend", "app", "abi", "InklinkRegistry.json");
const artifact = JSON.parse(fs.readFileSync(src, "utf8"));
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.writeFileSync(dst, JSON.stringify({ contractName: artifact.contractName, abi: artifact.abi }, null, 2) + "\n");
console.log(`ABI written to ${path.relative(process.cwd(), dst)} (${artifact.abi.length} entries)`);
