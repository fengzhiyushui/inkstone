// Build a nested folder tree from a flat list of posix relative file paths.
// Pure — node:test-covered. Dirs sort before files; each group alphabetical.
export function buildTree(paths) {
  const root = new Map();
  for (const p of paths || []) {
    const parts = String(p).split("/").filter(Boolean);
    let level = root;
    let acc = "";
    parts.forEach((part, i) => {
      acc = acc ? acc + "/" + part : part;
      const isFile = i === parts.length - 1;
      if (!level.has(part)) {
        level.set(part, { name: part, path: acc, type: isFile ? "file" : "dir", children: isFile ? null : new Map() });
      }
      const node = level.get(part);
      if (!isFile) level = node.children;
    });
  }
  return toArray(root);
}

function toArray(level) {
  const nodes = [...level.values()];
  nodes.sort((a, b) => {
    if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
    return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
  });
  return nodes.map((n) =>
    n.type === "dir"
      ? { name: n.name, path: n.path, type: "dir", children: toArray(n.children) }
      : { name: n.name, path: n.path, type: "file" }
  );
}

// B3 dock 文件树:与 buildTree 同排序,节点 type 用 "directory"|"file"(dock 面板契约)
export function treeFromPaths(paths) {
  const seen = new Set();
  const unique = [];
  for (const p of paths || []) {
    const key = String(p || "").replace(/\\/g, "/").replace(/^\.\//, "");
    if (!key || seen.has(key)) continue;
    seen.add(key);
    unique.push(key);
  }
  return buildTree(unique).map(normalizeDockNode);
}

function normalizeDockNode(n) {
  const type = n.type === "dir" || n.type === "directory" ? "directory" : "file";
  const node = { name: n.name, path: n.path, type };
  if (type === "directory") node.children = (n.children || []).map(normalizeDockNode);
  return node;
}
