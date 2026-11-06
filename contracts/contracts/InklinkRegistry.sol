// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title InklinkRegistry
/// @notice Tamper-evident audit trail for Inklink print jobs on 0G Galileo.
///
/// Only commitments go on-chain: 32-byte hashes of job/shop references, the uploaded
/// document (SHA-256 of the file bytes), quotes and the Hedera settlement transaction id.
/// Never documents, file names, prompts, personal data, prices in clear, keys or addresses.
///
/// Hedera remains the payment layer (x402 / HTS-USDC). This contract only records that the
/// Inklink backend verified a settlement, by hash, so anyone can later check that a printed
/// job's document, quote and payment references match what was recorded at the time.
///
/// Writes come from Inklink backend signers authorised by the owner; reads are public.
contract InklinkRegistry {
    /// Lifecycle facts, in the order a job normally moves through them.
    enum Kind {
        JobRegistered,       // 0  job created at a shop
        DocumentCommitted,   // 1  document hash (SHA-256 of the uploaded file)
        QuoteReferenced,     // 2  quote commitment
        PaymentVerified,     // 3  Hedera settlement verified by the backend (tx id commitment)
        ExecutionAuthorized, // 4  backend submitted the job to the printer
        JobCompleted,        // 5  print completed (device or shop confirmation)
        JobFailed            // 6  job failed
    }

    struct Job {
        bytes32 shopRef;
        bytes32 documentHash;   // latest committed document hash
        Kind lastKind;
        uint32 recordCount;
        uint64 registeredAt;
        uint64 updatedAt;
    }

    address public owner;
    mapping(address => bool) public writers;
    mapping(bytes32 => bytes32) public shopMetadata;   // shopRef => metadata commitment
    mapping(bytes32 => Job) private jobs;               // jobRef  => job

    event OwnerTransferred(address indexed previousOwner, address indexed newOwner);
    event WriterSet(address indexed writer, bool allowed);
    event ShopRegistered(bytes32 indexed shopRef, bytes32 metadataHash, uint64 at);
    event JobRecorded(bytes32 indexed jobRef, bytes32 indexed shopRef, Kind indexed kind, bytes32 dataHash, uint32 sequence, uint64 at);

    error NotOwner();
    error NotWriter();
    error ZeroValue();
    error UnknownJob(bytes32 jobRef);
    error JobExists(bytes32 jobRef);
    error UnknownShop(bytes32 shopRef);
    error JobClosed(bytes32 jobRef);

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    modifier onlyWriter() {
        if (!writers[msg.sender]) revert NotWriter();
        _;
    }

    constructor(address initialWriter) {
        owner = msg.sender;
        emit OwnerTransferred(address(0), msg.sender);
        if (initialWriter != address(0)) {
            writers[initialWriter] = true;
            emit WriterSet(initialWriter, true);
        }
    }

    // ───────────── administration ─────────────

    function transferOwnership(address newOwner) external onlyOwner {
        if (newOwner == address(0)) revert ZeroValue();
        emit OwnerTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setWriter(address writer, bool allowed) external onlyOwner {
        if (writer == address(0)) revert ZeroValue();
        writers[writer] = allowed;
        emit WriterSet(writer, allowed);
    }

    // ───────────── writes (Inklink backend) ─────────────

    /// Register (or update the metadata commitment of) a shop. Idempotent.
    function registerShop(bytes32 shopRef, bytes32 metadataHash) external onlyWriter {
        if (shopRef == bytes32(0)) revert ZeroValue();
        shopMetadata[shopRef] = metadataHash;
        emit ShopRegistered(shopRef, metadataHash, uint64(block.timestamp));
    }

    /// Register a job at a registered shop.
    function registerJob(bytes32 jobRef, bytes32 shopRef) external onlyWriter {
        if (jobRef == bytes32(0) || shopRef == bytes32(0)) revert ZeroValue();
        if (shopMetadata[shopRef] == bytes32(0)) revert UnknownShop(shopRef);
        Job storage j = jobs[jobRef];
        if (j.registeredAt != 0) revert JobExists(jobRef);
        uint64 nowTs = uint64(block.timestamp);
        j.shopRef = shopRef;
        j.lastKind = Kind.JobRegistered;
        j.recordCount = 1;
        j.registeredAt = nowTs;
        j.updatedAt = nowTs;
        emit JobRecorded(jobRef, shopRef, Kind.JobRegistered, shopRef, 1, nowTs);
    }

    /// Append a lifecycle fact to a registered job. `dataHash` is a commitment (never content).
    function record(bytes32 jobRef, Kind kind, bytes32 dataHash) external onlyWriter {
        if (kind == Kind.JobRegistered) revert ZeroValue(); // use registerJob
        if (dataHash == bytes32(0)) revert ZeroValue();
        Job storage j = jobs[jobRef];
        if (j.registeredAt == 0) revert UnknownJob(jobRef);
        if (j.lastKind == Kind.JobCompleted || j.lastKind == Kind.JobFailed) revert JobClosed(jobRef);
        if (kind == Kind.DocumentCommitted) j.documentHash = dataHash;
        uint64 nowTs = uint64(block.timestamp);
        j.lastKind = kind;
        j.recordCount += 1;
        j.updatedAt = nowTs;
        emit JobRecorded(jobRef, j.shopRef, kind, dataHash, j.recordCount, nowTs);
    }

    // ───────────── reads (anyone) ─────────────

    function getJob(bytes32 jobRef) external view returns (Job memory) {
        Job memory j = jobs[jobRef];
        if (j.registeredAt == 0) revert UnknownJob(jobRef);
        return j;
    }

    /// True if `documentHash` is the document committed for `jobRef` (integrity check).
    function verifyDocument(bytes32 jobRef, bytes32 documentHash) external view returns (bool) {
        return jobs[jobRef].registeredAt != 0 && jobs[jobRef].documentHash == documentHash;
    }
}
