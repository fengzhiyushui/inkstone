import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { acquireProjectLock, requestProjectLockTakeover } from "../../../../src/core/recovery/project-lock.js";
import { mkdtemp } from "../../../helpers/tmp.js";

function ownerFilePath(root) {
  return path.join(root, ".deepseek-code", "v2", ".lock", "owner.json");
}

function lockDirPath(root) {
  return path.dirname(ownerFilePath(root));
}

function lockBaseDirPath(root) {
  return path.dirname(lockDirPath(root));
}

function ownerUpdateGatePath(root) {
  return path.join(lockBaseDirPath(root), ".owner-update-gate");
}

async function writeOwner(root, owner) {
  await writeFile(ownerFilePath(root), `${JSON.stringify(owner, null, 2)}\n`);
}

async function readOwner(root) {
  return JSON.parse(await readFile(ownerFilePath(root), "utf8"));
}

async function assertLockNotOwned(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, "RECOVERY_LOCK_NOT_OWNED");
    assert.match(error.message, /lock not owned/);
    return true;
  });
}

async function assertRecoveryLockCorrupt(operation) {
  await assert.rejects(operation, (error) => {
    assert.equal(error.code, "RECOVERY_LOCK_CORRUPT");
    assert.match(error.message, /recovery project lock is corrupt/);
    return true;
  });
}

test("project lock acquires releases and rejects stale owner mutation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-basic-"));
  const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });

  assert.equal(lock.owner.surface, "cli");
  await lock.assertOwner();

  await writeOwner(root, {
    ...lock.owner,
    epoch: lock.epoch + 1,
    token: "stale-owner-token"
  });
  await assertLockNotOwned(() => lock.assertOwner());
  await assertLockNotOwned(() => lock.heartbeat());
  await assertLockNotOwned(() => lock.release());
});

test("project lock releases and rejects ownership operations after release", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-release-"));
  const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });

  await lock.release();
  await assertLockNotOwned(() => lock.assertOwner());
  await assertLockNotOwned(() => lock.heartbeat());
});

test("persisted release marker fences current handle and is not cleared by heartbeat", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-release-marker-"));
  const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });

  await writeOwner(root, {
    ...lock.owner,
    released_at: "2026-06-01T00:00:01.000Z"
  });

  await assertLockNotOwned(() => lock.assertOwner());
  await assertLockNotOwned(() => lock.heartbeat());

  const persistedOwner = await readOwner(root);
  assert.equal(persistedOwner.released_at, "2026-06-01T00:00:01.000Z");
});

test("release does not expose ownerless lock directory before the next acquire", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-release-ownerless-"));
  const first = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });

  await first.requestTakeover({ requesterToken: "req_a", requestedAt: "2026-06-01T00:00:02.000Z" });
  await first.release();
  await assert.rejects(() => stat(lockDirPath(root)), { code: "ENOENT" });

  const second = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_2" });
  assert.equal(second.epoch, 1);
  await second.assertOwner();
  await second.release();
});

test("lock directory without owner is corrupt unless force takeover is requested", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-missing-owner-"));
  await mkdir(lockDirPath(root), { recursive: true });

  await assertRecoveryLockCorrupt(() =>
    acquireProjectLock({ root, surface: "cli", sessionId: "sess_missing", interactive: false })
  );

  const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_force", takeover: "force" });
  assert.equal(lock.epoch, 1);
  await lock.assertOwner();
  await lock.release();
});

async function statUntilExists(filePath) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      return await stat(filePath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw error;
      }
      await delay(5);
    }
  }
  throw new Error(`timed out waiting for ${filePath}`);
}

test("initial acquisition after owner write fault point observes verified published owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-initial-publish-"));
  let observedInitialWrite = false;
  const faults = {
    async maybe(label) {
      if (label === "after-lock-owner-write" && !observedInitialWrite) {
        observedInitialWrite = true;
        await stat(lockDirPath(root));
        const owner = await readOwner(root);
        assert.equal(owner.epoch, 1);
        assert.equal(owner.session_id, "sess_initial");
      }
    }
  };

  const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_initial", faults });
  assert.equal(lock.epoch, 1);
  assert.equal(observedInitialWrite, true);
  await lock.assertOwner();
  await lock.release();
});

