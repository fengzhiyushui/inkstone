import test from "node:test";
import assert from "node:assert/strict";
import { createContextUnit } from "../../../src/context/context-unit.js";
import {
  detectMentionedPaths,
  rankContextUnits,
  selectContextUnits
} from "../../../src/context/context-selector.js";

function unit(path, content = `${path}\n`) {
  return createContextUnit({
    path,
    content,
    now: "2026-05-31T00:00:00.000Z"
  });
}

test("detectMentionedPaths resolves exact paths and unique basenames", () => {
  const index = new Map([
    ["README.md", unit("README.md")],
    ["src/index.js", unit("src/index.js")],
    ["lib/index.js", unit("lib/index.js")],
    ["src/apps/tui/tui-app.js", unit("src/apps/tui/tui-app.js")]
  ]);

  assert.deepEqual(
    detectMentionedPaths("please inspect README.md and tui-app.js", index),
    new Set(["README.md", "src/apps/tui/tui-app.js"])
  );
  assert.deepEqual(
    detectMentionedPaths("look at index.js", index),
    new Set()
  );
});

test("rankContextUnits puts stable prefix before pinned and mentioned files", () => {
  const index = new Map([
    ["src/z.js", unit("src/z.js")],
    ["README.md", unit("README.md")],
    ["src/a.js", unit("src/a.js")],
    ["package.json", unit("package.json")]
  ]);

  const ranked = rankContextUnits({
    units: index,
    message: "update src/z.js",
    pinned: new Set(["src/a.js"]),
    warmed: new Map([["src/z.js", "manual-warm"]]),
    classification: { task_type: "edit" }
  });

  assert.deepEqual(ranked.map((item) => [item.path, item.reason, item.priority]), [
    ["package.json", "project-manifest", 0],
    ["README.md", "project-doc", 0],
    ["src/a.js", "pinned", 1],
    ["src/z.js", "mentioned", 1]
  ]);
});

test("selectContextUnits respects budget after ranking", () => {
  const index = new Map([
    ["package.json", { ...unit("package.json", "x".repeat(8)), token_count: 2 }],
    ["README.md", { ...unit("README.md", "x".repeat(8)), token_count: 2 }],
    ["src/big.js", { ...unit("src/big.js", "x".repeat(80)), token_count: 20 }]
  ]);

  const result = selectContextUnits({
    units: index,
    message: "modify src/big.js",
    classification: { task_type: "edit" },
    budget: 4
  });

  assert.deepEqual(result.selected.map((item) => item.path), ["package.json", "README.md"]);
  assert.deepEqual(result.skipped.map((item) => item.path), ["src/big.js"]);
  assert.equal(result.budget.used, 4);
});
