import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  BR_MAIN,
  createBranchStore
} from "../../../src/sessions/branch-store.js";
import { mkdtemp } from "../../helpers/tmp.js";

test("branch store creates br_main lazily", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-"));
  const store = await createBranchStore({
    sessionRoot: path.join(root, ".sessions"),
    projectId: "proj_test",
    sessionId: "sess_test"
  });

  assert.equal(await store.getActiveBranchId(), BR_MAIN);
  const branches = await store.listBranches();
  assert.equal(branches.length, 1);
  assert.equal(branches[0].branch_id, BR_MAIN);
  assert.equal(branches[0].parent_branch_id, null);
});

test("branch store persists child branch and active branch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-persist-"));
  const options = {
    sessionRoot: path.join(root, ".sessions"),
    projectId: "proj_test",
    sessionId: "sess_test"
  };
  const first = await createBranchStore(options);
  const child = await first.createBranch({
    parent_branch_id: BR_MAIN,
    forked_from_event_id: "evt_1",
    forked_from_seq: 10,
    forked_from_turn_id: "turn_1",
    label: "rewind to turn_1"
  });
  await first.activateBranch(child.branch_id);

  const second = await createBranchStore(options);
  assert.equal(await second.getActiveBranchId(), child.branch_id);
  const branches = await second.listBranches();
  assert.equal(branches.length, 2);
  assert.equal(branches[1].parent_branch_id, BR_MAIN);

  const raw = JSON.parse(await readFile(path.join(options.sessionRoot, "proj_test", "sess_test.branches.json"), "utf8"));
  assert.equal(raw.active_branch_id, child.branch_id);
});

test("branch store rejects unknown branch activation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-unknown-"));
  const store = await createBranchStore({
    sessionRoot: path.join(root, ".sessions"),
    projectId: "proj_test",
    sessionId: "sess_test"
  });

  await assert.rejects(() => store.activateBranch("br_missing"), /unknown branch/);
});

test("branch ancestry includes parent chain from root to child", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dsc-branch-store-ancestry-"));
  const store = await createBranchStore({
    sessionRoot: path.join(root, ".sessions"),
    projectId: "proj_test",
    sessionId: "sess_test"
  });
  const first = await store.createBranch({ parent_branch_id: BR_MAIN, forked_from_seq: 5 });
  const second = await store.createBranch({ parent_branch_id: first.branch_id, forked_from_seq: 8 });

  assert.deepEqual(
    (await store.getAncestry(second.branch_id)).map((branch) => branch.branch_id),
    [BR_MAIN, first.branch_id, second.branch_id]
  );
});
