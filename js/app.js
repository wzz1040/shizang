/* ============================================================
   拾藏 · 应用逻辑（v1）
   ------------------------------------------------------------
   职责：
     1. 数据加载与本地持久化（localStorage）
     2. 视图路由（欢迎 / 列表 / 详情 / 复习 / 地图 / 周报）
     3. 收藏列表渲染 + 主题过滤
     4. 详情页 + 「生成观点与卡片」模拟提炼（打字机动效）
     5. 复习流程（问题 → 答案 → 自评 → SM-2 更新）

   ⚠️ 当前提炼为「模拟」：内容来自原文自动提取。
      第二版接入真实 LLM API（见 README「接入 LLM」）。
   ============================================================ */

(function () {
  "use strict";

  /* ---------- 常量 ---------- */
  const STORAGE_KEY = "shizang.items.v3";

  /* ---------- 状态 ---------- */
  let items = loadItems();
  let currentView = null;
  let currentTopic = "全部";
  let detailItemId = null;
  let reviewQueue = [];      // 待复习的收藏条目（一个条目 = 一组卡）
  let reviewIndex = 0;       // 当前复习到的条目下标
  let reviewCardIndex = 0;   // 当前条目内的卡下标
  let sortOrder = "new";     // 列表排序：new=最新优先 / old=最早优先

  /* ---------- 工具 ---------- */
  function $(sel) { return document.querySelector(sel); }

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function typeTextAsync(el, text, speed) {
    return new Promise(function (resolve) {
      let i = 0;
      el.classList.add("typing-caret");
      const t = setInterval(function () {
        i++;
        el.textContent = text.slice(0, i);
        if (i >= text.length) {
          clearInterval(t);
          el.classList.remove("typing-caret");
          resolve();
        }
      }, speed || 28);
    });
  }

  /* ---------- 数据持久化 ---------- */
  function loadItems() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) return JSON.parse(raw);
    } catch (e) { /* 忽略损坏数据，回落模板 */ }
    return JSON.parse(JSON.stringify(DATA.items));
  }

  function saveItems() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(items)); } catch (e) { /* 隐私模式下可能失败，忽略 */ }
  }

  function resetDemo() {
    try { localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
    items = JSON.parse(JSON.stringify(DATA.items));
    detailItemId = null;
    reviewQueue = [];
    reviewIndex = 0;
    renderStats();
    renderTabs();
    renderList();
  }

  /* ---------- 视图路由 ---------- */
  function switchView(id, opts) {
    opts = opts || {};
    const views = ["viewWelcome", "viewList", "viewDetail", "viewReview", "viewMap", "viewReport"];
    views.forEach(function (v) {
      const node = document.getElementById(v);
      if (node) node.hidden = (v !== id);
    });
    const tabbar = $("#tabbar");
    tabbar.hidden = (id === "viewWelcome");

    if (id === "viewList") {
      document.querySelectorAll(".tab").forEach(function (t) {
        t.classList.toggle("active", t.dataset.view === "viewList");
      });
      renderStats(); renderTabs(); renderList();
    }
    if (id === "viewReview") {
      document.querySelectorAll(".tab").forEach(function (t) {
        t.classList.toggle("active", t.dataset.view === "viewReview");
      });
      renderReview();
    }
    if (id === "viewMap") {
      document.querySelectorAll(".tab").forEach(function (t) {
        t.classList.toggle("active", t.dataset.view === "viewMap");
      });
      renderMap();
    }
    if (id === "viewReport") {
      document.querySelectorAll(".tab").forEach(function (t) {
        t.classList.toggle("active", t.dataset.view === "viewReport");
      });
      renderReport();
    }
    currentView = id;
    window.scrollTo(0, 0);
    updateFloatActions();
  }

  /* ---------- 回到顶部条 ---------- */
  function updateFloatActions() {
    const bar = $("#toTopBar");
    if (!bar) return;
    bar.hidden = window.scrollY <= 300;
  }

  /* ---------- 统计条 ---------- */
  function renderStats() {
    const total = items.length;
    const ready = items.filter(function (i) { return i.status === "ready" || i.status === "mastered"; }).length;
    const mastered = items.filter(function (i) { return i.status === "mastered"; }).length;
    const due = items.filter(function (i) { return SM2.isDue(i); }).length;
    $("#statTotal").textContent = total;
    $("#statReady").textContent = ready;
    $("#statMastered").textContent = mastered;
    $("#statDue").textContent = due;
  }

  /* ---------- 主题过滤 ---------- */
  // 导入/新增收藏时的主题自动分类（标题优先，标题未命中再用正文）
  function classify(title, extra) {
    const src = (title || "") + " " + (extra || "");
    const rules = [
      ["保研考研", /保研|考研|读研|马理论|推免/],
      ["论文科研", /论文|科研|写论文|毕业/],
      ["考公职业", /公务员|体制内/],
      ["投资理财", /炒股|理财|投资/],
      ["资源工具", /电子书|PDF|外链|ZLibrary|zlibrary|网站|资源|网易云|音乐|古籍|二十四史|国学/],
      ["生活健康", /睡觉|养生|近视|肾|骨相|作息|睡眠/],
      ["学习方法", /学习|网课|英语|教程|效率|B站|b站/],
      ["大学成长", /大学|大学生|大一|宿舍|室友|绩点|废掉/],
      ["社会文化", /日本|规矩|纪录片|聪明人|悟出|道理|神作/]
    ];
    for (let i = 0; i < rules.length; i++) {
      if (rules[i][1].test(src)) return rules[i][0];
    }
    return "其他";
  }

  function getTopics() {
    const set = {};
    items.forEach(function (i) { set[i.topic] = true; });
    return Object.keys(set).sort();
  }

  function renderTabs() {
    const wrap = $("#topicTabs");
    wrap.innerHTML = "";
    const topics = ["全部"].concat(getTopics());
    topics.forEach(function (t) {
      const btn = document.createElement("button");
      btn.className = "topic-tab" + (t === currentTopic ? " active" : "");
      btn.textContent = t;
      btn.addEventListener("click", function () {
        currentTopic = t;
        renderTabs();
        renderList();
      });
      wrap.appendChild(btn);
    });
  }

  /* ---------- 导入（插件 JSON） ---------- */
  function showImport() {
    $("#importJson").value = "";
    $("#importError").hidden = true;
    $("#importMask").hidden = false;
  }

  function hideImport() {
    $("#importMask").hidden = true;
  }

  function importFromJson(text) {
    let parsed;
    try { parsed = JSON.parse(text); } catch (e) { throw new Error("JSON 格式不正确：" + e.message); }
    const list = Array.isArray(parsed) ? parsed : [parsed];
    if (!list.length) throw new Error("没有可导入的内容");
    const added = [];
    let seq = 0;
    list.forEach(function (raw) {
      if (!raw || typeof raw !== "object") return;
      const title = (raw.title || "").trim();
      const content = (raw.content || "").trim();
      if (!title || !content) return;
      const item = {
        id: "imp_" + Date.now() + "_" + (seq++),
        title: title,
        type: raw.type === "文章" ? "文章" : "回答",
        url: raw.url || "",
        topic: classify(title, content),
        savedAt: raw.savedAt || new Date().toISOString().slice(0, 10),
        content: content,
        contentSource: raw.contentSource === "full" ? "full" : "summary",
        status: "pending",
        corePoints: [],
        cards: [],
        review: { reps: 0, ease: 2.5, interval: 0, due: 0 }
      };
      items.push(item);
      added.push(item);
    });
    if (!added.length) throw new Error("没有识别到有效条目（需要 title 和 content 字段）");
    return added;
  }

  function confirmImport() {
    const errBox = $("#importError");
    try {
      const added = importFromJson($("#importJson").value);
      saveItems();
      hideImport();
      currentTopic = "全部"; // 新导入条目在全部视图下可见
      showImportSuccess(added);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.hidden = false;
    }
  }

  // 导入成功弹窗：列出刚导入的条目，点击可直接打开详情
  function showImportSuccess(added) {
    $("#importSuccessSub").textContent = "已导入 " + added.length + " 条收藏，点击可查看内容";
    const list = $("#importSuccessList");
    list.innerHTML = "";
    added.forEach(function (item) {
      const row = document.createElement("div");
      row.className = "import-success-item";
      row.addEventListener("click", function () {
        $("#importSuccessMask").hidden = true;
        openDetail(item.id);
      });
      const t = document.createElement("div");
      t.className = "import-success-title";
      t.textContent = item.title;
      const s = document.createElement("div");
      s.className = "import-success-meta";
      s.textContent = item.topic + " · " + (item.content ? item.content.length : 0) + " 字 · " + item.savedAt;
      row.appendChild(t);
      row.appendChild(s);
      list.appendChild(row);
    });
    $("#importSuccessMask").hidden = false;
  }

  /* ---------- 收藏列表 ---------- */
  function renderList() {
    const list = $("#collectionList");
    list.innerHTML = "";
    let shown = currentTopic === "全部" ? items.slice() : items.filter(function (i) { return i.topic === currentTopic; });
    $("#listGroupTitle").textContent = currentTopic === "全部" ? "· 全部主题" : "· " + currentTopic;

    // 排序：savedAt 为 ISO 日期字符串，字典序即时间序；
    // 同一天内按导入先后排（后导入的更新，数组位置即导入顺序）
    shown.sort(function (a, b) {
      if (a.savedAt === b.savedAt) {
        const ai = items.indexOf(a);
        const bi = items.indexOf(b);
        return sortOrder === "new" ? bi - ai : ai - bi;
      }
      const cmp = a.savedAt < b.savedAt ? -1 : 1;
      return sortOrder === "new" ? -cmp : cmp;
    });

    if (!shown.length) {
      list.innerHTML = '<div class="empty-state">这个主题下还没有收藏。</div>';
      return;
    }

    shown.forEach(function (item) {
      const card = document.createElement("div");
      card.className = "col-item " + item.status;
      card.addEventListener("click", function () { openDetail(item.id); });

      const title = document.createElement("div");
      title.className = "col-item-title";
      title.textContent = item.title;

      const meta = document.createElement("div");
      meta.className = "col-item-meta";

      const topic = document.createElement("span");
      topic.className = "chip chip-topic";
      topic.textContent = item.topic;

      const type = document.createElement("span");
      type.className = "chip";
      type.textContent = item.type;

      const status = document.createElement("span");
      status.className = "chip chip-status-" + item.status;
      status.textContent = item.status === "pending" ? "待提炼"
        : item.status === "mastered" ? "已掌握" : "已提炼";

      const due = document.createElement("span");
      due.className = "chip";
      due.textContent = item.status === "pending" ? "" : "下次复习：" + SM2.formatDue(item.review.due);

      meta.appendChild(topic);
      meta.appendChild(type);
      meta.appendChild(status);
      if (due.textContent) meta.appendChild(due);
      card.appendChild(title);
      card.appendChild(meta);
      list.appendChild(card);
    });
  }

  /* ---------- 详情页 ---------- */
  function getItem(id) {
    return items.find(function (i) { return i.id === id; });
  }

  function openDetail(id) {
    detailItemId = id;
    const item = getItem(id);
    if (!item) return;

    $("#detailTopic").textContent = item.topic;
    $("#detailType").textContent = item.type;
    const st = $("#detailStatus");
    st.className = "chip chip-status-" + item.status;
    st.textContent = item.status === "pending" ? "待提炼" : item.status === "mastered" ? "已掌握" : "已提炼";
    $("#detailTitle").textContent = item.title;
    $("#detailSaved").textContent = item.savedAt;
    $("#detailContent").textContent = item.content;

    // 原文链接与来源标注
    const link = $("#detailSourceLink");
    if (item.url) { link.href = item.url; link.hidden = false; }
    else { link.hidden = true; }
    const note = $("#detailSourceNote");
    note.textContent = item.contentSource === "full"
      ? (item.needsReextract ? "已获取完整原文（正在用全文重新提炼…）" : "已获取完整原文")
      : "开放平台仅提供收藏摘要，可点击上方链接查看完整原文";

    const extractBox = $("#detailExtract");
    const resultBox = $("#detailExtractResult");
    const btn = $("#btnExtract");

    // 提炼按钮常驻：未提炼显示「生成」，已提炼显示「重新提炼」
    extractBox.hidden = false;
    btn.disabled = false;
    if (item.status === "pending") {
      resultBox.hidden = true;
      btn.textContent = "✨ 生成观点与卡片";
    } else {
      resultBox.hidden = false;
      btn.textContent = "🔄 重新提炼";
      $("#detailCore").innerHTML = "";
      item.corePoints.forEach(function (p) {
        const li = document.createElement("li");
        li.textContent = p;
        $("#detailCore").appendChild(li);
      });
      $("#detailCardCount").textContent = item.cards.length;
      renderCardPreviews(item.cards, $("#detailCards"));
      $("#btnReviewNow").dataset.itemId = item.id;
    }

    switchView("viewDetail");
  }

  function renderCardPreviews(cards, wrap) {
    wrap.innerHTML = "";
    cards.forEach(function (c) {
      const div = document.createElement("div");
      div.className = "card-preview";
      const q = document.createElement("div");
      q.className = "cp-q";
      q.textContent = "Q: " + c.front;
      const a = document.createElement("div");
      a.className = "cp-a";
      a.textContent = "A: " + c.back;
      div.appendChild(q);
      div.appendChild(a);
      wrap.appendChild(div);
    });
  }

  /* ---------- 模拟提炼（第二版接真实 LLM） ---------- */
  // 全文评分选句：抓观点句/结论句，而不是开头铺垫句
  function scoreSentence(s) {
    let score = 0;
    const len = s.length;
    // 长度适中优先（太短是碎片，太长可能是整段）
    if (len >= 20 && len <= 120) score += 3;
    else if (len > 120) score += 1;
    else if (len >= 10) score += 1;

    // 观点 / 结论 / 行动词
    if (/认为|主张|核心|关键|最重要|本质|就是|方法|有效|建议|应该|要|必须|记住|结论|因此|所以|因为|好处|作用|能够|可以帮助|重点|第一优先级|告诉|取决于|决定/.test(s)) score += 4;
    // 行动导向（卡片二用）
    if (/应该|要|建议|方法|步骤|试试|记住|可以做|先|再|尝试|尽量/.test(s)) score += 2;

    // 铺垫 / 噪音降权
    if (/^有人|^有些|^很多人|老生常谈|经久不衰|众所周知|一个话题|讨论|争议|背景|问题来了|引子|有人主张|有人觉得|有人推荐|有人建议|有人提到|有人声称/.test(s)) score -= 4;
    if (/^https?:\/\/|如图|点击|链接|公众号|微信|加群|私信|关注我|点赞|转发|收藏我/.test(s)) score -= 6;

    return score;
  }

  function cleanSentence(s) {
    return s
      .replace(/^[0-9a-zA-Z．.、）)\]]+[.、)]?\s*/, "")
      .replace(/^[\s\-*•·]+/, "")
      .replace(/\[[0-9]+\]/g, "")
      .trim();
  }

  function mockExtract(item) {
    const raw = item.content || item.title || "";
    const sentences = raw
      .split(/[\n。！？；]/)
      .map(cleanSentence)
      .filter(function (s) { return s.length >= 10; });

    // 评分排序取前 3（保留原文顺序内的高分句，避免输出乱序）
    const ranked = sentences
      .map(function (s, idx) { return { s: s, idx: idx, score: scoreSentence(s) }; })
      .filter(function (r) { return r.score > -2; })
      .sort(function (a, b) { return b.score - a.score || a.idx - b.idx; })
      .slice(0, 3)
      .sort(function (a, b) { return a.idx - b.idx; });

    const core = ranked.map(function (r) { return r.s; });
    if (!core.length) {
      // 兜底：标题 + 原文第一段
      const first = sentences[0] || "";
      core.push(item.title + (first ? "：" + first : "的核心观点待补充。"));
    }

    // 卡片二优先选行动导向句
    let action = core.find(function (s) { return /应该|要|建议|方法|步骤|试试|记住|可以做|先|再|尝试/.test(s); });
    if (!action) action = core[1] || core[0];

    const cards = [
      {
        type: "qa",
        front: "「" + item.title + "」的核心观点是什么？",
        back: core[0],
        note: "核心观点：用自己的话复述一遍"
      },
      {
        type: "qa",
        front: "读完这篇，你会怎么用它？说出一条能立刻行动的方法。",
        back: action + " 试着联系你自己的经历举一个例子。",
        note: "行动卡片：让知识真正用起来"
      }
    ];
    return { corePoints: core, cards: cards };
  }

  // 生成提炼并写回条目（不操作详情页 DOM，可被自动重提炼复用）
  async function extractForItem(item) {
    let ext = null;
    let llmNote = "";
    if (window.ShizangLLM && window.ShizangLLM.hasConfig()) {
      const cfg = window.ShizangLLM.getConfig();
      const result = await window.ShizangLLM.summarize(item);
      if (result && result.error) {
        llmNote = "（AI 调用失败，已降级模拟：" + result.error + "）";
        ext = mockExtract(item);
      } else if (result) {
        ext = result;
        llmNote = "（AI 提炼 · " + cfg.model + "）";
      } else {
        ext = mockExtract(item);
      }
    } else {
      ext = mockExtract(item);
    }
    // 写回状态：新提炼当天进入复习队列（首轮记忆）；
    // 重新提炼时重置复习进度，避免旧进度对应旧卡片内容
    item.corePoints = ext.corePoints;
    item.cards = ext.cards;
    item.status = "ready";
    item.review = { reps: 0, ease: 2.5, interval: 0, due: Date.now() };
    item.needsReextract = false;
    saveItems();
    renderStats();
    return { ext: ext, llmNote: llmNote };
  }

  // 全文升级后自动用全文重新提炼（串行，避免并发改写同一批 DOM）
  const reextractQueue = [];
  let reextracting = false;
  async function pumpReextract() {
    if (reextracting) return;
    reextracting = true;
    while (reextractQueue.length) {
      const id = reextractQueue.shift();
      const it = getItem(id);
      if (it && it.needsReextract) {
        try { await extractForItem(it); } catch (e) { /* 单篇失败不影响后续 */ }
        if (currentView === "viewList") renderList();
        if (currentView === "viewDetail" && detailItemId === id) openDetail(id);
      }
    }
    reextracting = false;
  }

  async function runExtract() {
    const item = getItem(detailItemId);
    if (!item) return;
    const btn = $("#btnExtract");
    btn.disabled = true;
    btn.textContent = (window.ShizangLLM && window.ShizangLLM.hasConfig()) ? "AI 思考中…" : "正在提炼…";
    const r = await extractForItem(item);
    await sleep(400); // 让"正在提炼"状态有感知
    if (detailItemId !== item.id) { btn.disabled = false; btn.textContent = "🔄 重新提炼"; return; }

    // 逐条打字显示核心观点
    const coreBox = $("#detailCore");
    const resultBox = $("#detailExtractResult");
    const extractBox = $("#detailExtract");
    coreBox.innerHTML = "";
    extractBox.hidden = false;
    resultBox.hidden = false;
    $("#detailCore").innerHTML = "";

    const noteEl = document.createElement("div");
    noteEl.className = "llm-note";
    noteEl.textContent = r.llmNote || "（当前为本地模拟提炼，配置 API Key 后启用真实 AI）";
    $("#detailCore").appendChild(noteEl);

    for (let i = 0; i < r.ext.corePoints.length; i++) {
      const li = document.createElement("li");
      $("#detailCore").appendChild(li);
      await typeTextAsync(li, r.ext.corePoints[i], 24);
      await sleep(150);
    }

    // 渲染卡片
    $("#detailCardCount").textContent = r.ext.cards.length;
    renderCardPreviews(r.ext.cards, $("#detailCards"));
    $("#btnReviewNow").dataset.itemId = item.id;

    // 按钮恢复为「重新提炼」
    btn.disabled = false;
    btn.textContent = "🔄 重新提炼";
  }

  /* ---------- 复习流程 ---------- */
  // 队列按「收藏条目」计：进入一个条目，把它所有卡片过一遍
  function buildReviewQueue() {
    return items
      .filter(function (i) { return SM2.isDue(i); })
      .sort(function (a, b) { return a.review.due - b.review.due; });
  }

  function renderReview() {
    const area = $("#reviewArea");
    const empty = $("#reviewEmpty");
    const progress = $("#reviewProgress");

    // 每轮开始时重建队列（已复习的条目 due 已更新到未来，自动排除）
    if (reviewIndex === 0 && reviewCardIndex === 0) {
      reviewQueue = buildReviewQueue();
    }
    // 防御：条目卡片为空时跳过
    while (reviewQueue[reviewIndex] && reviewQueue[reviewIndex].cards.length === 0) {
      reviewIndex++;
      if (reviewIndex >= reviewQueue.length) { reviewIndex = 0; reviewQueue = buildReviewQueue(); }
    }

    if (!reviewQueue.length) {
      area.hidden = true;
      empty.hidden = false;
      progress.textContent = "队列 0 个";
      return;
    }
    empty.hidden = true;
    area.hidden = false;

    const item = reviewQueue[reviewIndex];
    const card = item.cards[reviewCardIndex];
    progress.textContent = "队列 " + reviewQueue.length + " 个收藏";
    $("#reviewLabel").textContent =
      "收藏 " + (reviewIndex + 1) + "/" + reviewQueue.length +
      " · 卡 " + (reviewCardIndex + 1) + "/" + item.cards.length +
      "：「" + item.title + "」";
    $("#reviewQuestion").textContent = card.front;
    $("#reviewAnswer").textContent = card.back + (card.note ? "\n\n💡 " + card.note : "");
    $("#reviewAnswer").hidden = true;
    $("#btnShowAnswer").hidden = false;
    $("#reviewGrade").hidden = true;
  }

  function gradeCurrent(grade) {
    const item = reviewQueue[reviewIndex];
    if (!item) return;
    SM2.review(item, grade);
    saveItems();
    renderStats();

    reviewCardIndex++;
    if (reviewCardIndex >= item.cards.length) {
      // 这个收藏的所有卡过完，进入下一个
      reviewCardIndex = 0;
      reviewIndex++;
      if (reviewIndex >= reviewQueue.length) {
        // 本轮全部完成，下一轮重建
        reviewIndex = 0;
        reviewQueue = [];
      }
    }
    renderReview();
  }

  /* ---------- 知识地图 ---------- */
  // 按主题聚合：收藏量 / 已提炼 / 已掌握 / 掌握率 / 吃灰重灾区标记
  function topicStats() {
    const map = {};
    items.forEach(function (i) {
      if (!map[i.topic]) map[i.topic] = { name: i.topic, total: 0, ready: 0, mastered: 0, pending: 0 };
      const t = map[i.topic];
      t.total++;
      if (i.status === "mastered") t.mastered++;
      if (i.status === "ready" || i.status === "mastered") t.ready++;
      else t.pending++;
    });
    return Object.keys(map).map(function (k) {
      const t = map[k];
      t.extractRate = t.total ? Math.round(t.ready / t.total * 100) : 0;
      t.masterRate = t.total ? Math.round(t.mastered / t.total * 100) : 0;
      // 吃灰重灾区：收藏 >= 5 条但提炼率 < 30%
      t.dustbin = t.total >= 5 && t.extractRate < 30;
      return t;
    }).sort(function (a, b) { return b.total - a.total; });
  }

  function renderMap() {
    const stats = topicStats();
    const insight = $("#mapInsight");
    const grid = $("#mapGrid");
    grid.innerHTML = "";

    if (!stats.length) {
      insight.innerHTML = "";
      grid.innerHTML = '<div class="empty-state">还没有收藏，先去知乎收藏几篇吧。</div>';
      return;
    }

    // 一句话洞察：收藏最多的主战场 + 转化率最低的重灾区
    const max = stats[0];
    const worst = stats.filter(function (t) { return t.total >= 3; })
      .sort(function (a, b) { return a.extractRate - b.extractRate; })[0];
    let html = "你的知识地图里，<b>「" + max.name + "」</b>收藏最多（" + max.total + " 条）";
    if (worst && worst.name !== max.name && worst.extractRate < max.extractRate) {
      html += "，而 <b>「" + worst.name + "」</b>转化率最低（" + worst.extractRate + "%）";
    }
    html += "。点开主题查看明细。";
    insight.innerHTML = html;

    stats.forEach(function (t) {
      const card = document.createElement("div");
      card.className = "map-card" + (t.dustbin ? " map-dust" : "");
      card.addEventListener("click", function () {
        currentTopic = t.name;
        switchView("viewList");
      });

      const name = document.createElement("div");
      name.className = "map-card-name";
      name.textContent = t.name;

      const num = document.createElement("div");
      num.className = "map-card-num";
      num.textContent = t.total;
      const numLabel = document.createElement("span");
      numLabel.className = "map-card-unit";
      numLabel.textContent = " 条收藏";
      num.appendChild(numLabel);

      const sub = document.createElement("div");
      sub.className = "map-card-sub";
      sub.textContent = "已提炼 " + t.ready + " · 已掌握 " + t.mastered;

      const bar = document.createElement("div");
      bar.className = "map-progress";
      const fill = document.createElement("div");
      fill.className = "map-progress-fill";
      fill.style.width = Math.max(t.extractRate, 2) + "%";
      bar.appendChild(fill);

      const foot = document.createElement("div");
      foot.className = "map-card-foot";
      const rate = document.createElement("span");
      rate.className = "map-rate";
      rate.textContent = "转化 " + t.extractRate + "%";
      foot.appendChild(rate);
      if (t.dustbin) {
        const dust = document.createElement("span");
        dust.className = "map-dust-tag";
        dust.textContent = "⚠ 吃灰重灾区";
        foot.appendChild(dust);
      }

      card.appendChild(name);
      card.appendChild(num);
      card.appendChild(sub);
      card.appendChild(bar);
      card.appendChild(foot);
      grid.appendChild(card);
    });
  }

  /* ---------- 知识周报 ---------- */
  function fmtToday() {
    const d = new Date();
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  function renderReport() {
    const total = items.length;
    const ready = items.filter(function (i) { return i.status === "ready" || i.status === "mastered"; }).length;
    const mastered = items.filter(function (i) { return i.status === "mastered"; }).length;
    const due = items.filter(function (i) { return SM2.isDue(i); }).length;
    const pct = function (n) { return total ? Math.round(n / total * 100) : 0; };

    $("#reportWeek").textContent = "第 1 周 · " + fmtToday() + " · 数据从接入拾藏起累计";

    // 统计卡
    const statsWrap = $("#reportStats");
    statsWrap.innerHTML = "";
    [
      { n: total, label: "收藏总数" },
      { n: ready, label: "已提炼" },
      { n: mastered, label: "已掌握" },
      { n: due, label: "今天该复习" }
    ].forEach(function (s) {
      const card = document.createElement("div");
      card.className = "report-stat-card";
      const n = document.createElement("div");
      n.className = "report-stat-num";
      n.textContent = s.n;
      const l = document.createElement("div");
      l.className = "report-stat-label";
      l.textContent = s.label;
      card.appendChild(n);
      card.appendChild(l);
      statsWrap.appendChild(card);
    });

    // 转化漏斗：收藏 → 已提炼 → 已掌握（宽度按总数比例，真实不编造）
    const funnel = $("#reportFunnel");
    funnel.innerHTML = "";
    [
      { label: "收藏", n: total, cls: "f-bar-gray" },
      { label: "已提炼", n: ready, cls: "f-bar-blue" },
      { label: "已掌握", n: mastered, cls: "f-bar-green" }
    ].forEach(function (row, idx) {
      const line = document.createElement("div");
      line.className = "funnel-row";
      const l = document.createElement("div");
      l.className = "funnel-label";
      l.textContent = row.label;
      const bar = document.createElement("div");
      bar.className = "funnel-track";
      const fill = document.createElement("div");
      fill.className = "funnel-bar " + row.cls;
      fill.style.width = row.n ? Math.max(pct(row.n), 3) + "%" : "0%";
      bar.appendChild(fill);
      const v = document.createElement("div");
      v.className = "funnel-value";
      v.textContent = row.n + " 条 · " + pct(row.n) + "%";
      line.appendChild(l);
      line.appendChild(bar);
      line.appendChild(v);
      funnel.appendChild(line);
    });

    // 主题转化分布
    const topics = topicStats();
    const topicsWrap = $("#reportTopics");
    topicsWrap.innerHTML = "";
    topics.forEach(function (t) {
      const row = document.createElement("div");
      row.className = "topic-row";
      const name = document.createElement("div");
      name.className = "topic-row-name";
      name.textContent = t.name;
      name.title = "点击查看该主题";
      name.addEventListener("click", function () {
        currentTopic = t.name;
        switchView("viewList");
      });
      const track = document.createElement("div");
      track.className = "topic-row-track";
      const fill = document.createElement("div");
      fill.className = "topic-row-fill";
      const w = t.total ? Math.max(pct(t.total), 2) : 2;
      fill.style.width = w + "%";
      fill.style.background = t.dustbin ? "linear-gradient(90deg,#ff6b6b,#ff9f43)" : "linear-gradient(90deg,#0a84ff,#32d74b)";
      track.appendChild(fill);
      const v = document.createElement("div");
      v.className = "topic-row-num";
      v.textContent = t.ready + "/" + t.total;
      row.appendChild(name);
      row.appendChild(track);
      row.appendChild(v);
      topicsWrap.appendChild(row);
    });

    // 吃灰最久的收藏（待提炼、按收藏时间最早）
    const oldest = items.filter(function (i) { return i.status === "pending"; })
      .sort(function (a, b) { return a.savedAt < b.savedAt ? -1 : 1; })
      .slice(0, 3);
    const oldestWrap = $("#reportOldest");
    oldestWrap.innerHTML = "";
    if (!oldest.length) {
      oldestWrap.innerHTML = '<div class="report-empty">没有吃灰的收藏了 🎉</div>';
    } else {
      oldest.forEach(function (i) {
        oldestWrap.appendChild(reportLinkItem(i, "收藏于 " + i.savedAt + " · " + i.topic));
      });
    }

    // 今天该复习
    const dueList = items.filter(function (i) { return SM2.isDue(i); })
      .sort(function (a, b) { return a.review.due - b.review.due; })
      .slice(0, 5);
    const dueWrap = $("#reportDue");
    dueWrap.innerHTML = "";
    if (!dueList.length) {
      dueWrap.innerHTML = '<div class="report-empty">今天没有到期卡片，休息一下 🎉</div>';
    } else {
      dueList.forEach(function (i) {
        dueWrap.appendChild(reportLinkItem(i, i.cards.length + " 张卡 · 下次 " + SM2.formatDue(i.review.due)));
      });
      const go = document.createElement("button");
      go.className = "btn btn-primary report-go";
      go.textContent = "开始今日复习 →";
      go.addEventListener("click", function () { switchView("viewReview"); });
      dueWrap.appendChild(go);
    }
  }

  // 周报里可点击的收藏行
  function reportLinkItem(item, sub) {
    const row = document.createElement("div");
    row.className = "report-item";
    row.addEventListener("click", function () { openDetail(item.id); });
    const t = document.createElement("div");
    t.className = "report-item-title";
    t.textContent = item.title;
    const s = document.createElement("div");
    s.className = "report-item-sub";
    s.textContent = sub;
    row.appendChild(t);
    row.appendChild(s);
    return row;
  }

  /* ---------- AI 提炼配置 ---------- */
  function updateAIStatus() {
    const note = $(".welcome-note");
    if (!note) return;
    const on = window.ShizangLLM && window.ShizangLLM.hasConfig();
    const cfg = on ? window.ShizangLLM.getConfig() : null;
    const text = on ? "AI 提炼已接入：" + cfg.model : "AI 提炼未接入（可点下方按钮配置）";
    const badge = $("#aiStatusBadge");
    if (badge) {
      badge.textContent = text;
      badge.classList.toggle("ai-on", !!on);
    }
  }

  function openLLMConfig() {
    const cfg = (window.ShizangLLM && window.ShizangLLM.getConfig()) || {};
    $("#llmEndpoint").value = cfg.endpoint || "";
    $("#llmModel").value = cfg.model || "";
    $("#llmKey").value = cfg.key || "";
    $("#llmError").hidden = true;
    $("#llmMask").hidden = false;
  }

  function saveLLMConfig() {
    const endpoint = $("#llmEndpoint").value.trim();
    const model = $("#llmModel").value.trim();
    const key = $("#llmKey").value.trim();
    const err = $("#llmError");
    if (!endpoint || !model || !key) {
      err.textContent = "API 地址、模型名、Key 三项都要填";
      err.hidden = false;
      return;
    }
    if (!/\/chat\/completions$/.test(endpoint)) {
      err.textContent = "API 地址应以 /chat/completions 结尾（例如 https://api.xxx.com/v1/chat/completions）";
      err.hidden = false;
      return;
    }
    window.ShizangLLM.saveConfig({ endpoint: endpoint, model: model, key: key });
    $("#llmMask").hidden = true;
    updateAIStatus();
  }

  /* ---------- 删除收藏 ---------- */
  function confirmDelete() {
    $("#delMask").hidden = false;
  }
  function doDelete() {
    const id = detailItemId;
    items = items.filter(function (i) { return i.id !== id; });
    saveItems();
    $("#delMask").hidden = true;
    renderStats(); renderTabs(); renderList();
    switchView("viewList");
  }

  /* ---------- 事件绑定 ---------- */
  function bindEvents() {
    $("#btnStart").addEventListener("click", function () { switchView("viewList"); });

    $("#btnBackList").addEventListener("click", function () { switchView("viewList"); });

    $("#btnImport").addEventListener("click", showImport);
    $("#btnImportCancel").addEventListener("click", hideImport);
    $("#btnImportConfirm").addEventListener("click", confirmImport);
    $("#importMask").addEventListener("click", function (e) {
      if (e.target === this) hideImport();
    });
    $("#btnSuccessClose").addEventListener("click", function () {
      $("#importSuccessMask").hidden = true;
      renderStats(); renderTabs(); renderList();
    });

    // AI 配置
    $("#btnAISetup").addEventListener("click", openLLMConfig);
    $("#btnLlmCancel").addEventListener("click", function () { $("#llmMask").hidden = true; });
    $("#btnLlmSave").addEventListener("click", saveLLMConfig);
    $("#llmMask").addEventListener("click", function (e) {
      if (e.target === this) $("#llmMask").hidden = true;
    });

    // 删除收藏
    $("#btnDeleteItem").addEventListener("click", confirmDelete);
    $("#btnDelCancel").addEventListener("click", function () { $("#delMask").hidden = true; });
    $("#btnDelConfirm").addEventListener("click", doDelete);
    $("#delMask").addEventListener("click", function (e) {
      if (e.target === this) $("#delMask").hidden = true;
    });

    // 排序切换：最新优先 / 最早优先
    $("#btnSort").addEventListener("click", function () {
      sortOrder = sortOrder === "new" ? "old" : "new";
      $("#btnSort").textContent = sortOrder === "new" ? "最新优先 ⇅" : "最早优先 ⇅";
      renderList();
    });

    // 插件自动导入：content script（bridge.js）写入 localStorage 后触发
    window.addEventListener("shizang:imported", function () {
      const oldIds = {};
      items.forEach(function (i) { oldIds[i.id] = true; });
      items = loadItems();
      // 对新条目用统一规则自动分类（bridge 写入的是占位"其他"）
      let changed = false;
      items.forEach(function (i) {
        if (!oldIds[i.id] && (!i.topic || i.topic === "其他")) {
          i.topic = classify(i.title, i.content);
          changed = true;
        }
      });
      if (changed) saveItems();
      currentTopic = "全部";
      switchView("viewList");
    });

    // 插件「打开拾藏查看」：跳转到刚导入收藏的详情页
    window.addEventListener("shizang:open", function (e) {
      const id = e.detail && e.detail.id;
      let target = getItem(id);
      if (!target) { items = loadItems(); target = getItem(id); }
      if (target) openDetail(id);
    });

    // 插件自动回填全文后：刷新数据与当前视图；对升级了全文的旧提炼条目自动重提炼
    window.addEventListener("shizang:backfilled", function (e) {
      items = loadItems();
      const ids = (e.detail && e.detail.ids) || [];
      ids.forEach(function (id) {
        const it = getItem(id);
        if (it && it.needsReextract) reextractQueue.push(id);
      });
      pumpReextract();
      renderStats(); renderTabs();
      if (currentView === "viewList") renderList();
      if (currentView === "viewDetail" && detailItemId) openDetail(detailItemId);
      if (currentView === "viewMap") renderMap();
      if (currentView === "viewReport") renderReport();
    });

    $("#btnExtract").addEventListener("click", runExtract);

    // 批量用全文重新提炼：一键升级所有已提炼条目的旧卡片（含此前补全未标记的存量）
    $("#btnReextractAll").addEventListener("click", async function () {
      const targets = items.filter(function (i) { return i.contentSource === "full" && i.status !== "pending"; });
      if (!targets.length) {
        alert("没有需要重新提炼的条目（只有摘要的条目请先「批量补全全文」）。");
        return;
      }
      const btn = $("#btnReextractAll");
      btn.disabled = true;
      const orig = btn.textContent;
      let done = 0;
      for (const it of targets) {
        btn.textContent = "全文重提炼 " + (++done) + "/" + targets.length + "…";
        try { await extractForItem(it); } catch (e) { /* 单篇失败继续 */ }
      }
      btn.disabled = false;
      btn.textContent = orig;
      renderStats(); renderTabs(); renderList();
      if (currentView === "viewDetail" && detailItemId) openDetail(detailItemId);
      alert("已用全文重新提炼 " + targets.length + " 篇，复习卡片已升级。");
    });

    // 浮动导航
    window.addEventListener("scroll", updateFloatActions);
    $("#btnTop").addEventListener("click", function () {
      window.scrollTo({ top: 0, behavior: "smooth" });
    });
    $("#btnBackList").addEventListener("click", function () {
      switchView("viewList");
    });

    $("#btnReviewNow").addEventListener("click", function () {
      switchView("viewReview");
    });

    $("#btnShowAnswer").addEventListener("click", function () {
      $("#reviewAnswer").hidden = false;
      $("#btnShowAnswer").hidden = true;
      $("#reviewGrade").hidden = false;
    });

    document.querySelectorAll(".grade").forEach(function (btn) {
      btn.addEventListener("click", function () {
        gradeCurrent(parseInt(btn.dataset.grade, 10));
      });
    });

    document.querySelectorAll(".tab").forEach(function (t) {
      t.addEventListener("click", function () { switchView(t.dataset.view); });
    });

    // 欢迎页：重置演示数据
    const resetLink = document.createElement("button");
    resetLink.className = "btn btn-ghost";
    resetLink.style.marginTop = "12px";
    resetLink.style.fontSize = "13px";
    resetLink.textContent = "重置本地数据";
    resetLink.addEventListener("click", function () {
      resetDemo();
      renderReview();
    });
    $(".welcome-note").appendChild(resetLink);
  }

  /* ---------- 启动 ---------- */
  document.addEventListener("DOMContentLoaded", function () {
    bindEvents();
    $("#sourceTag").textContent = DATA.meta.source === "zhihu" ? "我的知乎收藏" : "示例数据";
    $("#welcomeCount").textContent = items.length;
    updateAIStatus();
    switchView("viewWelcome");
  });
})();
