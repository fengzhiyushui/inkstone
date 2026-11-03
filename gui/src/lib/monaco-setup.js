// Monaco setup for Electron + Vite: bind the LOCAL monaco (no CDN) and wire workers
// bundled by Vite (?worker). Imported once (side-effect) from main.jsx before <App>.
//
// v1.19 裁剪说明:GUI 只消费「只读代码视图 + Diff 视图」(@monaco-editor/react 的
// <Editor>/<DiffEditor>,经 loader.config({ monaco }) 注入本地实例),没有 IntelliSense、
// 诊断、格式化、跳转定义等语言服务需求。原来的全量入口 import * as monaco from
// "monaco-editor" 实际等价于 editor.main.js → editor.all.js(68 个常驻控件)+
// basic-languages 全量表(80+ 语言)+ ts/css/html/json 四个语言 worker,基线
// renderer-dist/assets/*.js 合计 12.17 MB。这里改为按需组装:
//
//   1) 入口换成 editor.api(编辑器 + Diff 的最小内核,已含 CodeEditorWidget /
//      DiffEditorWidget / createDiffEditor / colorize / 主题注册),不引 editor.all.js。
//   2) 只补「只读代码视图 + Diff 视图」确实会生效的核心控件:命令表、查找、折叠、
//      悬停链接、括号匹配、剪贴板、右键菜单、只读提示、codicon 字形等。纯编辑类
//      (suggest/comment/linesOperations/format/gotoSymbol/stickyScroll…)在只读下
//      本就无输出,或依赖未注册的语言服务,一律不引。
//   3) 按需注册主流语言 Monarch 高亮(JS/TS/Python/Markdown/CSS/HTML 等 33 个),
//      不引 basic-languages/monaco.contribution.js 全量表。
//   4) MonacoEnvironment.getWorker 只保留 editor.worker:Monarch 高亮在主线程分词器
//      完成,只读/Diff 视图不需要任何语言服务 worker。
//
// 体积:12.17 MB → 3.36 MB,减少 72.40%(详见提交说明)。
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import { loader } from "@monaco-editor/react";
import editorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";

// ---- 核心控件:编辑器 + Diff 视图需要的最小集(刻意不用 editor.all.js 全量聚合) ----
// editor.api 已经提供 monaco.editor.create / createDiffEditor 以及两个 Widget 类,
// 下面只补命令注册与常驻交互;缺什么补什么,以 npm run build:gui 与 gui-smoke 通过为准。
import "monaco-editor/esm/vs/editor/browser/coreCommands.js";
import "monaco-editor/esm/vs/editor/browser/widget/codeEditor/codeEditorWidget.js";
import "monaco-editor/esm/vs/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/esm/vs/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/esm/vs/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController.js";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding.js";
import "monaco-editor/esm/vs/editor/contrib/fontZoom/browser/fontZoom.js";
import "monaco-editor/esm/vs/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/esm/vs/editor/contrib/links/browser/links.js";
import "monaco-editor/esm/vs/editor/contrib/placeholderText/browser/placeholderText.contribution.js";
import "monaco-editor/esm/vs/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/esm/vs/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/esm/vs/base/browser/ui/codicons/codiconStyles.js";

// ---- 主流语言高亮(GUI 的 EXT_LANGUAGE 覆盖集 + 常见语言) ----
// kernel-host.js 的 EXT_LANGUAGE:js/ts/py/md/css/scss/html/yaml/sh/plaintext,
// 这里全部覆盖(plaintext 由 monaco 内核 modesRegistry 默认注册,无需引入)。
// JSON 例外:monaco 的 JSON 分词器不在 basic-languages,而在 language/json 语言服务里,
// 必须配 json.worker 才能工作——本任务按「只保留 editor.worker」裁剪,JSON diff 因此
// 退回 plaintext 兜底(不高亮但可读);如需恢复高亮须重新引入 json.worker(约 +0.39 MB)。
import "monaco-editor/esm/vs/basic-languages/bat/bat.contribution.js";
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dart/dart.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/handlebars/handlebars.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/lua/lua.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution.js";
import "monaco-editor/esm/vs/basic-languages/perl/perl.contribution.js";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution.js";
import "monaco-editor/esm/vs/basic-languages/powershell/powershell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/r/r.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scala/scala.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/swift/swift.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";

// v1.19:只保留 editor.worker。被裁掉的 ts.worker(~5.73 MB)/css.worker(~0.96 MB)/
// html.worker(~0.64 MB)/json.worker(~0.35 MB)合计约 7.68 MB,全部服务于语言服务
// (IntelliSense/诊断/格式化),只读代码视图与 Diff 视图一概用不到。Monarch 高亮走
// 主线程分词器,与 worker 无关,所以这里不再按 label 分支——所有 label 统一返回
// editorWorker,避免漏分支时 Vite 再把其他 worker 拉回产物。
self.MonacoEnvironment = {
  getWorker(_workerId, label) {
    return new editorWorker();
  }
};

loader.config({ monaco });
