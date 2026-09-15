/* 拾藏 · 本地桥（注入到拾藏页面）
   接收插件消息，读写拾藏 localStorage 并通知页面刷新。
   注意：STORAGE_KEY 必须与 js/app.js 保持一致。 */
(function () {
  "use strict";
  const STORAGE_KEY = "shizang.items.v3";

  function loadItems() {
    try {
      const items = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
      return Array.isArray(items) ? items : [];
    } catch (e) { return []; }
  }
  function saveItems(items) {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(items));
  }
  // 统一 URL：去掉 utm 等跟踪参数，便于跨来源匹配
  function normUrl(u) {
    if (!u) return "";
    return String(u).split("?")[0].replace(/\/+$/, "");
  }
  // 匹配键：知乎会把 /answer/N 重定向为 /question/Q/answer/N，
  // 因此按内容 ID 匹配（回答/文章/问题），而不是整串 URL
  function keyOf(u) {
    const s = normUrl(u);
    let m = s.match(/\/answer\/(\d+)/);
    if (m) return "a:" + m[1];
    m = s.match(/\/p\/(\d+)/);
    if (m) return "p:" + m[1];
    m = s.match(/\/question\/(\d+)/);
    if (m) return "q:" + m[1];
    return s;
  }
  function sameKey(a, b) {
    const ka = keyOf(a), kb = keyOf(b);
    return !!ka && ka === kb;
  }
  function makeItem(raw, contentSource) {
    return {
      id: "imp_" + Date.now() + "_" + Math.floor(Math.random() * 1000),
      title: raw.title || "未命名收藏",
      type: raw.type === "文章" ? "文章" : "回答",
      url: raw.url || "",
      topic: "其他",
      savedAt: raw.savedAt || new Date().toISOString().slice(0, 10),
      content: raw.content || raw.summary || "",
      contentSource: contentSource || "full",
      status: "pending",
      corePoints: [],
      cards: [],
      review: { reps: 0, ease: 2.5, interval: 0, due: 0 }
    };
  }

  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || typeof msg.type !== "string") return;
    try {
      const items = loadItems();

      // 单条自动导入（插件抓取当前页）
      if (msg.type === "SHIZANG_IMPORT") {
        const raw = msg.item;
        if (!raw || !raw.title || !raw.content) {
          sendResponse({ ok: false, error: "缺少 title / content 字段" });
          return;
        }
        // 同内容已存在时，升级为全文而不是重复添加
        const hit = items.find(function (i) { return sameKey(i.url, raw.url); });
        if (hit) {
          const updated = hit.contentSource !== "full";
          hit.title = raw.title || hit.title;
          hit.content = raw.content;
          hit.contentSource = "full";
          saveItems(items);
          window.dispatchEvent(new CustomEvent("shizang:imported"));
          sendResponse({ ok: true, count: items.length, id: hit.id, updated: updated });
          return;
        }
        const item = makeItem(raw, "full");
        items.push(item);
        saveItems(items);
        window.dispatchEvent(new CustomEvent("shizang:imported"));
        sendResponse({ ok: true, count: items.length, id: item.id });
        return;
      }

      // 全文回填（content script 自动检测：拾藏已有同内容条目 → 补全文）
      if (msg.type === "SHIZANG_BACKFILL") {
        const raw = msg.item;
        if (!raw || !raw.url || !raw.content) { sendResponse({ ok: false, error: "bad payload" }); return; }
        const hit = items.find(function (i) { return sameKey(i.url, raw.url); });
        if (!hit) { sendResponse({ ok: true, matched: false }); return; }
        const upgraded = hit.contentSource !== "full";
        const hadExtract = hit.status !== "pending" && (hit.corePoints || []).length > 0;
        hit.content = raw.content;
        hit.title = raw.title || hit.title;
        hit.author = raw.author || hit.author;
        hit.type = raw.type || hit.type;
        hit.contentSource = "full";
        // 摘要 → 全文升级且已有旧提炼：标记需用全文重新提炼（保留旧卡片，由拾藏侧自动重提炼）
        if (upgraded && hadExtract) hit.needsReextract = true;
        saveItems(items);
        window.dispatchEvent(new CustomEvent("shizang:backfilled", { detail: { ids: [hit.id], updated: upgraded } }));
        sendResponse({ ok: true, matched: true, id: hit.id, updated: upgraded, needsReextract: !!hit.needsReextract });
        return;
      }

      // 收藏夹页批量导入（content script 滚动整页后调用）
      if (msg.type === "SHIZANG_BATCH_IMPORT") {
        const rawItems = msg.items || [];
        if (!rawItems.length) { sendResponse({ ok: false, error: "empty" }); return; }
        let added = 0, skipped = 0;
        rawItems.forEach(function (raw) {
          if (!raw || !raw.url) return;
          const exists = items.some(function (i) { return sameKey(i.url, raw.url); });
          if (exists) { skipped++; return; }
          items.push(makeItem(raw, "summary"));
          added++;
        });
        saveItems(items);
        window.dispatchEvent(new CustomEvent("shizang:imported"));
        sendResponse({ ok: true, count: items.length, added: added, skipped: skipped });
        return;
      }

      // 返回待补全全文的条目（批量回填队列用）
      if (msg.type === "SHIZANG_GET_PENDING") {
        const pending = items
          .filter(function (i) { return i.contentSource !== "full" && i.url; })
          .map(function (i) { return { id: i.id, title: i.title, url: i.url }; });
        sendResponse({ ok: true, items: pending });
        return;
      }
    } catch (e) {
      sendResponse({ ok: false, error: e.message });
    }
    return true;
  });

  // 打开指定收藏的详情页
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (!msg || msg.type !== "SHIZANG_OPEN") return;
    window.dispatchEvent(new CustomEvent("shizang:open", { detail: { id: msg.id } }));
    sendResponse({ ok: true });
    return true;
  });

  // 页面打开时上报地址（供插件弹窗「打开拾藏」一键直达）
  chrome.runtime.sendMessage({ type: "SHIZANG_PAGE_READY", url: location.href }, function () {});
})();
