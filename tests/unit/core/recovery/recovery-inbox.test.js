import test from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRecoveryInbox } from "../../../../src/core/recovery/recovery-inbox.js";
import { mkdtemp } from "../../../helpers/tmp.js";

test("recovery inbox upserts lists and clears safe items", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-"));
  const inbox = createRecoveryInbox({ root });

  await inbox.upsert({
    id: "rec_tx_tx_1",
    type: "recovered_tx",
    status: "done",
    source_id: "tx_1",
    summary: "rolled back edit",
    evidence: { recovered_path: ".deepseek-code/v2/recovered/tx_1" },
    allowed_actions: ["clear"]
  });

  assert.equal((await inbox.list()).length, 1);
  await inbox.clear("rec_tx_tx_1");
  assert.equal((await inbox.list()).length, 0);
  assert.equal((await inbox.list({ includeCleared: true }))[0].status, "cleared");
});

test("recovery inbox refuses to clear blocked items", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-blocked-"));
  const inbox = createRecoveryInbox({ root });
  await inbox.upsert({ id: "rec_block_journal", type: "blocked_recovery", status: "blocked", source_id: "journal", summary: "corrupt journal", allowed_actions: [] });

  await assert.rejects(() => inbox.clear("rec_block_journal"), /cannot clear blocked recovery item/);
});

test("recovery inbox persists marks and sorts by created_at", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-persist-"));
  const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    path.join(inboxDir, "inbox.json"),
    JSON.stringify({
      schema_version: 1,
      items: [
        {
          id: "rec_b",
          type: "recovered_tx",
          status: "done",
          source_id: "tx_b",
          summary: "second",
          created_at: "2026-06-01T00:00:00.000Z",
          updated_at: "2026-06-01T00:00:00.000Z"
        },
        {
          id: "rec_a",
          type: "recovered_tx",
          status: "pending",
          source_id: "tx_a",
          summary: "first",
          created_at: "2026-06-01T00:00:01.000Z",
          updated_at: "2026-06-01T00:00:01.000Z"
        }
      ]
    })
  );
  const inbox = createRecoveryInbox({ root });
  await inbox.mark("rec_a", { status: "quarantined", evidence: { note: "kept safe" }, allowed_actions: ["clear"] });

  const reopened = createRecoveryInbox({ root });
  const items = await reopened.list({ includeCleared: true });
  assert.deepEqual(items.map((item) => item.id), ["rec_b", "rec_a"]);
  assert.equal(items[1].status, "quarantined");
  assert.deepEqual(items[1].evidence, { note: "kept safe" });
  assert.deepEqual(items[1].allowed_actions, ["clear"]);
});

test("recovery inbox serializes concurrent upserts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-concurrent-"));
  const inboxA = createRecoveryInbox({ root });
  const inboxB = createRecoveryInbox({ root });

  await Promise.all([
    inboxA.upsert({ id: "rec_concurrent_a", type: "recovered_tx", status: "done", source_id: "tx_a", summary: "first" }),
    inboxB.upsert({ id: "rec_concurrent_b", type: "recovered_tx", status: "done", source_id: "tx_b", summary: "second" })
  ]);

  const ids = (await createRecoveryInbox({ root }).list()).map((item) => item.id).sort();
  assert.deepEqual(ids, ["rec_concurrent_a", "rec_concurrent_b"]);
});

test("recovery inbox upsert preserves marked fields on existing items", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-preserve-mark-"));
  const inbox = createRecoveryInbox({ root });

  await inbox.upsert({ id: "rec_preserve", type: "recovered_tx", status: "pending", source_id: "tx_preserve", summary: "first" });
  await inbox.mark("rec_preserve", { status: "quarantined", evidence: { note: "operator reviewed" }, allowed_actions: ["clear"] });
  await inbox.upsert({ id: "rec_preserve", type: "recovered_tx", status: "done", source_id: "tx_preserve", summary: "scanner saw done" });

  const [item] = await inbox.list();
  assert.equal(item.status, "quarantined");
  assert.equal(item.summary, "scanner saw done");
  assert.deepEqual(item.evidence, { note: "operator reviewed" });
  assert.deepEqual(item.allowed_actions, ["clear"]);
});

