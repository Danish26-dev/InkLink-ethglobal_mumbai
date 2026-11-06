# Smart contract integration (0G Galileo)

## Current status: implemented and tested locally, NOT deployed yet

- **The contract:** `contracts/contracts/InklinkRegistry.sol` is a single registry for shops, jobs and lifecycle records. Only hashes go on-chain, and only authorised writers can write.
  - The Hardhat project lives in `contracts/`, with 5 tests on the local Hardhat network.
  - The deploy script refuses to run if the RPC's chain id doesn't match.
  - The ABI is exported to `services/backend/app/abi/InklinkRegistry.json`.
- **Not deployed:** no address exists yet, and none is invented. See `contracts/README.md` for how to deploy.
- **The backend sender:** `services/backend/app/chain.py` sends queued records to the registry once the RPC, chain id, address and writer key are configured. It checks that the RPC's chain id matches before sending anything. For each record it stores the real receipt: tx hash, block number, and `confirmed` or `reverted`.
  - Until it is configured, records stay `pending_not_configured` and nothing is sent.
  - The sender is unit-tested against a fake JSON-RPC that decodes every signed transaction. That is not on-chain proof.
- **Where to see it:**
  - `GET /api/v1/chain/status` (public)
  - each job's `chain` block in `GET /api/v1/jobs/{id}`
  - the "On-chain audit" card in the customer app, with explorer links only for real receipts

## What is queued today, and when

| Record | Queued when | Data (hashes and references only) |
|---|---|---|
| `job_registered` | a customer job is created (not demo) | `jobCommitment`, `shopId` |
| `document_committed` | upload | `documentSha256` (file hash; never the file, name or text) |
| `quote_referenced` | quote created | `quoteCommitment` |
| `payment_verified` | **only after** the signed Hedera settlement callback is verified | `hederaTxCommitment`, `network` |
| `execution_authorized` | the printer adapter accepted a real submission | `jobCommitment` |
| `job_completed` | the shop confirms completion | `jobCommitment` |
| `shop_registered`, `job_failed` | reserved | — |

Never on-chain: documents, file names, PII, printing instructions, credentials, gateway or private network addresses.

## Boundaries

- **0G Galileo:** shop registry, job registry, lifecycle records.
- **Hedera:** x402 HTS-USDC settlement (payment agent) and HCS audit. There is no payment contract on 0G.
- **0G Private Computer:** private AI inference (backend gateway).
- **0G Storage:** optional, for future decentralized storage. Documents currently stay on the shop backend.

## To finish the integration

1. Add the contracts and their deployment scripts to the repo (for example `contracts/`), and deploy to Galileo with `ZERO_G_GALILEO_DEPLOYER_PRIVATE_KEY` from your machine or CI, never from the backend.
2. Put the compiled ABI JSON files on the backend and set `INKLINK_SHOP_REGISTRY_ABI_PATH` and `INKLINK_JOB_REGISTRY_ABI_PATH`.
3. Set `ZERO_G_GALILEO_RPC_URL`, `ZERO_G_GALILEO_CHAIN_ID`, both `*_ADDRESS` variables and `ZERO_G_GALILEO_SIGNER_PRIVATE_KEY` (a dedicated low-privilege signer, kept in a secret manager).
4. Implement `chain._send()` with the ABI's real function names, and an outbox worker that sends `pending` records and stores the transaction hash. Then add event reads for querying on-chain job records.

`status()` reports `configured_unverified` once every value is present. Records stay queued until the sender exists.