test("contender waits behind verified initial acquisition gate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-initial-gate-"));
  let allowInitialPublish;
  const initialMayPublish = new Promise((resolve) => {
    allowInitialPublish = resolve;
  });
  const faults = {
    async maybe(label) {
      if (label === "after-lock-owner-write") {
        const owner = await readOwner(root);
        assert.equal(owner.epoch, 1);
        assert.equal(owner.session_id, "sess_initial");
        await initialMayPublish;
      }
    }
  };

  const initialAcquire = acquireProjectLock({ root, surface: "cli", sessionId: "sess_initial", faults });
  await statUntilExists(ownerUpdateGatePath(root));

  const contender = acquireProjectLock({ root, surface: "cli", sessionId: "sess_contender", interactive: false });
  await delay(25);
  assert.equal(await statUntilExists(ownerUpdateGatePath(root)).then(() => true), true);

  allowInitialPublish();
  const first = await initialAcquire;
  await assert.rejects(() => contender, /project is already locked/);
  await first.release();
});

test("lock directory with corrupt owner is corrupt unless force takeover is requested", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-corrupt-owner-"));
  await mkdir(lockDirPath(root), { recursive: true });
  await writeFile(ownerFilePath(root), "{not-json");

  await assertRecoveryLockCorrupt(() =>
    acquireProjectLock({ root, surface: "cli", sessionId: "sess_corrupt", interactive: false })
  );

  const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_force", takeover: "force" });
  assert.equal(lock.epoch, 1);
  await lock.assertOwner();
  await lock.release();
});

test("owner missing phase is corrupt without force takeover", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-missing-phase-"));
  await mkdir(lockDirPath(root), { recursive: true });
  await writeOwner(root, {
    epoch: 1,
    token: "owner-token",
    pid: process.pid,
    host: "host-a",
    surface: "cli",
    session_id: "sess_owner",
    heartbeat_at: "2026-06-01T00:00:00.000Z",
    released_at: null
  });

  await assertRecoveryLockCorrupt(() =>
    acquireProjectLock({
      root,
      surface: "cli",
      sessionId: "sess_contender",
      interactive: false,
      host: "host-a"
    })
  );
});

test("syntactically valid malformed owner shapes are corrupt unless force takeover is requested", async (t) => {
  const malformedOwners = [
    ["empty object", {}],
    ["null", null],
    ["array", []]
  ];

  for (const [name, owner] of malformedOwners) {
    await t.test(name, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-malformed-owner-"));
      await mkdir(lockDirPath(root), { recursive: true });
      await writeOwner(root, owner);

      await assertRecoveryLockCorrupt(() =>
        acquireProjectLock({ root, surface: "cli", sessionId: "sess_malformed", interactive: false })
      );

      const lock = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_force", takeover: "force" });
      assert.equal(lock.epoch, 1);
      await lock.assertOwner();
      await lock.release();
    });
  }
});

test("stale same-host owner with dead pid can be acquired and fences old owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-dead-pid-"));
  const first = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1", host: "host-a", pid: 2147483647 });
  const second = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_2", host: "host-a" });

  assert.equal(second.epoch, first.epoch + 1);
  await second.assertOwner();
  await assertLockNotOwned(() => first.assertOwner());
  await second.release();
});

test("stale owner with released timestamp can be acquired and fences old owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-released-owner-"));
  const first = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });

  await writeOwner(root, {
    ...first.owner,
    released_at: "2026-06-01T00:00:01.000Z"
  });

  const second = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_2" });
  assert.equal(second.epoch, first.epoch + 1);
  await second.assertOwner();
  await assertLockNotOwned(() => first.assertOwner());
  await second.release();
});

test("same-host owner with heartbeat age at stale threshold can be acquired", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-same-host-stale-"));
  const startedAt = Date.parse("2026-06-01T00:00:00.000Z");
  const first = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_1",
    host: "host-a",
    pid: process.pid,
    now: () => new Date(startedAt)
  });

  const second = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_2",
    host: "host-a",
    pid: process.pid,
    now: () => new Date(startedAt + 10_000)
  });

  assert.equal(second.epoch, first.epoch + 1);
  await second.assertOwner();
  await assertLockNotOwned(() => first.assertOwner());
  await second.release();
});

test("cross-host owner with heartbeat age at stale threshold can be acquired", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-cross-host-stale-"));
  const startedAt = Date.parse("2026-06-01T00:00:00.000Z");
  const first = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_1",
    host: "host-a",
    now: () => new Date(startedAt)
  });

  const second = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_2",
    host: "host-b",
    now: () => new Date(startedAt + 30_000)
  });

  assert.equal(second.epoch, first.epoch + 1);
  await second.assertOwner();
  await assertLockNotOwned(() => first.assertOwner());
  await second.release();
});

