/* 拾藏 · 知乎正文提取
   被 popup 通过 chrome.scripting.executeScript 注入到当前知乎页面执行。
   返回 { title, url, author, type, content }，content 为页面完整正文。 */

(function () {
  "use strict";

  function clean(s) {
    return (s || "").replace(/\s+/g, " ").trim();
  }

  function extract() {
    // 按 DOM 结构识别（不依赖域名，更健壮）：专栏文章有 Post 容器，回答有 RichContent
    const isArticle = !!(document.querySelector(".Post-RichTextContainer") || document.querySelector("h1.Post-Title"));
    let title = clean(document.title.replace(/\s*[-_|]\s*知乎.*$/, ""));
    let author = "";
    let content = "";
    let type = isArticle ? "article" : "answer";

    if (isArticle) {
      // 知乎专栏文章
      const authorEl = document.querySelector(".AuthorInfo-name") ||
        document.querySelector(".Post-Author a") ||
        document.querySelector("meta[name='author']");
      if (authorEl) author = clean(authorEl.getAttribute("content") || authorEl.textContent);
      const body = document.querySelector(".Post-RichTextContainer .RichText") ||
        document.querySelector(".Post-RichTextContainer") ||
        document.querySelector(".RichText");
      content = body ? body.innerText : "";
      if (!title) title = clean(document.querySelector("h1.Post-Title, .Post-Title")?.textContent || "");
    } else {
      // 知乎问题页 / 回答页：抓取页面上第一个回答的正文（通常是顶部回答）
      const authorEl = document.querySelector(".List-item .AuthorInfo-name, .List-item .UserLink-link");
      if (authorEl) author = clean(authorEl.textContent);
      const body = document.querySelector(".List-item .RichContent-inner .RichText") ||
        document.querySelector(".RichContent-inner .RichText") ||
        document.querySelector(".RichText");
      content = body ? body.innerText : "";
      if (!title) {
        const q = document.querySelector("h1.QuestionHeader-title, .QuestionHeader-title");
        if (q) title = clean(q.textContent);
      }
    }

    // 兜底：title 里去掉站名
    title = title.replace(/\s*[-_|]\s*知乎\s*$/, "").trim();

    return {
      title: title || "未识别标题",
      url: location.href,
      author: author || "",
      type: type,
      content: content || "未能提取到正文，请确认页面已加载完成。"
    };
  }

  return extract();
})();
