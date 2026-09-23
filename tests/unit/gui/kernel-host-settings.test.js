import test from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { createKernelHost } = require("../../../gui/kernel-host.js");

async function tmp() { return fs.mkdtemp(path.join(os.tmpdir(), "dsc-set-")); }

test("listModels returns ids on ok, throws on error, no default", async () => {
  const host = createKernelHost({ projectRoot: await tmp() });
  const ok = async () => ({ ok: true, json: async () => ({ data: [{ id: "m1" }, { id: "m2" }] }) });
  assert.deepEqual(await host.listModels(null, { fetchImpl: ok, baseUrl: "https://x", apiKey: "k" }), ["m1", "m2"]);
  const bad = async () => ({ ok: false, status: 401, text: async () => "unauthorized" });
  await assert.rejects(() => host.listModels(null, { fetchImpl: bad, baseUrl: "https://x", apiKey: "k" }));
  await assert.rejects(() => host.listModels(null, { fetchImpl: ok, baseUrl: "https://x", apiKey: "" })); // no key → throw, no default
});

test("api profiles CRUD + activate writes config; getSettings masks keys", async () => {
  const root = await tmp();
  const host = createKernelHost({ projectRoot: root });
  const p = await host.saveApiProfile({ name: "d", baseUrl: "https://api.deepseek.com", apiKey: "sk-secret-123456", model: "m1" });
  await host.activateApiProfile(p.id);

  const s = await host.getSettings();
  const prof = s.apiProfiles[0];
  assert.equal(prof.hasKey, true);
  assert.equal(prof.name, "d");
  assert.equal(s.activeProfileId, p.id);
  assert.ok(!JSON.stringify(s).includes("sk-secret-123456")); // never plaintext to renderer

  // activate wrote credentials to config.json (so kernel reads them)
  const cfg = JSON.parse(await fs.readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
  assert.equal(cfg.apiKey, "sk-secret-123456");

  await host.deleteApiProfile(p.id);
  assert.equal((await host.listApiProfiles()).length, 0);
  const cfgAfter = JSON.parse(await fs.readFile(path.join(root, ".deepseek-code", "config.json"), "utf8"));
  assert.equal(cfgAfter.apiKey, "");
  const sAfter = await host.getSettings();
  assert.equal(sAfter.config.hasApiKey, false);
  assert.equal(sAfter.activeProfileId, null);
});

test("writeFile builds a whole-file diff and applies it via the injected edit service", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "a.txt"), "one\ntwo\n", "utf8");
  const calls = [];
  const editService = { apply: async ({ diff, prompt }) => { calls.push({ diff, prompt }); return { status: "success" }; } };
  const host = createKernelHost({ projectRoot: root, editService });

  const r = await host.writeFile("a.txt", "one\nTWO\n");
  assert.equal(r.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0].diff, /--- a\/a\.txt/);
  assert.match(calls[0].diff, /\+\+\+ b\/a\.txt/);
  assert.match(calls[0].diff, /\+one/);           // new content present
  assert.match(calls[0].prompt, /a\.txt/);
});

test("writeFile is a no-op when content is unchanged (no apply)", async () => {
  const root = await tmp();
  await fs.writeFile(path.join(root, "b.txt"), "same\n", "utf8");
  let applied = 0;
  const editService = { apply: async () => { applied++; return {}; } };
  const host = createKernelHost({ projectRoot: root, editService });

  const r = await host.writeFile("b.txt", "same\n");
  assert.equal(r.unchanged, true);
  assert.equal(applied, 0);
});

test("writeFile refuses paths outside the workspace / missing files", async () => {
  const root = await tmp();
  const editService = { apply: async () => ({}) };
  const host = createKernelHost({ projectRoot: root, editService });

  const escape = await host.writeFile("../evil.txt", "x");
  assert.ok(escape.error);                          // boundary rejection
  const missing = await host.writeFile("nope.txt", "x");
  assert.ok(missing.error);                          // file must exist to diff against
});
