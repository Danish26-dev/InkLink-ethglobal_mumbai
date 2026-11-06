const { expect } = require("chai");
const { ethers } = require("hardhat");

const h = (s) => ethers.keccak256(ethers.toUtf8Bytes(s));
const Kind = { JobRegistered: 0, DocumentCommitted: 1, QuoteReferenced: 2, PaymentVerified: 3, ExecutionAuthorized: 4, JobCompleted: 5, JobFailed: 6 };

describe("InklinkRegistry", () => {
  let reg, owner, writer, stranger;
  const shop = h("shop:shop_001");
  const job = h("job:job_3f9a1c2b7d10");

  beforeEach(async () => {
    [owner, writer, stranger] = await ethers.getSigners();
    reg = await (await ethers.getContractFactory("InklinkRegistry")).deploy(writer.address);
    await reg.waitForDeployment();
  });

  it("sets owner and initial writer", async () => {
    expect(await reg.owner()).to.equal(owner.address);
    expect(await reg.writers(writer.address)).to.equal(true);
    expect(await reg.writers(stranger.address)).to.equal(false);
  });

  it("only writers can write; only the owner manages writers", async () => {
    await expect(reg.connect(stranger).registerShop(shop, h("meta"))).to.be.revertedWithCustomError(reg, "NotWriter");
    await expect(reg.connect(writer).setWriter(stranger.address, true)).to.be.revertedWithCustomError(reg, "NotOwner");
    await expect(reg.setWriter(stranger.address, true)).to.emit(reg, "WriterSet").withArgs(stranger.address, true);
    await reg.setWriter(stranger.address, false);
    expect(await reg.writers(stranger.address)).to.equal(false);
  });

  it("records a full job lifecycle with events and integrity check", async () => {
    await reg.connect(writer).registerShop(shop, h("meta"));
    await expect(reg.connect(writer).registerJob(job, shop)).to.emit(reg, "JobRecorded");
    const doc = "0x" + "ab".repeat(32);
    await expect(reg.connect(writer).record(job, Kind.DocumentCommitted, doc))
      .to.emit(reg, "JobRecorded").withArgs(job, shop, Kind.DocumentCommitted, doc, 2, (v) => v > 0n);
    await reg.connect(writer).record(job, Kind.QuoteReferenced, h("quote"));
    await reg.connect(writer).record(job, Kind.PaymentVerified, h("0.0.7162784@1793967953.517115964"));
    await reg.connect(writer).record(job, Kind.ExecutionAuthorized, h("exec"));
    await reg.connect(writer).record(job, Kind.JobCompleted, h("done"));

    const j = await reg.getJob(job);
    expect(j.shopRef).to.equal(shop);
    expect(j.documentHash).to.equal(doc);
    expect(j.lastKind).to.equal(BigInt(Kind.JobCompleted));
    expect(j.recordCount).to.equal(6n);
    expect(await reg.verifyDocument(job, doc)).to.equal(true);
    expect(await reg.verifyDocument(job, h("tampered"))).to.equal(false);
  });

  it("rejects unknown shops, duplicate jobs, unknown jobs, zero hashes and writes after close", async () => {
    await expect(reg.connect(writer).registerJob(job, shop)).to.be.revertedWithCustomError(reg, "UnknownShop");
    await reg.connect(writer).registerShop(shop, h("meta"));
    await reg.connect(writer).registerJob(job, shop);
    await expect(reg.connect(writer).registerJob(job, shop)).to.be.revertedWithCustomError(reg, "JobExists");
    await expect(reg.connect(writer).record(h("nope"), Kind.QuoteReferenced, h("q"))).to.be.revertedWithCustomError(reg, "UnknownJob");
    await expect(reg.connect(writer).record(job, Kind.QuoteReferenced, ethers.ZeroHash)).to.be.revertedWithCustomError(reg, "ZeroValue");
    await expect(reg.connect(writer).record(job, Kind.JobRegistered, h("x"))).to.be.revertedWithCustomError(reg, "ZeroValue");
    await reg.connect(writer).record(job, Kind.JobFailed, h("failed"));
    await expect(reg.connect(writer).record(job, Kind.JobCompleted, h("late"))).to.be.revertedWithCustomError(reg, "JobClosed");
  });

  it("reads are public and unknown jobs revert", async () => {
    await expect(reg.connect(stranger).getJob(job)).to.be.revertedWithCustomError(reg, "UnknownJob");
  });
});
