import { indexWorkspace } from "./workspace-indexer.js";

// v1.19.0 由顶层 src/context.js 迁入：`inkstone scan` 需要的「项目上下文索引」
// 改建立在 context 域现有的 workspace-indexer 之上（同一套遍历、读取与跳过
// 规则），不再维护第二条文件枚举实现。原 context.js 同时对外的
// listProjectFiles / readTextFile / resolveInsideRoot 随文件删除：
// 路径解析统一走 ../workspace/path-safety.js。

// 重要文件的挑选口径与 context-unit 的 priority 对齐：manifest / readme 最前，
// 其余按字典序。只影响 `inkstone scan` 打印的片段取舍，不影响上下文引擎本身。
const IMPORTANT_FILE_COUNT = 30;
const SNIPPET_BYTES = 4000;

// 点号开头的目录/文件默认不进 `inkstone scan` 的项目清单（本地配置、助手状态目录
// 等既不是项目源码，也可能夹带密钥）；仅放行这两个约定俗成的示例文件。
// 与已删除的 src/context.js listProjectFiles 的口径保持一致。
const VISIBLE_DOTFILES = new Set([".env.example", ".gitignore"]);

export async function buildProjectContext(root, options = {}) {
  const maxFiles = options.maxFiles ?? 400;
  const maxBytes = options.maxBytes ?? 60_000;
  const { units, stats } = await indexWorkspace({ root, options: { maxFiles } });
  const files = [...units.keys()]
    .filter((file) => isVisibleProjectFile(file))
    .sort((a, b) => a.localeCompare(b));

  const important = rankImportantFiles(files).slice(0, IMPORTANT_FILE_COUNT);
  const snippets = [];
  let usedBytes = 0;

  for (const file of important) {
    const snippet = units.get(file)?.snippet;
    if (!snippet) {
      continue;
    }
    const piece = [`--- ${file}`, snippet.slice(0, SNIPPET_BYTES)].join("\n");
    usedBytes += Buffer.byteLength(piece, "utf8");
    if (usedBytes > maxBytes) {
      break;
    }
    snippets.push(piece);
  }

  return {
    files,
    stats,
    indexText: [
      `项目根目录：${root}`,
      `已索引文件数：${files.length}`,
      "",
      files.join("\n"),
      "",
      snippets.length ? "重要文件片段：" : "",
      snippets.join("\n\n")
    ].join("\n")
  };
}

function isVisibleProjectFile(file) {
  const segments = file.split("/");
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (!segment.startsWith(".")) continue;
    const isLast = index === segments.length - 1;
    if (isLast && VISIBLE_DOTFILES.has(segment)) continue;
    return false;
  }
  return true;
}

function rankImportantFiles(files) {
  const priority = [
    "README.md",
    "package.json",
    "tsconfig.json",
    "pyproject.toml",
    "Cargo.toml",
    "go.mod",
    "pom.xml",
    "build.gradle",
    ".gitignore"
  ];

  return [...files].sort((a, b) => {
    const pa = priority.indexOf(a);
    const pb = priority.indexOf(b);
    if (pa !== -1 || pb !== -1) {
      return (pa === -1 ? 999 : pa) - (pb === -1 ? 999 : pb);
    }
    return a.localeCompare(b);
  });
}
