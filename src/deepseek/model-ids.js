// src/deepseek/model-ids.js — 官方现行模型 ID 与退役迁移(v1.9.0 M1-P0)。
// 单一常量源:src/config.js 的 DEFAULT_CONFIG.models 与 src/deepseek/model-router.js 的
// DEFAULT_MODELS 都从这里取,消除「config 显示 A、实际发 B」的双源头漂移。
//
// 退役迁移只做精确键匹配(RETIRED_MODELS),未知 id 一律原样——模型 id 是开放字符串,
// README/DEPLOYMENT 文档化支持 Ollama/vLLM/OneAPI 等第三方端点(示例形如
// deepseek-coder-v2:latest),绝不可像 v1.8.0 主题迁移那样「未知→兜底」,
// 否则会把第三方端点用户的模型名改写成官方 ID,直接打断兼容端点。

// 官方现售(2026-09 核对):deepseek-flash = V4.1-Flash(1M 上下文);
// deepseek-v4-pro = V4-Pro-0813。旧名 deepseek-v4-flash(V4-Flash)已退役,
// legacy 会路由到 V4.1-Flash,但官方推荐写 deepseek-flash。
export const CURRENT_MODELS = Object.freeze({
  act: "deepseek-flash",
  // think 维持 pro:V4-Pro 流量自 2026-09-14 起被临时路由到 V4.1-Flash 并按 Flash
  // 计费(直至 V4.1-Pro 发布),成本模型失真但行为正确;不临时降档(维护者 2026-09-23 拍板)。
  think: "deepseek-v4-pro",
  // FIM 官方仅 non-thinking,Flash 档足够;旧默认 pro 是浪费。
  fim: "deepseek-flash"
});

// 已知退役 → 现行 id 的精确映射。deepseek-chat / deepseek-reasoner(2026-07-24 停用)
// 暂不纳入:兼容端点用户可能故意沿用旧名(维护者 2026-09-23 拍板,D5)。
// 迁移仅内存归一,不静默重写用户 config.json;幂等(新 id 不在键集内)。
const RETIRED_MODELS = Object.freeze({
  "deepseek-v4-flash": "deepseek-flash"
});

export function migrateModelId(id) {
  if (typeof id !== "string") return id;
  return Object.prototype.hasOwnProperty.call(RETIRED_MODELS, id) ? RETIRED_MODELS[id] : id;
}
