// Hardhat config for InklinkRegistry.
// Deployment reads everything from the environment; nothing secret lives in this file.
//   ZERO_G_GALILEO_RPC_URL               e.g. https://evmrpc-testnet.0g.ai (check docs.0g.ai)
//   ZERO_G_GALILEO_CHAIN_ID              the chain id the RPC reports (eth_chainId); deploy refuses a mismatch
//   ZERO_G_GALILEO_DEPLOYER_PRIVATE_KEY  deployer key (your machine / CI only; never the backend)
require("@nomicfoundation/hardhat-ethers");
require("@nomicfoundation/hardhat-chai-matchers");

const rpc = process.env.ZERO_G_GALILEO_RPC_URL || "";
const key = process.env.ZERO_G_GALILEO_DEPLOYER_PRIVATE_KEY || "";
const chainId = process.env.ZERO_G_GALILEO_CHAIN_ID ? Number(process.env.ZERO_G_GALILEO_CHAIN_ID) : undefined;

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "cancun" },
  },
  networks: {
    hardhat: {},
    ...(rpc ? { galileo: { url: rpc, chainId, accounts: key ? [key] : [] } } : {}),
  },
};
