# InklinkRegistry (0G Galileo)

A hash-only, tamper-evident audit trail for Inklink print jobs. The backend records each
lifecycle fact when it becomes true. Each fact is a 32-byte commitment: the SHA-256 of a
reference, or of the document bytes. Anyone can read the records, and `verifyDocument`
checks a document's integrity against them.

| Kind | When the backend records it | Commitment |
|---|---|---|
| `registerShop` | before the shop's first job | `sha256("inklink-shop" \| shopId)` |
| `registerJob` | job created | `sha256("inklink-job" \| jobId)` |
| `DocumentCommitted` | document uploaded | SHA-256 of the file bytes |
| `QuoteReferenced` | quote issued | commitment of quote id, amount, expiry |
| `PaymentVerified` | **only after** the HMAC-signed Hedera settlement callback is verified | commitment of the Hedera tx id |
| `ExecutionAuthorized` | backend submitted the job to the printer | job commitment |
| `JobCompleted` | shop or device confirmed completion | job commitment |

Payments stay on Hedera (x402 and HTS-USDC). This contract only references them by hash.

Nothing personal or secret goes on-chain: no documents, file names, prompts, prices in clear,
keys or addresses.

## Build and test

```bash
cd contracts
npm ci
npm test              # Hardhat local network; 5 tests
npm run export-abi    # writes services/backend/app/abi/InklinkRegistry.json
```

## Deploy (your machine or CI, never the backend)

```bash
export ZERO_G_GALILEO_RPC_URL=https://evmrpc-testnet.0g.ai      # confirm on docs.0g.ai
export ZERO_G_GALILEO_CHAIN_ID=<value of eth_chainId for that RPC>
export ZERO_G_GALILEO_DEPLOYER_PRIVATE_KEY=<funded deployer key>  # faucet.0g.ai
export INKLINK_REGISTRY_WRITER=<address of the backend signer>
npm run deploy:galileo
```

The script refuses to deploy if the RPC reports a different chain id. It prints the contract
address, the deployment tx hash and the block number. Look them up on
`https://chainscan-galileo.0g.ai`.

To check the chain id first:

```bash
curl -s -X POST $ZERO_G_GALILEO_RPC_URL -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

## Connect the backend

Use a separate writer key, not the deployer key. The writer needs a little testnet 0G for gas.

1. Add these to `deploy/gcp/env/staging.env`:
   - `ZERO_G_GALILEO_RPC_URL`
   - `ZERO_G_GALILEO_CHAIN_ID`
   - `INKLINK_REGISTRY_ADDRESS`
2. Store the writer key:
   `ONLY=ZERO_G_GALILEO_SIGNER_PRIVATE_KEY bash deploy/gcp/05-configure-secrets.sh`
3. Redeploy the backend:
   `SKIP_PAYMENT_AGENT=1 bash deploy/gcp/04-deploy-services.sh`

Every 10 s the backend sends the queued records in order and stores each real receipt:
tx hash, block number and status. A record that reverts or fails is shown as such, and is
never shown as on-chain.

- `GET /api/v1/chain/status` gives the contract, network and record counts.
- Each job view carries `chain.records`, with explorer links.
