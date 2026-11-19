/**
 * 振颜丽舍 · 实时同步（浏览器 / 桌面端通用）
 *
 * 解决三件事，全部自动，不需要再点"刷新"：
 *   1. 切 Tab 就刷新：点「财务」「智能体」直接整页加载目标页，数据必新；
 *   2. 停留即同步：每 6 秒比对一次对话活跃度，有变化自动刷新（本地助理/企微新消息都能进来）；
 *   3. 不打断手头的事：正在输入、弹窗打开、回答还在生成时先不刷新，
 *      等安全了自动补上；刷新前保存滚动位置与草稿，刷新后原位恢复。
 *
 * 设计取舍：
 *   - 上游是编译后的 SPA，没有对外暴露的"重新取数"方法，整页重载是唯一可靠的全量刷新；
 *   - 重载代价用"状态恢复"抵消：滚动位置、输入框草稿、是否停在底部都还原；
 *   - 只有活跃度真的变化才刷新，外加一个 2 分钟的兜底，避免无谓闪烁。
 *
 * 调试：控制台 window.__zdLive.status() 看状态；window.__zdLive.refresh() 手动触发。
 */
(() => {
  if (window.__zdLive) return;

  const CFG = {
    pollMs: 6000,          // 活跃度轮询间隔
    minGapMs: 8000,        // 两次自动刷新之间的最小间隔
    idleRefreshMs: 120000, // 兜底刷新：长时间停留也同步一次
    idleSafeMs: 20000,     // 连续 20 秒没有鼠标/键盘动作才算"闲"
    stateTtl: 60000,       // 刷新前保存的状态，超过 1 分钟不再恢复
  };

  const SK_STATE = 'zd:live-state';
  const now = () => Date.now();

  let sig = '';                // 活跃度签名 total:last_id
  let lastRefreshAt = 0;       // 上次刷新时间
  let lastActionAt = now();    // 上次用户操作时间
  let deferTip = null;         // "有新数据，稍后自动同步"提示

  /* ---------------- 小工具 ---------------- */

  const visible = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };

  function toast(text, ms = 1600) {
    let el = document.getElementById('zd-live-toast');
    if (!el) {
      el = document.createElement('div');
      el.id = 'zd-live-toast';
      el.style.cssText = [
        'position:fixed', 'right:20px', 'bottom:20px', 'z-index:2147483647',
        'background:#1F5E4C', 'color:#fff', 'font-size:12.5px', 'line-height:1',
        'padding:10px 14px', 'border-radius:999px', 'pointer-events:none',
        'box-shadow:0 8px 24px rgba(20,40,34,.28)', 'opacity:0',
        'transition:opacity .22s ease, transform .22s ease', 'transform:translateY(6px)',
        'font-family:-apple-system,"Microsoft YaHei",sans-serif', 'letter-spacing:.2px',
      ].join(';');
      document.body.appendChild(el);
    }
    el.textContent = text;
    requestAnimationFrame(() => {
      el.style.opacity = '1';
      el.style.transform = 'translateY(0)';
    });
    clearTimeout(el.__t);
    if (ms > 0) {
      el.__t = setTimeout(() => {
        el.style.opacity = '0';
        el.style.transform = 'translateY(6px)';
      }, ms);
    }
    return el;
  }

  /* ---------------- 状态保存 / 恢复 ---------------- */

  // 用「标签名 + class + 同类序号」做容器身份，重载前后结构一致时能对上
  function walkKeys(fn) {
    const counters = new Map();
    const all = document.body ? document.body.querySelectorAll('*') : [];
    for (const el of all) {
      const key = `${el.tagName}|${String(el.className || '').slice(0, 60)}`;
      const n = (counters.get(key) || 0) + 1;
      counters.set(key, n);
      fn(el, `${key}#${n}`);
    }
  }

  function saveState(why) {
    try {
      const scrolls = [];
      walkKeys((el, key) => {
        if (el.scrollTop > 4 && el.scrollHeight > el.clientHeight + 60) {
          scrolls.push({
            key,
            top: Math.round(el.scrollTop),
            atBottom: el.scrollHeight - el.scrollTop - el.clientHeight < 48,
          });
        }
      });
      const drafts = [];
      document.querySelectorAll('input,textarea').forEach((el, i) => {
        const v = String(el.value || '');
        if (v.trim() && visible(el)) drafts.push({ i, v });
      });
      sessionStorage.setItem(SK_STATE, JSON.stringify({
        at: now(), path: location.pathname, why, y: Math.round(window.scrollY), drafts, scrolls,
      }));
    } catch { /* 存不下就算了，刷新本身不受影响 */ }
  }

  function restoreState() {
    let st = null;
    try { st = JSON.parse(sessionStorage.getItem(SK_STATE) || 'null'); } catch { /* ignore */ }
    sessionStorage.removeItem(SK_STATE);
    if (!st || now() - st.at > CFG.stateTtl) return;
    if (st.path && st.path !== location.pathname) return;

    const apply = () => {
      // 草稿：按文档顺序还原，并派发 input 让框架同步内部状态
      for (const d of st.drafts || []) {
        const el = document.querySelectorAll('input,textarea')[d.i];
        if (!el || el.value) continue;
        el.value = d.v;
        el.dispatchEvent(new Event('input', { bubbles: true }));
      }
      // 滚动：屏幕 + 各滚动容器；原本停在底部的，恢复后继续贴底（看最新消息）
      window.scrollTo(0, st.y || 0);
      const want = new Map((st.scrolls || []).map((s) => [s.key, s]));
      walkKeys((el, key) => {
        const s = want.get(key);
        if (!s) return;
        el.scrollTop = s.atBottom ? el.scrollHeight : s.top;
      });
    };

    // SPA 渲染是异步的，多打几次点，后面几次覆盖前面
    [180, 600, 1200, 2200, 3200].forEach((ms) => setTimeout(() => { try { apply(); } catch { /* ignore */ } }, ms));

    if (st.why !== 'boot') {
      const label = st.why === 'tab' ? '已刷新到最新' : '已同步最新数据';
      setTimeout(() => toast(label), 700);
    }
  }

  /* ---------------- 什么时候不能刷新 ---------------- */

  function isEditing() {
    // 只看"正在输入"的那一个：输入框有内容且光标在里头，刷新会把草稿冲掉
    const a = document.activeElement;
    if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) {
      const v = a.isContentEditable ? a.textContent : a.value;
      if (String(v || '').trim()) return true;
    }
    // 弹窗/抽屉/销售看板/内嵌面板打开时不刷新，否则正在填的表或正在看的页面会被冲掉
    const blockers = '.el-dialog,.el-overlay,.zd-sb-modal,.zd-sb-mask,.zd-sb.show,.zd-inline-frame,.zd-inline-panel';
    for (const el of document.querySelectorAll(blockers)) {
      if (visible(el)) return true;
    }
    return false;
  }

  // 回答生成中：出现"停止生成/思考中/正在生成"就等等，别打断流式输出
  function isBusy() {
    for (const b of document.querySelectorAll('button,[role="button"],.el-button')) {
      if (!visible(b)) continue;
      const t = String(b.textContent || '').trim();
      if (/^(停止|停止生成|停止回答|取消生成)$/.test(t)) return true;
    }
    const body = document.body;
    if (!body) return false;
    const txt = String(body.innerText || '');
    return /思考中|正在生成|正在执行：/.test(txt);
  }

  const canRefresh = () => !isEditing() && !isBusy();

  /* ---------------- 刷新 ---------------- */

  function refresh(why, force = false) {
    const t = now();
    if (!force && t - lastRefreshAt < CFG.minGapMs) return false;
    if (!force && !canRefresh()) {
      if (!deferTip) {
        deferTip = toast('有新数据，稍后自动同步', 0);
      }
      return false;
    }
    lastRefreshAt = t;
    clearTimeout(deferTip?.__t);
    saveState(why);
    location.reload();
    return true;
  }

  /* ---------------- Tab 切换即刷新 ---------------- */

  document.addEventListener('click', (e) => {
    const tab = e.target.closest ? e.target.closest('.ws-tabs .ws-tab') : null;
    if (!tab) return;
    if (tab.hasAttribute('data-zd-sales')) return;   // 销售看板自己处理（层内取数）

    const text = String(tab.textContent || '');
    let route = '';
    if (/智能体/.test(text)) route = '/agent';
    else if (/财务/.test(text)) route = '/dashboard';
    if (!route) return;

    e.preventDefault();
    e.stopPropagation();

    if (location.pathname === route) {
      refresh('tab', true);          // 已在目标页：原地刷新一次
      return;
    }
    // 跨 Tab：保存位置后整页跳到目标路由，一次加载 = 数据必定最新
    saveState('tab');
    location.assign(route);
  }, true);

  // 用户一动，就说明不是"空闲"，兜底刷新往后推
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => {
    window.addEventListener(ev, () => { lastActionAt = now(); }, { passive: true });
  });

  /* ---------------- 轮询同步 ---------------- */

  // 页面自己的请求走 SPA 的封装；这里直接 fetch，必须手动带上登录态，
  // 否则浏览器里会 401（桌面端有请求头兜底，但不能只靠它）。
  function activityUrl() {
    return '/api/agent/activity';
  }

  function authHeaders() {
    const read = (k) => localStorage.getItem(k) || sessionStorage.getItem(k) || '';
    const h = {};
    const token = read('jl_token');
    if (token) h.Authorization = `Bearer ${token}`;
    const sid = read('jl_set_id');
    if (sid) h['X-Set-Id'] = sid;
    return h;
  }

  async function poll() {
    if (document.hidden) return;
    try {
      const r = await fetch(activityUrl(), { cache: 'no-store', headers: authHeaders() });
      if (!r.ok) return;
      const body = await r.json();
      const d = (body && body.data) || {};
      const next = `${Number(d.total || 0)}:${Number(d.last_id || 0)}`;
      if (!sig) { sig = next; return; }          // 第一次只记基线，不刷新
      if (next !== sig) {
        if (isBusy()) return;                    // 生成中先不动，下一轮再试
        if (isEditing()) { refresh('activity'); return; }
        sig = next;
        refresh('activity');
        return;
      }
    } catch { /* 后端重启期间静默 */ }

    // 兜底：一直停在页面、没有任何新消息，也每 2 分钟对齐一次
    if (now() - lastRefreshAt > CFG.idleRefreshMs
      && now() - lastActionAt > CFG.idleSafeMs
      && canRefresh()) {
      refresh('idle');
    }
  }

  /* ---------------- 兼容旧版桌面壳 ---------------- */

  // 旧版 main.js 会往页面里注入「有新的助理对话，点此刷新」的提示条，
  // 那正是要淘汰的手动刷新入口。新版壳已不再注入；这里再兜一层：
  // 只要它冒出来就立刻摘掉，用户不用等应用重启。
  const LEGACY_TIP = '有新的助理对话，点此刷新';
  function killLegacyTip() {
    if (!document.body) return;
    for (const el of document.body.children) {
      if (el.nodeType === 1 && (el.textContent || '').trim() === LEGACY_TIP) el.remove();
    }
  }

  /* ---------------- 启动 ---------------- */

  killLegacyTip();
  try {
    new MutationObserver((muts) => {
      for (const m of muts) {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && (node.textContent || '').trim() === LEGACY_TIP) node.remove();
        }
      }
    }).observe(document.body, { childList: true });
  } catch { /* 老内核忽略 */ }

  restoreState();

  setInterval(poll, CFG.pollMs);
  setTimeout(poll, 1200);
  // 窗口重新获得焦点 / 从后台切回来，立刻比对一次
  window.addEventListener('focus', () => setTimeout(poll, 300));
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) setTimeout(poll, 300);
  });
  // 用户停手 1.5 秒后，如果之前因为输入被挡下，补一次
  document.addEventListener('input', () => {
    if (!deferTip) return;
    setTimeout(() => {
      if (deferTip && canRefresh()) {
        deferTip.remove();
        deferTip = null;
        refresh('activity');
      }
    }, 1500);
  });

  window.__zdLive = {
    refresh: () => refresh('manual', true),
    status: () => ({
      sig, lastRefreshAt, lastActionAt, editing: isEditing(), busy: isBusy(),
      path: location.pathname, interval: CFG.pollMs,
    }),
  };
})();
