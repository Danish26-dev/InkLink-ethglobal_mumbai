/**
 * Extends app.json. Team decision: plain HTTP to the shop's LOCAL gateway is allowed
 * in development builds only. Production must use gateway TLS with certificate /
 * public-key pinning, and should be built with INKLINK_ENV=production, which turns
 * cleartext traffic back OFF.
 *
 * Note: Expo Go ignores native config and permits cleartext, so a working Expo Go
 * session says nothing about production readiness.
 */
module.exports = ({ config }) => {
  const allowLocalHttp = process.env.INKLINK_ENV !== "production";

  const plugins = (config.plugins ?? []).filter(
    (p) => (Array.isArray(p) ? p[0] : p) !== "expo-build-properties",
  );
  plugins.push([
    "expo-build-properties",
    { android: { usesCleartextTraffic: allowLocalHttp } },
  ]);

  const infoPlist = {
    ...(config.ios?.infoPlist ?? {}),
    NSLocalNetworkUsageDescription:
      "Inklink connects to the print shop's gateway on your local network to send your document.",
  };
  if (allowLocalHttp) {
    // Allows HTTP to local/private addresses only, without disabling ATS globally.
    infoPlist.NSAppTransportSecurity = { NSAllowsLocalNetworking: true };
  } else {
    delete infoPlist.NSAppTransportSecurity;
  }

  return { ...config, plugins, ios: { ...config.ios, infoPlist } };
};
