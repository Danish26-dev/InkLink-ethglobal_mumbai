// Deploy InklinkRegistry to 0G Galileo. Run from your machine or CI, never from the backend:
//   ZERO_G_GALILEO_RPC_URL=... ZERO_G_GALILEO_CHAIN_ID=... ZERO_G_GALILEO_DEPLOYER_PRIVATE_KEY=... \
//   INKLINK_REGISTRY_WRITER=0x<backend signer address> npm run deploy:galileo
// Refuses to run if the RPC's chain id differs from ZERO_G_GALILEO_CHAIN_ID (no silent
// deployment to a different network). Prints the address, tx hash and block to record.
const { ethers, network } = require("hardhat");

async function main() {
  const expected = process.env.ZERO_G_GALILEO_CHAIN_ID;
  const writer = process.env.INKLINK_REGISTRY_WRITER || "";
  if (!expected) throw new Error("Set ZERO_G_GALILEO_CHAIN_ID (the chain id of the 0G Galileo RPC).");
  if (!ethers.isAddress(writer)) throw new Error("Set INKLINK_REGISTRY_WRITER to the backend signer's address.");
  const { chainId } = await ethers.provider.getNetwork();
  if (chainId !== BigInt(expected)) {
    throw new Error(`RPC reports chain id ${chainId}, expected ${expected}. Refusing to deploy to another network.`);
  }
  const [deployer] = await ethers.getSigners();
  console.log(`network ${network.name} chainId ${chainId} deployer ${deployer.address}`);
  const factory = await ethers.getContractFactory("InklinkRegistry");
  const contract = await factory.deploy(writer);
  const tx = contract.deploymentTransaction();
  const receipt = await tx.wait();
  console.log(JSON.stringify({
    contract: "InklinkRegistry",
    address: await contract.getAddress(),
    chainId: chainId.toString(),
    deployTx: tx.hash,
    block: receipt.blockNumber,
    writer,
  }, null, 2));
}

main().catch((err) => {
  console.error(err.message || err);
  process.exitCode = 1;
});
