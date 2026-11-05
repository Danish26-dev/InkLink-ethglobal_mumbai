import { describe, it } from "node:test";
import assert from "node:assert/strict";
import type { NextFunction, Request, Response } from "express";
import { bearerAuth } from "../src/auth.js";
import {
  BackendRequirementsSource,
  FixedRequirementsSource,
  parseBackendRequirements,
} from "../src/gate-requirements.js";
import { jobIdFromPath } from "../src/x402-gate.js";

describe("jobIdFromPath", () => {
  it("extracts the job id from the agreed execute route only", () => {
    assert.equal(jobIdFromPath("/api/v1/jobs/job_123/execute"), "job_123");
    assert.equal(jobIdFromPath("/api/v1/jobs/job%2Fx/execute"), "job/x");
    assert.equal(jobIdFromPath("/api/v1/jobs/job_123/status"), null);
    assert.equal(jobIdFromPath("/api/v1/jobs//execute"), null);
    assert.equal(jobIdFromPath("/elsewhere"), null);
  });
});

describe("backend requirements", () => {
  const good = { jobId: "job_1", merchantAccountId: "0.0.2002", amount: "0.10", expiresAt: "2030-01-01T00:00:00Z" };

  it("parses a valid response into exact atomic units", () => {
    const r = parseBackendRequirements(good, "job_1", 6);
    assert.equal(r.amountAtomic, 100000n);
    assert.equal(r.payTo, "0.0.2002");
  });

  it("rejects a response for another job, a bad account, or a bad amount", () => {
    assert.throws(() => parseBackendRequirements({ ...good, jobId: "job_2" }, "job_1", 6), /jobId/);
    assert.throws(() => parseBackendRequirements({ ...good, merchantAccountId: "shop_001" }, "job_1", 6), /account id/);
    assert.throws(() => parseBackendRequirements({ ...good, amount: "0" }, "job_1", 6), /positive/);
    assert.throws(() => parseBackendRequirements({ ...good, amount: 0.1 }, "job_1", 6), /decimal string/);
    assert.throws(() => parseBackendRequirements({ ...good, amount: "0.1234567" }, "job_1", 6));
  });

  it("looks the job up, sends the bearer token, and caches briefly", async () => {
    let calls = 0;
    let auth: string | null = null;
    const source = new BackendRequirementsSource(
      "http://backend/internal/jobs/{jobId}/req", 6, "tok",
      (async (url: string, init?: RequestInit) => {
        calls++;
        auth = (init?.headers as Record<string, string>).Authorization;
        assert.equal(url, "http://backend/internal/jobs/job_1/req");
        return new Response(JSON.stringify(good), { status: 200 });
      }) as unknown as typeof fetch,
    );
    assert.equal((await source.get("job_1"))?.amountAtomic, 100000n);
    await source.get("job_1");
    assert.equal(calls, 1);
    assert.equal(auth, "Bearer tok");
  });

  it("maps 404 to an unknown job and other failures to errors", async () => {
    const notFound = new BackendRequirementsSource("http://b/{jobId}", 6, undefined,
      (async () => new Response("", { status: 404 })) as typeof fetch);
    assert.equal(await notFound.get("nope"), null);

    const broken = new BackendRequirementsSource("http://b/{jobId}", 6, undefined,
      (async () => new Response("", { status: 500 })) as typeof fetch);
    await assert.rejects(broken.get("x"), /HTTP 500/);
  });

  it("requires {jobId} in the URL template", () => {
    assert.throws(() => new BackendRequirementsSource("http://b/static", 6), /\{jobId\}/);
  });

  it("dev source returns one fixed price for any job", async () => {
    const r = await new FixedRequirementsSource("0.10", "0.0.2002", 6).get("anything");
    assert.deepEqual({ a: r.amountAtomic, p: r.payTo }, { a: 100000n, p: "0.0.2002" });
  });
});

describe("bearerAuth", () => {
  const run = (header: string | undefined) => {
    let status = 0;
    let nexted = false;
    const req = { header: (n: string) => (n.toLowerCase() === "authorization" ? header : undefined) } as unknown as Request;
    const res = {
      status(s: number) { status = s; return this; },
      set() { return this; },
      json() { return this; },
    } as unknown as Response;
    bearerAuth("a-long-enough-token")(req, res, (() => { nexted = true; }) as NextFunction);
    return { status, nexted };
  };

  it("lets the correct bearer token through", () => {
    assert.deepEqual(run("Bearer a-long-enough-token"), { status: 0, nexted: true });
  });

  it("rejects missing, wrong, and wrongly-formed credentials with 401", () => {
    for (const h of [undefined, "", "Bearer wrong-token-value-x", "a-long-enough-token", "Basic a-long-enough-token", "Bearer "]) {
      assert.deepEqual(run(h), { status: 401, nexted: false }, String(h));
    }
  });
});
