// gui/src/state/themes.js — v1.4.0 十套主题元数据(与 tokens.css 的 [theme="<id>"] 对应)。
export const TIERS = ["dark", "dim", "tint", "light"];
export const GUI_THEMES = [
  { id: "sumi",   name: "墨", tier: "dark",  group: "dark",  family: "Kanagawa Wave" },
  { id: "slate",  name: "玄", tier: "dark",  group: "dark",  family: "Tokyo Night Storm" },
  { id: "vesper", name: "烬", tier: "dark",  group: "dark",  family: "Vesper" },
  { id: "nord",   name: "峡", tier: "dim",   group: "dark",  family: "Nord" },
  { id: "ash",    name: "灰", tier: "dim",   group: "dark",  family: "Zenburn" },
  { id: "snow",   name: "霜", tier: "tint",  group: "light", family: "Nord Snow Storm" },
  { id: "sand",   name: "沙", tier: "tint",  group: "light", family: "Gruvbox Light Soft" },
  { id: "lotus",  name: "荷", tier: "light", group: "light", family: "Kanagawa Lotus" },
  { id: "latte",  name: "瓷", tier: "light", group: "light", family: "Catppuccin Latte" },
  { id: "paper",  name: "宣", tier: "light", group: "light", family: "Flexoki Light" }
];
export function themesByTier() {
  return Object.fromEntries(TIERS.map((t) => [t, GUI_THEMES.filter((x) => x.tier === t)]));
}

export function themeLabel(theme) {
  const found = GUI_THEMES.find((x) => x.id === theme);
  return found ? found.name : "墨";
}

export function isLightTheme(theme) {
  return GUI_THEMES.find((x) => x.id === theme)?.group === "light";
}