test("second live lock fails closed without takeover", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-live-"));
  const first = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });

  await assert.rejects(
    () => acquireProjectLock({ root, surface: "cli", sessionId: "sess_2", interactive: false }),
    /project is already locked/
  );

  await first.release();
});

test("takeover request file is created and earliest request wins", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-takeover-"));
  const first = await acquireProjectLock({ root, surface: "gui", sessionId: "sess_owner" });

  const requestA = await first.requestTakeover({ requesterToken: "req_a", requestedAt: "2026-06-01T00:00:02.000Z" });
  const requestB = await first.requestTakeover({ requesterToken: "req_b", requestedAt: "2026-06-01T00:00:03.000Z" });
  const winner = await first.readWinningTakeoverRequest();
  const lockEntries = await readdir(path.join(root, ".deepseek-code", "v2", ".lock"));

  assert.equal(lockEntries.filter((name) => name.startsWith("takeover-") && name.endsWith(".json")).length, 2);
  assert.equal(requestA.request_id, winner.request_id);
  assert.notEqual(requestB.request_id, winner.request_id);
  await first.release();
});

test("invalid parseable takeover request cannot win over valid request", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-invalid-takeover-"));
  const first = await acquireProjectLock({ root, surface: "gui", sessionId: "sess_owner" });
  const invalidPath = path.join(lockDirPath(root), "takeover-invalid-request.json");

  await writeFile(
    invalidPath,
    `${JSON.stringify({
      request_id: "invalid-request",
      requester_token: "invalid-token",
      requested_at: "not-a-date"
    }, null, 2)}\n`
  );
  const valid = await first.requestTakeover({
    requestId: "valid-request",
    requesterToken: "valid-token",
    requestedAt: "2026-06-01T00:00:03.000Z"
  });

  const winner = await first.readWinningTakeoverRequest();
  assert.equal(winner.request_id, valid.request_id);
  await first.release();
});

test("takeover request is bound to owner token and epoch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-takeover-owner-bound-"));
  const first = await acquireProjectLock({ root, surface: "gui", sessionId: "sess_owner", pid: 2147483647, host: "host-a" });
  const staleRequest = await first.requestTakeover({
    requestId: "epoch-one-request",
    requesterToken: "req_epoch_1",
    requestedAt: "2026-06-01T00:00:01.000Z"
  });
  const second = await acquireProjectLock({ root, surface: "gui", sessionId: "sess_owner_2", host: "host-a" });
  const lockEntries = await readdir(lockDirPath(root));
  assert.equal(lockEntries.includes(`takeover-${staleRequest.request_id}.json`), false);

  await writeFile(
    path.join(lockDirPath(root), `takeover-${staleRequest.request_id}.json`),
    `${JSON.stringify(staleRequest, null, 2)}\n`
  );

  const winner = await second.readWinningTakeoverRequest();
  assert.equal(winner, null);
  await second.release();
});

test("force takeover removes stale takeover request files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-force-cleans-takeover-"));
  const first = await acquireProjectLock({ root, surface: "gui", sessionId: "sess_owner" });
  await first.requestTakeover({
    requestId: "stale-request",
    requesterToken: "req_stale",
    requestedAt: "2026-06-01T00:00:01.000Z"
  });

  const second = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_force", takeover: "force" });
  const lockEntries = await readdir(lockDirPath(root));

  assert.equal(lockEntries.some((name) => name.startsWith("takeover-") && name.endsWith(".json")), false);
  await second.release();
});

test("after owner write fault leaves verified owner and normal contention semantics", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-after-owner-write-fault-"));
  const faults = {
    async maybe(label) {
      if (label === "after-lock-owner-write") {
        throw new Error("injected after verified owner write");
      }
    }
  };

  await assert.rejects(
    () => acquireProjectLock({ root, surface: "cli", sessionId: "sess_injected", faults }),
    /injected after verified owner write/
  );

  const owner = await readOwner(root);
  assert.equal(owner.epoch, 1);
  assert.equal(owner.session_id, "sess_injected");
  assert.equal(owner.released_at, null);

  await assert.rejects(
    () => acquireProjectLock({ root, surface: "cli", sessionId: "sess_contender", interactive: false }),
    /project is already locked/
  );

  const force = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_force", takeover: "force" });
  assert.equal(force.epoch, owner.epoch + 1);
  await force.release();
});

