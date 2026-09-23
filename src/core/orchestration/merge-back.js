import { promises as fs } from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

function sha(buf) { return `sha256:${createHash("sha256").update(buf).digest("hex")}`; }
function splitLines(text) { return text.length ? text.replace(/\r?\n$/, "").split(/\r?\n/) : []; }

// Whole-file-replacement unified diff. Applies cleanly because CAS guarantees
// the main file equals `baseContent` at merge time.
export function makeUnifiedDiff(p, baseContent, finalContent) {
  if (baseContent == null && finalContent != null) {            // add
    const add = splitLines(finalContent);
    return `--- /dev/null\n+++ b/${p}\n@@ -0,0 +1,${add.length} @@\n${add.map((l) => `+${l}`).join("\n")}\n`;
  }
  if (baseContent != null && finalContent == null) {            // delete
    const del = splitLines(baseContent);
    return `--- a/${p}\n+++ /dev/null\n@@ -1,${del.length} +0,0 @@\n${del.map((l) => `-${l}`).join("\n")}\n`;
  }
  const del = splitLines(baseContent), add = splitLines(finalContent);   // modify
  const body = [...del.map((l) => `-${l}`), ...add.map((l) => `+${l}`)].join("\n");
  return `--- a/${p}\n+++ b/${p}\n@@ -1,${del.length} +1,${add.length} @@\n${body}\n`;
}

async function readOrNull(root, rel) {
  try { return await fs.readFile(path.join(root, rel), "utf8"); } catch { return null; }
}
async function hashOrNull(root, rel) {
  try { return sha(await fs.readFile(path.join(root, rel))); } catch { return null; }
}

// CAS: main path must still equal base before we apply.
async function casOk(mainRoot, rel, baseManifest) {
  const base = baseManifest.get(rel) || null;
  const cur = await hashOrNull(mainRoot, rel);
  return cur === base;   // modify/delete: both = base hash; add: both = null
}

export async function mergeSubtask({ editService, mainRoot, isoRoot, baseManifest, actual }) {
  const touched = [...actual.added, ...actual.modified, ...actual.deleted];
  for (const rel of touched) {
    if (!(await casOk(mainRoot, rel, baseManifest))) {
      return { ok: false, reason: `merge conflict: ${rel} changed in main since snapshot` };
    }
  }
  // One combined diff = the whole subtask's net change → one atomic editService.apply.
  // base content for modify/delete = the main file (CAS just proved main == base).
  const parts = [];
  for (const rel of actual.added) parts.push(makeUnifiedDiff(rel, null, await readOrNull(isoRoot, rel)));
  for (const rel of actual.modified) parts.push(makeUnifiedDiff(rel, await readOrNull(mainRoot, rel), await readOrNull(isoRoot, rel)));
  for (const rel of actual.deleted) parts.push(makeUnifiedDiff(rel, await readOrNull(mainRoot, rel), null));
  const diff = parts.join("\n");
  try {
    const res = await editService.apply({ diff });
    return { ok: true, change_id: res.metadata?.change_id };
  } catch (e) {
    return { ok: false, reason: `apply failed: ${e.message}` };
  }
}
