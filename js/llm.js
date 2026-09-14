/* ============================================================
   拾藏 · LLM 提炼（OpenAI 兼容格式）
   ------------------------------------------------------------
   配置存于 localStorage（shizang.llm.config），不写入源码：
     { endpoint: "https://api.xxx.com/v1/chat/completions",
       model: "xxx",
       key: "sk-..." }
   调用失败或无配置时返回 null，由调用方降级为模拟提炼。
   ⚠️ CORS：若浏览器直调被拦截（多数平台不允许网页跨域调用），
      请改用本地代理方式（见 README「接入真实 LLM」方式 B）。
   ============================================================ */
(function () {
  "use strict";

  const CFG_KEY = "shizang.llm.config";

  function getConfig() {
    try { return JSON.parse(localStorage.getItem(CFG_KEY) || "{}"); }
    catch (e) { return {}; }
  }

  function saveConfig(cfg) {
    localStorage.setItem(CFG_KEY, JSON.stringify(cfg || {}));
  }

  function hasConfig() {
    const c = getConfig();
    return !!(c.endpoint && c.model && c.key);
  }

  // 从 LLM 返回文本中解析 { corePoints, cards }
  function parseResult(text) {
    text = (text || "").trim();
    // 尝试提取 JSON 块
    const m = text.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        const obj = JSON.parse(m[0]);
        if (obj.corePoints || obj.cards) return normalize(obj);
      } catch (e) { /* 继续走文本解析 */ }
    }
    // 文本解析：corePoints = 按行/符号分点；cards 兜底生成
    const lines = text.split(/\n+/)
      .map(function (s) { return s.replace(/^[-*•\d.、\s]+/, "").trim(); })
      .filter(function (s) { return s.length >= 8; });
    const core = lines.slice(0, 3);
    if (!core.length) return null;
    return {
      corePoints: core,
      cards: [
        { type: "qa", front: "这篇文章的核心观点是什么？", back: core[0], note: "用自己的话复述" },
        { type: "qa", front: "读完这篇，你能立刻做的一件事是什么？", back: (core[1] || core[0]), note: "行动卡片" }
      ]
    };
  }

  function normalize(obj) {
    const core = (obj.corePoints || []).filter(function (s) { return typeof s === "string" && s.trim(); }).slice(0, 3);
    const cards = (obj.cards || []).slice(0, 3).map(function (c) {
      return { type: "qa", front: String(c.front || ""), back: String(c.back || ""), note: String(c.note || "") };
    });
    if (!core.length && !cards.length) return null;
    return { corePoints: core, cards: cards };
  }

  // 提炼单条收藏：返回 { corePoints, cards } 或 null（失败/未配置）
  async function summarize(item) {
    const cfg = getConfig();
    if (!cfg.endpoint || !cfg.model || !cfg.key) return null;
    const sys = "你是「拾藏」的知识提炼助手。用户会给你一篇知乎收藏的原文（标题+正文）。请：\n" +
      "1. 提炼 3 条核心观点，每条不超过 45 字，必须概括文章真正的主要意思，不要复述引言或铺垫；\n" +
      "2. 生成 2 张复习卡片：第 1 张考核心观点，第 2 张考行动方法（读了这篇能立刻做什么）；\n" +
      "3. 只输出 JSON：{\"corePoints\": [\"...\"], \"cards\": [{\"front\": \"...\", \"back\": \"...\", \"note\": \"...\"}]}";
    const user = "标题：" + item.title + "\n\n正文：\n" + (item.content || "").slice(0, 6000);

    let res;
    try {
      res = await fetch(cfg.endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Authorization": "Bearer " + cfg.key
        },
        body: JSON.stringify({
          model: cfg.model,
          messages: [
            { role: "system", content: sys },
            { role: "user", content: user }
          ],
          temperature: 0.4,
          max_tokens: 1200
        })
      });
    } catch (e) {
      return { error: "网络错误：" + e.message };
    }

    if (!res.ok) {
      let detail = "";
      try { const d = await res.json(); detail = (d.error && d.error.message) || JSON.stringify(d).slice(0, 120); } catch (e) { /* ignore */ }
      return { error: "API " + res.status + "：" + (detail || res.statusText) };
    }

    let data;
    try { data = await res.json(); } catch (e) { return { error: "响应解析失败" }; }
    const content = data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    if (!content) return { error: "模型未返回内容" };

    const parsed = parseResult(content);
    return parsed || { error: "模型返回格式无法解析" };
  }

  window.ShizangLLM = { summarize: summarize, getConfig: getConfig, saveConfig: saveConfig, hasConfig: hasConfig };
})();
