# Smart contract integration (0G Galileo)

## Current status: not configured

I searched the repository and the latest `origin/main` for Solidity files, Hardhat/Foundry projects, deployment scripts and ABIs, and found none. `InklinkShopRegistry` and `InklinkJobRegistry` are not in this repository, and none have been deployed from it.

So the backend does **not** invent addresses or function signatures. `services/backend/app/chain.py` provides:

- `status()`: reports `not_configured` and lists what is missing (RPC, chain id, addresses, ABI files, signer). The jury demo and `/api/v1/jury/status` show this.
- `queue(kind, jobId, data)`: records lifecycle facts in a local outbox (`state.json` → `chain_outbox`) with status `pending_not_configured`. Nothing is sent on-chain.
- `commitment(...)`: 0x-prefixed SHA-256 over references. These are the only values that go into the outbox.

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
