// Metro config — resolve the workspace package @inklink/shared-schemas, a sibling
// `file:` dependency living outside this app's node_modules. We watch its folder
// and map the package name to its directory so Metro reads its compiled `main`
// (dist/index.js). Run `npm run build` in packages/shared-schemas after changing it.
const { getDefaultConfig } = require("expo/metro-config");
const path = require("path");

const projectRoot = __dirname;
const sharedSchemas = path.resolve(projectRoot, "../../packages/shared-schemas");

const config = getDefaultConfig(projectRoot);

config.watchFolders = [sharedSchemas];
config.resolver.extraNodeModules = {
  "@inklink/shared-schemas": sharedSchemas,
};
config.resolver.nodeModulesPaths = [path.resolve(projectRoot, "node_modules")];

// expo-sqlite's web build imports a .wasm binary; Metro must treat it as an asset.
if (!config.resolver.assetExts.includes("wasm")) config.resolver.assetExts.push("wasm");
module.exports = config;
