/* 拾藏 · 后台服务（批量补全全文队列）
   流程：弹窗点「批量补全全文」→ 从拾藏取所有未回填条目 → 逐个后台打开知乎页面，
   content.js 自动提取全文并回填 → 关闭页面 → 工具栏图标显示进度（n/总数）。
   用 chrome.alarms 驱动，避免 service worker 空闲休眠中断队列。 */
(function () {
  "use strict";

  const BATCH_KEY = "shizang.batch";
  const ALARM = "shizang-batch";
  const PER_URL_MS = 40000; // 单篇总超时

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

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  // 自包含提取函数（executeScript 注入用；后台标签定时器被节流，故由后台轮询注入驱动）
  function EXTRACT_FUNC() {
    function clean(s) { return (s || "").replace(/\s+/g, " ").trim(); }
    const isArticle = !!(document.querySelector(".Post-RichTextContainer") || document.querySelector("h1.Post-Title"));
    let title = clean(document.title.replace(/\s*[-_|]\s*知乎.*$/, ""));
    let author = "", content = "", type = isArticle ? "article" : "answer";
    if (isArticle) {
      const ae = document.querySelector(".AuthorInfo-name") || document.querySelector("meta[name='author']");
      if (ae) author = clean(ae.getAttribute("content") || ae.textContent);
      const b = document.querySelector(".Post-RichTextContainer .RichText") ||
        document.querySelector(".Post-RichTextContainer") || document.querySelector(".RichText");
      content = b ? b.innerText : "";
      if (!title) { const h = document.querySelector("h1.Post-Title, .Post-Title"); if (h) title = clean(h.textContent); }
    } else {
      const ae = document.querySelector(".List-item .AuthorInfo-name, .List-item .UserLink-link");
      if (ae) author = clean(ae.textContent);
      const b = document.querySelector(".List-item .RichContent-inner .RichText") ||
        document.querySelector(".RichContent-inner .RichText") || document.querySelector(".RichText");
      content = b ? b.innerText : "";
      if (!title) { const q = document.querySelector("h1.QuestionHeader-title"); if (q) title = clean(q.textContent); }
    }
    title = title.replace(/\s*[-_|]\s*知乎\s*$/, "").trim();
    return { title: title || "未识别标题", url: location.href, author: author, type: type,
             content: content || "未能提取到正文，请确认页面已加载完成。" };
  }

  async function waitTabComplete(tabId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const t = await chrome.tabs.get(tabId);
        if (t.status === "complete") return true;
      } catch (e) { return false; }
      await sleep(1500);
    }
    return false;
  }

  // 后台轮询注入提取脚本（executeScript 不受后台标签定时器节流影响）
  async function extractFromTab(tabId, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const res = await chrome.scripting.executeScript({ target: { tabId: tabId }, func: EXTRACT_FUNC });
        const data = res && res[0] && res[0].result;
        if (data && data.content && data.content.indexOf("未能提取") !== 0 && data.content.length > 50) return data;
      } catch (e) { /* 页面未就绪 */ }
      await sleep(3000);
    }
    return null;
  }

  function setBadge(text) {
    chrome.action.setBadgeText({ text: text || "" });
    chrome.action.setBadgeBackgroundColor({ color: "#0a84ff" });
  }

  async function updateBadge() {
    const st = (await chrome.storage.local.get(BATCH_KEY))[BATCH_KEY];
    if (!st || !st.running) { setBadge(""); return; }
    setBadge(st.done + "/" + st.total);
  }

  // 启动批量补全（弹窗调用）
  async function startBatch(sendResponse) {
    const r = await askShizang({ type: "SHIZANG_GET_PENDING" });
    if (!r) {
      if (sendResponse) sendResponse({ ok: false, error: "no_shizang" });
      return;
    }
    const pending = r.items || [];
    await chrome.storage.local.set({
      [BATCH_KEY]: { queue: pending, done: 0, total: pending.length, running: pending.length > 0, failed: [] }
    });
    if (pending.length) {
      await chrome.alarms.create(ALARM, { periodInMinutes: 4 / 60 });
    }
    await updateBadge();
    if (sendResponse) sendResponse({ ok: true, total: pending.length });
  }

  async function finish(st) {
    st.running = false;
    await chrome.storage.local.set({ [BATCH_KEY]: st });
    await chrome.alarms.clear(ALARM);
    setBadge("");
  }

  // 弹窗查询：附带失败清单
  async function batchStatus(sendResponse) {
    const st = (await chrome.storage.local.get(BATCH_KEY))[BATCH_KEY];
    if (!st) { sendResponse({ ok: true, running: false, done: 0, total: 0, failed: [] }); return; }
    sendResponse({ ok: true, running: st.running, done: st.done, total: st.total, failed: st.failed || [] });
  }

  chrome.alarms.onAlarm.addListener(async function (alarm) {
    if (alarm.name !== ALARM) return;
    const st = (await chrome.storage.local.get(BATCH_KEY))[BATCH_KEY];
    if (!st || !st.running) return;
    const next = st.queue[st.done];
    if (!next || !next.url) { await finish(st); return; }

    let tab = null;
    let ok = false;
    try {
      tab = await chrome.tabs.create({ url: next.url, active: false });
      const ready = await waitTabComplete(tab.id, 15000);
      const data = ready ? await extractFromTab(tab.id, PER_URL_MS - 15000) : null;
      if (data) {
        const r = await askShizang({ type: "SHIZANG_BACKFILL", item: data });
        ok = !!(r && r.ok && r.matched);
      }
    } catch (e) {
      st.failed.push(next.title || next.url);
    } finally {
      if (tab && tab.id) { try { await chrome.tabs.remove(tab.id); } catch (e) { /* ignore */ } }
    }
    if (!ok) st.failed.push(next.title || next.url);
    st.done += 1;
    await chrome.storage.local.set({ [BATCH_KEY]: st });
    // 全部处理完 → 立即收尾（清 alarm / badge / 状态），不等下一次定时触发
    if (st.done >= st.total) {
      await finish(st);
      return;
    }
    await updateBadge();
  });

  // 弹窗消息入口
  chrome.runtime.onMessage.addListener(function (msg, sender, sendResponse) {
    if (msg && msg.type === "SHIZANG_BATCH_START") {
      startBatch(sendResponse);
      return true; // 异步响应
    }
    if (msg && msg.type === "SHIZANG_BATCH_STATUS") {
      batchStatus(sendResponse);
      return true;
    }
    if (msg && msg.type === "SHIZANG_BATCH_STOP") {
      chrome.storage.local.get(BATCH_KEY, function (st) {
        const s = st[BATCH_KEY];
        if (s) { s.running = false; chrome.storage.local.set({ [BATCH_KEY]: s }); }
        chrome.alarms.clear(ALARM);
        setBadge("");
        sendResponse({ ok: true });
      });
      return true;
    }
    // 拾藏页面打开时上报地址（供弹窗「打开拾藏」一键直达）
    if (msg && msg.type === "SHIZANG_PAGE_READY") {
      if (msg.url) chrome.storage.local.set({ shizangUrl: msg.url });
      sendResponse({ ok: true });
      return true;
    }
    // content.js 回填完成上报：记录后立即结束该篇等待
    if (msg && msg.type === "SHIZANG_BACKFILLED") {
      backfilledUrls[msg.url] = true;
      sendResponse({ ok: true });
      return true;
    }
    return false;
  });
})();