test("recovery inbox treats cleared items as terminal", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-cleared-terminal-"));
  const inbox = createRecoveryInbox({ root });

  await inbox.upsert({ id: "rec_terminal", type: "recovered_tx", status: "done", source_id: "tx_terminal", summary: "done" });
  await inbox.clear("rec_terminal");

  await assert.rejects(
    () => inbox.upsert({ id: "rec_terminal", type: "recovered_tx", status: "pending", source_id: "tx_terminal", summary: "stale scanner" }),
    /cannot upsert cleared recovery item/
  );
  await assert.rejects(
    () => inbox.mark("rec_terminal", { status: "pending" }),
    /cannot mark cleared recovery item/
  );
  assert.equal((await inbox.list()).length, 0);
  assert.equal((await inbox.list({ includeCleared: true }))[0].status, "cleared");
});

test("recovery inbox validates required summary-only fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-validate-"));
  const inbox = createRecoveryInbox({ root });

  await assert.rejects(
    () => inbox.upsert({ id: "", type: "recovered_tx", status: "done", source_id: "tx_1", summary: "rolled back" }),
    /invalid recovery inbox item id/
  );
  await assert.rejects(
    () => inbox.upsert({ id: "rec_raw", type: "recovered_tx", status: "done", source_id: "tx_1", summary: "rolled back", resume_state: { raw: true } }),
    /disallowed recovery inbox payload field/
  );
});

test("recovery inbox rejects persisted items with unknown fields", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-persisted-unknown-"));
  const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    path.join(inboxDir, "inbox.json"),
    JSON.stringify({
      schema_version: 1,
      items: [{
        id: "rec_unknown",
        type: "recovered_tx",
        status: "done",
        source_id: "tx_unknown",
        summary: "rolled back",
        resume_state: { step: "apply" }
      }]
    })
  );

  const inbox = createRecoveryInbox({ root });
  await assert.rejects(() => inbox.list(), /invalid recovery inbox item/);
});

test("recovery inbox rejects malformed persisted timestamps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-bad-time-"));
  const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    path.join(inboxDir, "inbox.json"),
    JSON.stringify({
      schema_version: 1,
      items: [{
        id: "rec_bad_time",
        type: "recovered_tx",
        status: "done",
        source_id: "tx_bad_time",
        summary: "bad timestamp",
        created_at: "banana",
        updated_at: "2026-06-01T00:00:00.000Z"
      }]
    })
  );

  const inbox = createRecoveryInbox({ root });
  await assert.rejects(() => inbox.list(), /invalid recovery inbox item created_at/);
});

test("recovery inbox rejects persisted items missing timestamps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-missing-time-"));
  const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    path.join(inboxDir, "inbox.json"),
    JSON.stringify({
      schema_version: 1,
      items: [{
        id: "rec_missing_time",
        type: "recovered_tx",
        status: "done",
        source_id: "tx_missing_time",
        summary: "missing timestamp"
      }]
    })
  );

  const inbox = createRecoveryInbox({ root });
  await assert.rejects(() => inbox.list(), /invalid recovery inbox item created_at/);
});

test("recovery inbox rejects non-canonical persisted timestamps", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-noncanonical-time-"));
  const inboxDir = path.join(root, ".deepseek-code", "v2", "recovery");
  await mkdir(inboxDir, { recursive: true });
  await writeFile(
    path.join(inboxDir, "inbox.json"),
    JSON.stringify({
      schema_version: 1,
      items: [{
        id: "rec_noncanonical_time",
        type: "recovered_tx",
        status: "done",
        source_id: "tx_noncanonical_time",
        summary: "bad timestamp",
        created_at: "2026-02-30T00:00:00.000Z",
        updated_at: "2026-06-01T00:00:00.000Z"
      }]
    })
  );

  const inbox = createRecoveryInbox({ root });
  await assert.rejects(() => inbox.list(), /invalid recovery inbox item created_at/);
});


