/* 拾藏 · 弹窗逻辑
   流程：检查当前页是否为知乎 → 注入提取脚本 → 生成拾藏导入 JSON → 复制 */

(function () {
  "use strict";

  const $ = function (id) { return document.getElementById(id); };
  // 注意：必须用箭头函数包一层，不能直接拿 regex.test 当函数用（会丢 this 绑定）
  const isZhihu = function (s) {
    return /^(https?:\/\/)?(www\.)?zhihu\.com|^https?:\/\/zhuanlan\.zhihu\.com/.test(s || "");
  };

  function fmtToday() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  // 生成拾藏可导入的条目格式（与网页端「导入」解析一致）
  function toShizangItem(ext) {
    return {
      title: ext.title,
      url: ext.url,
      author: ext.author,
      type: ext.type === "article" ? "文章" : "回答",
      content: ext.content,
      contentSource: "full",
      savedAt: fmtToday()
    };
  }

  function setStatus(text, cls) {
    const s = $("status");
    s.textContent = text;
    s.className = "status" + (cls ? " " + cls : "");
  }

  async function init() {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const url = (tab && tab.url) || "";
      $("meta").textContent = "当前页面：\n" + (url || "(无法读取 URL，需要 tabs 权限)");
      $("meta").hidden = false;
      if (!isZhihu(url)) {
        setStatus("当前不是知乎页面。\n请先打开一篇知乎文章或回答，再点本插件。", "err");
        return;
      }
      $("btnGrab").disabled = false;
      setStatus("✓ 已识别知乎页面，可以抓取。");
    } catch (e) {
      setStatus("初始化失败：" + (e && e.message ? e.message : e), "err");
    }
  }

  async function grab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab || !tab.id) return;
    $("btnGrab").disabled = true;
    setStatus("正在读取正文…");

    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () {
          // 与 extract.js 相同的提取逻辑（executeScript 需要自包含函数体）
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
      });

      const ext = results && results[0] && results[0].result;
      if (!ext) throw new Error("提取失败");

      const item = toShizangItem(ext);
      $("json").value = JSON.stringify(item, null, 2);
      $("btnCopy").disabled = false;

      // 尝试自动导入：查找已打开的拾藏页面（本地 file/localhost 或 GitHub Pages 线上版）
      const shizangTab = (await chrome.tabs.query({}))
        .find(function (t) { return /index\.html|127\.0\.0\.1|localhost|github\.io/.test(t.url || ""); });
      if (shizangTab && shizangTab.id) {
        try {
          const resp = await chrome.tabs.sendMessage(shizangTab.id, { type: "SHIZANG_IMPORT", item: item });
          if (resp && resp.ok) {
            lastImportedId = resp.id;
            $("btnOpen").hidden = false;
            $("btnCopy").textContent = "已自动导入 ✓";
            setStatus("✓ 已自动导入拾藏（共 " + resp.count + " 条）。\n点「打开拾藏查看」跳转刚导入的内容。", "ok");
            return;
          }
          throw new Error((resp && resp.error) || "拾藏页面未响应");
        } catch (e) {
          // 降级：JSON 已生成，可复制手动导入
          setStatus("自动导入未成功：拾藏页面未响应。\n请检查：① chrome://extensions 拾藏详情里已开启「允许访问文件网址」② 拾藏页面已按 F5 刷新。\nJSON 已生成，可复制手动导入。", "err");
          return;
        }
      }

      setStatus("✓ 抓取成功：" + ext.content.length + " 字正文。\n未检测到打开的拾藏页面，复制 JSON 后去拾藏「＋导入」粘贴。", "ok");
    } catch (e) {
      setStatus("抓取失败：" + e.message, "err");
    } finally {
      $("btnGrab").disabled = false;
    }
  }

  async function copy() {
    const text = $("json").value;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // clipboardWrite 权限失效时的兜底
      const ta = $("json");
      ta.select();
      document.execCommand("copy");
    }
    $("btnCopy").textContent = "已复制 ✓";
    setTimeout(function () { $("btnCopy").textContent = "复制 JSON"; }, 1500);
  }

  // 自动导入成功后：跳转到拾藏页面并打开刚导入的收藏详情
  let lastImportedId = null;
  async function openShizang() {
    if (!lastImportedId) return;
    const tab = (await chrome.tabs.query({}))
      .find(function (t) { return /index\.html|127\.0\.0\.1|localhost|github\.io/.test(t.url || ""); });
    if (tab && tab.id) {
      await chrome.tabs.update(tab.id, { active: true });
      try { await chrome.tabs.sendMessage(tab.id, { type: "SHIZANG_OPEN", id: lastImportedId }); } catch (e) { /* 忽略 */ }
      window.close();
    }
  }

  // 批量补全全文：读取后台队列状态并展示
  async function refreshBatchStatus() {
    const r = await chrome.runtime.sendMessage({ type: "SHIZANG_BATCH_STATUS" });
    const box = $("batchStatus");
    const stopBtn = $("btnBatchStop");
    if (r && r.running) {
      box.hidden = false;
      if (r.done >= r.total) {
        box.className = "batch-status";
        const failText = (r.failed && r.failed.length) ? "，失败 " + r.failed.length + " 篇（可再点一次自动重试）" : "，全部成功";
        box.textContent = "✅ 补全完成：" + r.done + " / " + r.total + " 篇" + failText;
        stopBtn.hidden = true;
      } else {
        box.className = "batch-status run";
        box.textContent = "⏳ 正在补全全文：" + r.done + " / " + r.total + " 篇（工具栏图标同步显示进度）";
        stopBtn.hidden = false;
        $("btnBatch").disabled = true;
      }
    } else {
      box.hidden = true;
      stopBtn.hidden = true;
      $("btnBatch").disabled = false;
    }
  }

  async function startBatch() {
    const r = await chrome.runtime.sendMessage({ type: "SHIZANG_BATCH_START" });
    if (!r || !r.ok) {
      setStatus("无法启动：请先打开拾藏页面（点右上角「打开拾藏 ↗」），再点「批量补全全文」。", "err");
      return;
    }
    setStatus(r.total ? "已启动：补全 " + r.total + " 篇全文，后台自动进行。" : "没有需要补全的收藏（都已是最新全文）。", r.total ? "ok" : "");
    await refreshBatchStatus();
  }

  async function stopBatch() {
    await chrome.runtime.sendMessage({ type: "SHIZANG_BATCH_STOP" });
    setStatus("已停止补全。下次再点「批量补全全文」会从剩余部分继续。", "");
    await refreshBatchStatus();
  }

  // 一键打开拾藏页面（已打开则切换过去；未打开则用记忆的地址新开）
  async function openShizangPage() {
    const tabs = await chrome.tabs.query({});
    const open = tabs.find(function (t) { return /index\.html|127\.0\.0\.1|localhost|github\.io/.test(t.url || ""); });
    if (open && open.id) {
      await chrome.tabs.update(open.id, { active: true });
      window.close();
      return;
    }
    const st = await chrome.storage.local.get("shizangUrl");
    if (st.shizangUrl) {
      await chrome.tabs.create({ url: st.shizangUrl });
      window.close();
      return;
    }
    setStatus("还没记录过拾藏地址。\n请先在浏览器里打开一次拾藏 index.html，之后这里就能一键打开了。", "err");
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("btnGrab").addEventListener("click", grab);
    $("btnCopy").addEventListener("click", copy);
    $("btnOpen").addEventListener("click", openShizang);
    $("btnBatch").addEventListener("click", startBatch);
    $("btnBatchStop").addEventListener("click", stopBatch);
    $("btnOpenShizang").addEventListener("click", openShizangPage);
    chrome.storage.onChanged.addListener(function (changes, area) {
      if (area === "local" && changes["shizang.batch"]) refreshBatchStatus();
    });
    init();
    refreshBatchStatus();
  });
})();