test("non-owner can request project lock takeover while live holder exists", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-non-owner-request-"));
  const first = await acquireProjectLock({ root, surface: "gui", sessionId: "sess_owner" });

  const result = await requestProjectLockTakeover({
    root,
    requesterToken: "non-owner-token",
    requestId: "non-owner-request",
    requestedAt: "2026-06-01T00:00:02.000Z"
  });
  const winner = await first.readWinningTakeoverRequest();

  assert.equal(result.status, "requested");
  assert.equal(result.request.request_id, "non-owner-request");
  assert.equal(result.request.requester_token, "non-owner-token");
  assert.equal(result.owner.epoch, first.epoch);
  assert.equal(result.owner_stale, false);
  assert.equal(winner.request_id, result.request.request_id);
  await first.release();
});

test("takeover request reports corrupt when owner becomes malformed during protected reread", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-request-corrupt-reread-"));
  const first = await acquireProjectLock({ root, surface: "gui", sessionId: "sess_owner" });
  const faults = {
    async maybe(label) {
      if (label === "before-takeover-request-owner-reread") {
        await writeFile(ownerFilePath(root), "{not-json");
      }
    }
  };

  await assertRecoveryLockCorrupt(() =>
    requestProjectLockTakeover({
      root,
      requesterToken: "non-owner-token",
      requestId: "corrupt-reread-request",
      requestedAt: "2026-06-01T00:00:02.000Z",
      faults
    })
  );

  const second = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_force", takeover: "force" });
  assert.equal(second.epoch, 1);
  await second.release();
});

test("stale leftover owner update gate is cleaned up before force takeover", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-stale-owner-update-gate-"));
  const startedAt = Date.parse("2026-06-01T00:00:00.000Z");
  const first = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_1",
    host: "host-a",
    now: () => new Date(startedAt)
  });
  const gatePath = ownerUpdateGatePath(root);

  await mkdir(gatePath);
  await writeFile(
    path.join(gatePath, "owner-update.json"),
    `${JSON.stringify({
      token: "crashed-holder",
      pid: 2147483647,
      host: "host-a",
      created_at: "2026-06-01T00:00:00.000Z"
    }, null, 2)}\n`
  );

  const second = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_2",
    takeover: "force",
    host: "host-a",
    now: () => new Date(startedAt + 10_001)
  });
  const baseEntries = await readdir(lockBaseDirPath(root));

  assert.equal(second.epoch, first.epoch + 1);
  assert.equal(baseEntries.includes(".owner-update-gate"), false);
  await assertLockNotOwned(() => first.assertOwner());
  await second.release();
});

test("aged same-host live pid owner update gate is not stolen by force takeover", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-live-gate-timeout-"));
  const startedAt = Date.parse("2026-06-01T00:00:00.000Z");
  const host = "host-a";
  const first = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_1",
    host,
    now: () => new Date(startedAt)
  });
  const gatePath = ownerUpdateGatePath(root);
  const gateMetadata = {
    token: "live-holder",
    pid: process.pid,
    host,
    created_at: "2026-06-01T00:00:00.000Z"
  };

  await mkdir(gatePath);
  await writeFile(path.join(gatePath, "owner-update.json"), `${JSON.stringify(gateMetadata, null, 2)}\n`);

  const originalDateNow = Date.now;
  let dateNowCalls = 0;
  Date.now = () => {
    dateNowCalls += 1;
    return dateNowCalls === 1 ? 0 : 10_000;
  };
  try {
    await assert.rejects(
      () => acquireProjectLock({
        root,
        surface: "cli",
        sessionId: "sess_2",
        takeover: "force",
        host,
        now: () => new Date(startedAt + 10_001)
      }),
      (error) => {
        assert.equal(error.code, "RECOVERY_LOCK_BUSY");
        return true;
      }
    );
  } finally {
    Date.now = originalDateNow;
  }

  const persistedGateMetadata = JSON.parse(await readFile(path.join(gatePath, "owner-update.json"), "utf8"));
  assert.deepEqual(persistedGateMetadata, gateMetadata);
  const persistedOwner = await readOwner(root);
  assert.equal(persistedOwner.token, first.owner.token);
  assert.equal(persistedOwner.epoch, first.epoch);

  await rm(gatePath, { recursive: true, force: true });
  await first.release();
});

