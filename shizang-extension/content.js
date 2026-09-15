/* 拾藏 · 知乎内容脚本（自动运行）
   两类工作：
   A. 文章 / 回答页：自动提取全文 → 若拾藏中已有同链接条目则回填全文（浏览即补全）
   B. 收藏夹页面（/collection/）：自动滚动到底 → 收集全部收藏项 → 批量导入拾藏
   依赖 extract.js（已在 content_scripts 中先于本文件注入）。 */
(function () {
  "use strict";

  if (!/zhihu\.com$/.test(location.hostname)) return;

  // 查找拾藏页面 tab 并发送消息
  function askShizang(msg) {
    return new Promise(function (resolve) {
      chrome.tabs.query({}, function (tabs) {
        const target = (tabs || []).find(function (t) {
          return /index\.html|127\.0\.0\.1|localhost/.test(t.url || "");
        });
        if (!target || !target.id) return resolve(null);
        try {
          chrome.tabs.sendMessage(target.id, msg, function (r) {
            if (chrome.runtime.lastError) return resolve(null);
            resolve(r && r.ok ? r : null);
          });
        } catch (e) { resolve(null); }
      });
    });
  }

  function isCollectionPage() {
    return /\/collection\/\d+/.test(location.pathname);
  }

  // A. 收藏夹页：滚动加载全部，收集收藏项
  async function collectCollection() {
    let last = 0, stable = 0;
    for (let i = 0; i < 60; i++) {
      window.scrollTo(0, document.body.scrollHeight);
      await new Promise(function (r) { setTimeout(r, 700); });
      const h = document.body.scrollHeight;
      if (h === last) { stable++; if (stable >= 3) break; } else { stable = 0; }
      last = h;
    }
    const seen = {};
    const items = [];
    document.querySelectorAll(".CollectionItem, .ContentItem, .List-item").forEach(function (node) {
      const link = node.querySelector('a[href*="/answer/"], a[href*="/question/"], a[href*="/p/"]');
      if (!link) return;
      let url = link.href || "";
      url = url.split("?")[0];
      if (!/^https?:\/\/(www\.)?zhihu\.com|^https?:\/\/zhuanlan\.zhihu\.com/.test(url)) return;
      if (seen[url]) return;
      seen[url] = 1;
      const titleEl = node.querySelector(".ContentItem-title, h2, h1");
      const title = (titleEl ? titleEl.textContent : "").replace(/\s+/g, " ").trim().slice(0, 120);
      const sumEl = node.querySelector(".RichText");
      const summary = sumEl ? sumEl.innerText.replace(/\s+/g, " ").trim().slice(0, 500) : "";
      items.push({ title: title || "未命名收藏", url: url, summary: summary });
    });
    return items;
  }

  // B. 文章 / 回答页：提取全文 → 回填
  // 知乎回答页为动态渲染，轮询等待正文出现（后台标签定时器会被节流，用短间隔轮询更稳）
  async function backfillCurrent() {
    if (typeof extract !== "function") return null;
    const deadline = Date.now() + 25000;
    let data = null;
    while (Date.now() < deadline) {
      data = extract();
      if (data && data.content && data.content.indexOf("未能提取") !== 0 && data.content.length > 50) break;
      await new Promise(function (r) { setTimeout(r, 1000); });
    }
    if (!data || !data.content || data.content.indexOf("未能提取") === 0) return null;
    const r = await askShizang({ type: "SHIZANG_BACKFILL", item: data });
    return r;
  }

  (async function main() {
    try {
      if (isCollectionPage()) {
        const items = await collectCollection();
        if (!items.length) return;
        const r = await askShizang({ type: "SHIZANG_BATCH_IMPORT", items: items });
        if (r) {
          chrome.runtime.sendMessage({ type: "SHIZANG_COLLECTION_IMPORTED", count: r.count, added: r.added, skipped: r.skipped });
        }
      } else {
        const r = await backfillCurrent();
        if (r && r.ok && r.matched) {
          chrome.runtime.sendMessage({
            type: "SHIZANG_BACKFILLED",
            url: location.href,
            updated: !!r.updated
          });
        }
      }
    } catch (e) { /* 静默：不打扰浏览 */ }
  })();
})();
