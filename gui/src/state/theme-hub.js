// gui/src/state/theme-hub.js — v1.8.0 主题中枢(纯函数):
// 同组轮换(状态行主题标签)、跨模式切换(明暗按钮)、分组查询。
// 退役 id 在此归一,调用方不必自行处理。
import { GUI_THEMES } from "./themes.js";

const LEGACY = { night: "sumi", day: "latte", dawn: "lotus", mocha: "sumi", moon: "slate", forest: "ash", clay: "vesper", rose: "sumi" };

function normalize(id, fallback = "sumi") {
  if (GUI_THEMES.some((x) => x.id === id)) return id;
  return LEGACY[id] || fallback;
}

export function groupOf(id) {
  const theme = GUI_THEMES.find((x) => x.id === normalize(id));
  return theme ? theme.group : "dark";
}

export function nextInGroup(id) {
  const current = normalize(id);
  const ids = GUI_THEMES.filter((x) => x.group === groupOf(current)).map((x) => x.id);
  const at = ids.indexOf(current);
  return ids[(at < 0 ? 0 : at + 1) % ids.length];
}

export function otherModeTheme({ theme, lastDark, lastLight } = {}) {
  return groupOf(theme) === "dark" ? normalize(lastLight, "latte") : normalize(lastDark, "sumi");
}