test("stale gate cleanup does not remove newer gate holder", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-gate-cas-"));
  const startedAt = Date.parse("2026-06-01T00:00:00.000Z");
  const first = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_1",
    host: "host-a",
    now: () => new Date(startedAt)
  });
  const gatePath = ownerUpdateGatePath(root);

  await mkdir(gatePath);
  await writeFile(
    path.join(gatePath, "owner-update.json"),
    `${JSON.stringify({
      token: "stale-holder",
      pid: 2147483647,
      host: "host-a",
      created_at: "2026-06-01T00:00:00.000Z"
    }, null, 2)}\n`
  );

  const second = await acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_2",
    takeover: "force",
    host: "host-a",
    now: () => new Date(startedAt + 10_001)
  });

  await mkdir(gatePath);
  await writeFile(
    path.join(gatePath, "owner-update.json"),
    `${JSON.stringify({
      token: "new-live-holder",
      pid: process.pid,
      host: "host-a",
      created_at: "2026-06-01T00:00:10.001Z"
    }, null, 2)}\n`
  );

  const thirdAcquire = acquireProjectLock({
    root,
    surface: "cli",
    sessionId: "sess_3",
    takeover: "force",
    host: "host-a",
    now: () => new Date(startedAt + 10_002)
  });
  await delay(25);

  const gateOwner = JSON.parse(await readFile(path.join(gatePath, "owner-update.json"), "utf8"));
  assert.equal(gateOwner.token, "new-live-holder");

  await rm(gatePath, { recursive: true, force: true });
  const third = await thirdAcquire;
  await third.release();
  await assertLockNotOwned(() => first.assertOwner());
  await assertLockNotOwned(() => second.assertOwner());
});

test("takeover request rechecks owner and does not leave orphan request-only lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-request-release-race-"));
  const first = await acquireProjectLock({ root, surface: "gui", sessionId: "sess_owner" });
  const faults = {
    async maybe(label) {
      if (label === "before-takeover-request-mutex") {
        await first.release();
      }
    }
  };

  await assert.rejects(
    () => requestProjectLockTakeover({
      root,
      requesterToken: "non-owner-token",
      requestId: "orphan-request",
      requestedAt: "2026-06-01T00:00:02.000Z",
      faults
    }),
    (error) => {
      assert.equal(error.code, "RECOVERY_LOCK_NOT_HELD");
      return true;
    }
  );

  await assert.rejects(() => readdir(lockDirPath(root)), { code: "ENOENT" });

  const second = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_after_request_race" });
  assert.equal(second.epoch, 1);
  await second.release();
});

test("force takeover increments epoch and old owner fails fencing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-force-"));
  const first = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });
  const second = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_2", takeover: "force" });

  assert.equal(second.epoch, first.epoch + 1);
  await second.assertOwner();
  await assertLockNotOwned(() => first.assertOwner());
  await second.release();
});

test("invalid force takeover metadata does not replace existing owner", async (t) => {
  const invalidOptions = [
    ["surface", { surface: "", sessionId: "sess_force" }],
    ["sessionId", { surface: "cli", sessionId: "" }]
  ];

  for (const [name, options] of invalidOptions) {
    await t.test(name, async () => {
      const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-invalid-force-metadata-"));
      const first = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });

      await assert.rejects(
        () => acquireProjectLock({ root, ...options, takeover: "force" }),
        (error) => {
          assert.equal(error.code, "RECOVERY_LOCK_INVALID_OWNER");
          return true;
        }
      );

      const persistedOwner = await readOwner(root);
      assert.equal(persistedOwner.token, first.owner.token);
      assert.equal(persistedOwner.epoch, first.epoch);
      assert.equal(persistedOwner.surface, first.owner.surface);
      assert.equal(persistedOwner.session_id, first.owner.session_id);
      await first.assertOwner();
      await first.release();
    });
  }
});

test("old owner release after force takeover does not delete new owner", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-lock-force-release-race-"));
  const first = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_1" });
  const second = await acquireProjectLock({ root, surface: "cli", sessionId: "sess_2", takeover: "force" });

  await assertLockNotOwned(() => first.release());

  const persistedOwner = await readOwner(root);
  assert.equal(persistedOwner.token, second.owner.token);
  assert.equal(persistedOwner.epoch, second.epoch);
  await second.assertOwner();
  await second.release();
});
