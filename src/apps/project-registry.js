// src/apps/project-registry.js — 全局项目 MRU 注册表(~/.deepseek-code/projects.json,随用户主目录)。
// 「项目列表」是 v1.4.0 新增的 app 层能力;kernel 不感知,纯 app 层数据。
// 每次打开项目即 touch → 置顶;存储原子写(tmp+rename),与 api-profiles 同一套约定。
import fsp from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

export function projectIdFromRoot(root) {
  return `proj_${createHash("sha1").update(String(root)).digest("hex").slice(0, 12)}`;
}

export function createProjectRegistry({ dir }) {
  const file = path.join(dir, "projects.json");

  async function load() {
    try {
      const raw = JSON.parse(await fsp.readFile(file, "utf8"));
      return { projects: Array.isArray(raw.projects) ? raw.projects : [] };
    } catch {
      return { projects: [] };
    }
  }

  async function persist(state) {
    await fsp.mkdir(dir, { recursive: true });
    const tmp = `${file}.${process.pid}.tmp`;
    await fsp.writeFile(tmp, JSON.stringify(state, null, 2), "utf8");
    await fsp.rename(tmp, file);
  }

  async function isDirectory(root) {
    try {
      return (await fsp.stat(root)).isDirectory();
    } catch {
      return false;
    }
  }

  async function list() {
    const state = await load();
    return await Promise.all(state.projects.map(async (p) => {
      const root = p.root;
      // 登记表是 MRU 历史:目录可能已被移动/删除(临时目录、外接盘、手工清理)。
      // 不过滤也不静默丢弃 —— 标记出来交给界面,由用户决定是否移除。
      const missing = !(await isDirectory(root));
      return {
        id: p.id,
        root,
        name: p.name || path.basename(String(root || "")),
        lastOpened: p.lastOpened || 0,
        missing
      };
    }));
  }

  // 打开/新建项目:登记并置顶;root 必须是已存在目录,否则拒绝。
  async function touch(root) {
    if (!(await isDirectory(root))) throw new Error(`project root does not exist: ${root}`);
    const state = await load();
    const id = projectIdFromRoot(root);
    const entry = { id, root, name: path.basename(root), lastOpened: Date.now() };
    state.projects = [entry, ...state.projects.filter((p) => p.id !== id)];
    await persist(state);
    return entry;
  }

  async function remove(root) {
    const state = await load();
    const id = projectIdFromRoot(root);
    state.projects = state.projects.filter((p) => p.id !== id && p.root !== root);
    await persist(state);
  }

  return { list, touch, remove };
}
