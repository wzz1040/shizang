/* ============================================================
   拾藏 · SM-2 间隔重复算法（v1）
   ------------------------------------------------------------
   基于经典 SM-2 的简化三档版本，纯 JS、零依赖：
     grade 0 = 忘了（重置进度，明天复习，ease 下降）
     grade 1 = 模糊（间隔不增长，ease 微降）
     grade 2 = 记得（正常推进间隔，ease 上升）

   每个收藏条目有一个 review 状态：
     { reps, ease, interval, due }
     reps    已成功复习次数（「忘了」会归零）
     ease    易度因子，初始 2.5，范围 [1.3, 3.0]
     interval 当前间隔（天）
     due     下次复习时间戳(ms)，0 表示未排期
   ============================================================ */

(function () {
  "use strict";

  const DAY = 86400000;
  const MIN_EASE = 1.3;
  const MAX_EASE = 3.0;

  /**
   * 根据自评等级更新卡片的复习状态（原地修改并返回）
   * @param {object} card  收藏条目（含 review 字段）
   * @param {number} grade 0 | 1 | 2
   * @returns {object} card.review
   */
  function review(card, grade) {
    const r = card.review = card.review || { reps: 0, ease: 2.5, interval: 0, due: 0 };

    if (grade === 0) {
      // 忘了：进度归零，明天复习，易度下降
      r.reps = 0;
      r.interval = 1;
      r.ease = Math.max(MIN_EASE, r.ease - 0.35);
    } else if (grade === 1) {
      // 模糊：间隔压回 1 天，易度微降
      r.reps += 1;
      r.interval = 1;
      r.ease = Math.max(MIN_EASE, r.ease - 0.1);
    } else {
      // 记得：标准 SM-2 推进
      r.reps += 1;
      if (r.reps === 1) r.interval = 1;
      else if (r.reps === 2) r.interval = 6;
      else r.interval = Math.round(r.interval * r.ease);
      r.ease = Math.min(MAX_EASE, r.ease + 0.15);
    }

    r.due = Date.now() + r.interval * DAY;
    return r;
  }

  /**
   * 该卡片现在是否进入待复习队列
   * @param {object} card 收藏条目
   * @param {number} now  时间戳(ms)，默认当前时间
   */
  function isDue(card, now) {
    now = now || Date.now();
    const r = card.review;
    return card.status !== "pending" && card.cards && card.cards.length > 0 && r && r.due > 0 && r.due <= now;
  }

  /**
   * 把下次复习时间格式化为可读文本
   * @param {number} due 时间戳(ms)
   */
  function formatDue(due) {
    if (!due) return "未排期";
    const diff = due - Date.now();
    const days = Math.round(diff / DAY);
    if (diff <= 0) return "今天";
    if (days <= 1) return "明天";
    const d = new Date(due);
    return (d.getMonth() + 1) + "月" + d.getDate() + "日";
  }

  window.SM2 = { review: review, isDue: isDue, formatDue: formatDue };
})();