test("recovery inbox mark cannot clear blocked items", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-mark-cleared-"));
  const inbox = createRecoveryInbox({ root });
  await inbox.upsert({ id: "rec_block_mark", type: "blocked_recovery", status: "blocked", source_id: "journal", summary: "corrupt journal", allowed_actions: [] });

  await assert.rejects(
    () => inbox.mark("rec_block_mark", { status: "cleared" }),
    /cannot mark recovery inbox item cleared; use clear\(\)/
  );

  const items = await inbox.list();
  assert.equal(items.length, 1);
  assert.equal(items[0].status, "blocked");
});

test("recovery inbox upsert rejects nested forbidden evidence payloads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-upsert-evidence-"));
  const inbox = createRecoveryInbox({ root });

  await assert.rejects(
    () => inbox.upsert({
      id: "rec_nested_raw",
      type: "recovered_tx",
      status: "done",
      source_id: "tx_nested",
      summary: "rolled back nested raw payload",
      evidence: { summary: { resume_state: { current_step: "apply" } } }
    }),
    /disallowed recovery inbox summary payload field: evidence\.summary\.resume_state/
  );
});

test("recovery inbox accepts safe evidence strings containing forbidden substrings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-safe-string-"));
  const inbox = createRecoveryInbox({ root });

  await inbox.upsert({
    id: "rec_safe_string",
    type: "recovered_tx",
    status: "done",
    source_id: "tx_safe_string",
    summary: "rolled back",
    evidence: { note: "operator promptly cancelled recovery" }
  });

  const items = await inbox.list();
  assert.equal(items[0].evidence.note, "operator promptly cancelled recovery");
});

test("recovery inbox mark rejects nested forbidden evidence payloads", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-mark-evidence-"));
  const inbox = createRecoveryInbox({ root });

  await inbox.upsert({ id: "rec_mark_raw", type: "recovered_tx", status: "pending", source_id: "tx_mark", summary: "needs mark" });

  await assert.rejects(
    () => inbox.mark("rec_mark_raw", { evidence: { summary: { diffs: "raw diff payload" } } }),
    /disallowed recovery inbox summary payload field: evidence\.summary\.diffs/
  );
});

test("recovery inbox rejects undefined evidence patches", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-undefined-evidence-"));
  const inbox = createRecoveryInbox({ root });

  await inbox.upsert({ id: "rec_undefined_evidence", type: "recovered_tx", status: "pending", source_id: "tx_undefined", summary: "needs mark" });

  await assert.rejects(
    () => inbox.mark("rec_undefined_evidence", { evidence: undefined }),
    /invalid recovery inbox item evidence/
  );
});

test("recovery inbox rejects oversized summary payload strings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-large-evidence-"));
  const inbox = createRecoveryInbox({ root });

  await assert.rejects(
    () => inbox.upsert({
      id: "rec_large_evidence",
      type: "recovered_tx",
      status: "done",
      source_id: "tx_large",
      summary: "large evidence",
      evidence: { note: "x".repeat(1200) }
    }),
    /string too large/
  );
});

test("recovery inbox allows safe nested evidence summaries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-inbox-safe-evidence-"));
  const inbox = createRecoveryInbox({ root });
  const evidence = {
    recovered_path: ".deepseek-code/v2/recovered/tx_safe",
    paths: ["src/app.js", "src/app.test.js"],
    counts: { recovered: 2, quarantined: 0 },
    statuses: { transaction: "done", workspace: "clean" }
  };

  await inbox.upsert({
    id: "rec_safe_evidence",
    type: "recovered_tx",
    status: "done",
    source_id: "tx_safe",
    summary: "safe nested evidence",
    evidence
  });
  await inbox.mark("rec_safe_evidence", { evidence: { ...evidence, statuses: { transaction: "quarantined", workspace: "clean" } } });

  const items = await inbox.list({ includeCleared: true });
  assert.deepEqual(items[0].evidence, { ...evidence, statuses: { transaction: "quarantined", workspace: "clean" } });
});
