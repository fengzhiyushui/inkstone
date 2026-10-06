import { readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const ignored = new Set(["node_modules", "dist", "build", "coverage", ".git"]);
async function filesIn(directory) {
  const files = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(item.name)) continue;
    const name = path.join(directory, item.name);
    if (item.isDirectory()) files.push(...await filesIn(name));
    else if (item.isFile() && /\.(?:js|mjs|cjs)$/.test(item.name)) files.push(name);
  }
  return files;
}
// node --check accepts one entrypoint; passing multiple paths silently skipped
// most modules in the old npm script. JSX is checked by the renderer build.
const queue = (await Promise.all(["bin", "src", "gui", "scripts", "tests"].map((dir) => filesIn(path.join(root, dir))))).flat().sort();
const count = queue.length;
let failures = 0;
await Promise.all(Array.from({ length: Math.min(8, count) }, async () => {
  while (queue.length) {
    const file = queue.shift();
    const passed = await new Promise((resolve) => {
      const child = spawn(process.execPath, ["--check", file], { cwd: root, stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
      let errors = "";
      child.stderr.on("data", (chunk) => { errors += chunk; });
      child.on("error", (error) => { console.error(error.message); resolve(false); });
      child.on("close", (code) => { if (code !== 0) console.error(errors || `Syntax check failed: ${path.relative(root, file)}`); resolve(code === 0); });
    });
    if (!passed) failures++;
  }
}));
console.log(`Syntax checked ${count} JavaScript files; ${failures} failed. JSX is validated by npm run build:gui.`);
process.exitCode = failures ? 1 : 0;
