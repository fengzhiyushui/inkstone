/**
 * v1.11.2 E2E: config-scope MCP loading must reach the kernel through the real
 * entry point (buildKernelOptions → createKernel → McpHub).
 *
 * Regression guard: before this, MCP config scopes were hub-only and
 * `buildKernelOptions` dropped `config.inputs` entirely, so `.mcp.json`
 * never reached the product.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createKernel } from "../../src/index.js";
import { buildKernelOptions } from "../../src/apps/kernel-options.js";

async function tmpProject() {
  const root = await mkdtemp(path.join(tmpdir(), "inkstone-mcp-scope-e2e-"));
  await mkdir(path.join(root, ".deepseek-code"), { recursive: true });
  return root;
}

test("buildKernelOptions → createKernel loads .mcp.json servers and inputs", async () => {
  const root = await tmpProject();
  try {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          dotfile: { command: process.execPath, args: ["-e", "0"], disabled: true }
        },
        inputs: { tok: { type: "promptString", password: true, default: "d" } }
      })
    );

    const options = await buildKernelOptions(root, {}, async () => ({
      apiKey: "test-dummy-key",
      baseUrl: "https://example.invalid",
      inputs: { cfg: { type: "promptString", default: "from-config" } }
    }));

    // inputs declared in the project config survive the options bridge
    assert.deepEqual(options.inputs, { cfg: { type: "promptString", default: "from-config" } });
    assert.equal(options.loadMcpConfigScopes, true);

    const kernel = await createKernel(root, options);
    try {
      const servers = kernel.mcp.listServers();
      const ids = servers.map((s) => s.serverId);
      assert.ok(ids.includes("dotfile"), `.mcp.json server missing from kernel.mcp (got: ${ids.join(",")})`);
    } finally {
      await kernel.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("kernel.mcp exposes listInputs/setInputValue wired to the hub", async () => {
  const root = await tmpProject();
  try {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: {},
        inputs: { tok: { type: "promptString", password: true, default: "d1" } }
      })
    );

    const kernel = await createKernel(root, {
      deepseek: { apiKey: "test-dummy-key" },
      loadMcpConfigScopes: true
    });
    try {
      const inputs = kernel.mcp.listInputs();
      assert.ok(Array.isArray(inputs), "listInputs must return an array");
      const tok = inputs.find((i) => i.name === "tok");
      assert.ok(tok, "project .mcp.json input must be visible through kernel.mcp");
      assert.equal(tok.password, true);

      kernel.mcp.setInputValue("tok", "user-supplied");
      const after = kernel.mcp.listInputs().find((i) => i.name === "tok");
      assert.equal(after.hasValue, true);
    } finally {
      await kernel.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});

test("loadMcpConfigScopes:false keeps .mcp.json out of the kernel (opt-out works)", async () => {
  const root = await tmpProject();
  try {
    await writeFile(
      path.join(root, ".mcp.json"),
      JSON.stringify({
        mcpServers: { dotfile: { command: process.execPath, args: ["-e", "0"], disabled: true } }
      })
    );

    const kernel = await createKernel(root, {
      deepseek: { apiKey: "test-dummy-key" },
      loadMcpConfigScopes: false
    });
    try {
      const ids = kernel.mcp.listServers().map((s) => s.serverId);
      assert.equal(ids.includes("dotfile"), false, ".mcp.json must be ignored when scopes are off");
    } finally {
      await kernel.dispose();
    }
  } finally {
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
});
