// src/apps/tui/paint.js — 底部固定区计算(纯)+ painter(唯一写终端的地方,write 可注入)。
import { seq, displayWidth, truncateToWidth } from "./ansi.js";
import { statusLine } from "./tui-state.js";
import { tc as color } from "./theme.js";

const MENU_MAX = 6;
const STREAM_MAX = 3;

export function computeBottom(state, t, columns) {
  const width = Math.max(20, Number(columns) || 80);
  const sep = color.dim("─".repeat(Math.min(width - 1, 120)));
  const status = color.dim(truncateToWidth(statusLine(state, t), width - 1));

  const overlay = state.mcpInputOverlay || state.overlay;
  if (overlay) {
    const lines = [sep, ...overlay.lines, status];
    const cursorRow = overlay.cursorRow == null ? lines.length - 1 : overlay.cursorRow + 1;
    const cursorCol = overlay.cursorCol == null ? 1 : overlay.cursorCol;
    return { lines, cursorRow, cursorCol };
  }

  const streamLines = state.busy && state.stream
    ? state.stream.split("\n").slice(-STREAM_MAX).map((l) => ` ${truncateToWidth(l, width - 2)}`)
    : [];

  // hint 独立行渲染(不随状态行截断;v1.4.0 状态行因 sh:/theme 变长后仍可见)
  const hintLines = state.hint ? [` ${color.dim(`· ${state.hint}`)}`] : [];

  const menuLines = [];
  if (state.menu && state.menu.items.length) {
    const items = state.menu.items;
    const start = Math.max(0, Math.min(state.menu.index - (MENU_MAX - 1), items.length - MENU_MAX));
    for (let i = start; i < Math.min(items.length, start + MENU_MAX); i += 1) {
      const item = items[i];
      const label = ` /${item.name} `;
      const desc = color.dim(truncateToWidth(item.desc, Math.max(0, width - displayWidth(label) - 3)));
      menuLines.push(i === state.menu.index ? ` ${color.inverse(label)}${desc}` : ` ${label}${desc}`);
    }
  }

  let inputLine;
  let cursorCol;
  if (state.sensitiveNotice) {
    // 红色、且措辞明确区别于审批 —— 见 apps/sensitive-notice-contract.js 的策略
    inputLine = ` ${color.red(t("input.sensitive"))}`;
    cursorCol = 1;
  } else if (state.approval) {
    inputLine = ` ${color.yellow(t("input.approval"))}`;
    cursorCol = 1;
  } else {
    const chars = Array.from(state.input.text);
    let from = 0; // 尾窗:光标必须可见
    while (displayWidth(chars.slice(from, state.input.cursor).join("")) > width - 8) from += 1;
    const visible = chars.slice(from).join("");
    inputLine = visible
      ? ` ❯ ${truncateToWidth(visible, width - 5)}`
      : ` ❯ ${color.dim(truncateToWidth(t("input.placeholder"), width - 5))}`;
    cursorCol = 4 + displayWidth(chars.slice(from, state.input.cursor).join(""));
  }

  const lines = [...streamLines, ...hintLines, sep, ...menuLines, inputLine, status];
  return { lines, cursorRow: lines.length - 2, cursorCol };
}

export function createPainter({ write }) {
  let height = 0;
  let parkRow = 0;

  function paint({ append = [], bottom, cursorRow, cursorCol }) {
    let out = "\r" + seq.up(parkRow);
    if (height > 0) out += seq.clearDown;
    for (const line of append) out += `${line}\n`;
    out += bottom.join("\n");
    out += "\r" + seq.up(bottom.length - 1 - cursorRow) + seq.col(cursorCol);
    write(out);
    height = bottom.length;
    parkRow = cursorRow;
  }

  function teardown() {
    if (height > 0) write("\r" + seq.down(height - 1 - parkRow) + "\n");
    height = 0;
    parkRow = 0;
  }

  return { paint, teardown };
}
