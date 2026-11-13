/**
 * 固定支出状态栏（左侧常驻，可折叠）
 * 纯前端注入脚本，不改动编译产物：读 /api/recurring 渲染本月固定支出，支持改本月金额、停用、确认。
 * 依赖：sessionStorage 的 jl_token / jl_set_id（与原前端一致）
 */
(() => {
  if (window.__zdFixedCostPanel) return;
  window.__zdFixedCostPanel = true;

  const API = location.origin;
  const token = () => sessionStorage.getItem('jl_token') || '';
  const setId = () => sessionStorage.getItem('jl_set_id') || '85';
  const currentPeriod = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

  const money = (v) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const css = `
  .zd-fc{position:fixed;left:12px;bottom:14px;z-index:9998;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;color:#1f2430}
  .zd-fc *{box-sizing:border-box}
  .zd-fc-pill{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e3e7ef;border-radius:12px;padding:8px 12px;box-shadow:0 6px 20px rgba(20,30,60,.12);cursor:pointer;white-space:nowrap}
  .zd-fc-pill b{color:#1f6feb;font-size:15px}
  .zd-fc-dot{width:8px;height:8px;border-radius:50%;background:#c9ced9}
  .zd-fc-dot.warn{background:#f2994a}
  .zd-fc-dot.ok{background:#27ae60}
  .zd-fc-card{width:320px;max-height:66vh;background:#fff;border:1px solid #e3e7ef;border-radius:14px;box-shadow:0 12px 36px rgba(20,30,60,.16);display:flex;flex-direction:column;overflow:hidden}
  .zd-fc-hd{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid #eef1f6}
  .zd-fc-hd h4{margin:0;font-size:14px;font-weight:600}
  .zd-fc-hd small{color:#8a90a2;font-weight:400;margin-left:6px}
  .zd-fc-x{cursor:pointer;color:#98a0b0;font-size:16px;line-height:1;padding:2px 4px}
  .zd-fc-body{overflow:auto;padding:6px 0}
  .zd-fc-total{padding:10px 14px;background:#f7f9fc;display:flex;justify-content:space-between;align-items:baseline}
  .zd-fc-total b{font-size:18px;color:#1f2430}
  .zd-fc-total span{color:#8a90a2;font-size:12px}
  .zd-fc-warn{margin:8px 12px 0;padding:8px 10px;background:#fff7ea;border:1px solid #ffe1b3;border-radius:9px;color:#a86a12;font-size:12px;display:flex;justify-content:space-between;gap:8px;align-items:center}
  .zd-fc-warn button{border:0;background:#f2994a;color:#fff;border-radius:7px;padding:3px 8px;font-size:12px;cursor:pointer}
  .zd-fc-group{padding:8px 14px 2px;color:#8a90a2;font-size:11px;letter-spacing:.5px}
  .zd-fc-row{display:flex;align-items:center;gap:8px;padding:7px 14px}
  .zd-fc-row:hover{background:#f7f9fc}
  .zd-fc-name{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .zd-fc-name em{font-style:normal;color:#8a90a2;font-size:11px;margin-left:4px}
  .zd-fc-amt{font-variant-numeric:tabular-nums;font-weight:600}
  .zd-fc-badge{font-size:10px;padding:1px 6px;border-radius:999px;border:1px solid transparent;white-space:nowrap}
  .zd-fc-badge.draft{background:#eef4ff;color:#2f6fe4;border-color:#d6e4ff}
  .zd-fc-badge.reviewed{background:#fff7e8;color:#a86a12;border-color:#ffe4b8}
  .zd-fc-badge.posted{background:#eaf7ee;color:#1e8e4e;border-color:#cfead9}
  .zd-fc-badge.pending{background:#f4f5f8;color:#7c8394;border-color:#e6e9f0}
  .zd-fc-badge.left{background:#fdeeee;color:#c0392b;border-color:#f6d3d0}
  .zd-fc-badge.settle{background:#eef7f6;color:#0f7c74;border-color:#cfe9e6}
  .zd-fc-foot{padding:8px 12px 12px;border-top:1px solid #eef1f6;display:flex;gap:8px}
  .zd-fc-foot button{flex:1;border:1px solid #e3e7ef;background:#fff;border-radius:8px;padding:6px 0;font-size:12px;cursor:pointer;color:#3a4152}
  .zd-fc-foot button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
  .zd-fc-empty{padding:18px 14px;color:#8a90a2;font-size:12px;line-height:1.7}
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const root = document.createElement('div');
  root.className = 'zd-fc';
  document.body.appendChild(root);

  let state = { open: false, loading: false, plan: null, notice: null, error: '' };

  async function api(path, opts = {}) {
    const r = await fetch(API + path, {
      ...opts,
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token()}`,
        'x-set-id': setId(),
        ...(opts.headers || {}),
      },
    });
    if (r.status === 401) throw new Error('登录已过期，请重新登录');
    return r.json();
  }

  async function load() {
    if (!token()) { state.error = '未登录'; render(); return; }
    state.loading = true; render();
    try {
      const period = currentPeriod();
      const [p, n] = await Promise.all([
        api(`/api/recurring?period=${period}`),
        api(`/api/recurring/reminder?auto=0&period=${period}`).catch(() => null),
      ]);
      state.plan = p.data;
      state.notice = n && n.code === 0 ? n.data : null;
      state.error = '';
    } catch (e) {
      state.error = e.message || '加载失败';
    } finally {
      state.loading = false;
      render();
    }
  }

  const statusBadge = (t) => {
    if (t.voucher_status === 'posted') return '<span class="zd-fc-badge posted">已记账</span>';
    if (t.voucher_status === 'reviewed') return '<span class="zd-fc-badge reviewed">已审核</span>';
    if (t.generated) return '<span class="zd-fc-badge draft">草稿</span>';
    return '<span class="zd-fc-badge pending">待生成</span>';
  };

  function groupOf(t) {
    if (t.person) return '人员工资';
    if (t.category) return t.category;
    return '其他固定支出';
  }

  function renderBody() {
    const p = state.plan;
    if (state.error) return `<div class="zd-fc-empty">${state.error}</div>`;
    if (!p) return '<div class="zd-fc-empty">加载中…</div>';
    if (!p.count) {
      return `<div class="zd-fc-empty">本月还没有设置固定支出。<br>对智能体说「每月工资 8000，5 号发」「每月房租 6000」即可自动建立。</div>`;
    }
    const groups = new Map();
    for (const t of p.templates) {
      const g = groupOf(t);
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(t);
    }
    const rows = [...groups.entries()].map(([g, list]) => {
      const sum = list.reduce((s, t) => s + t.amount, 0);
      const items = list.map((t) => {
        const left = t.resigned_from ? `<span class="zd-fc-badge left">已离职${t.resigned_from ? ` ${t.resigned_from}` : ''}</span>` : '';
        const settled = t.tags && t.tags['钱货两讫'] ? '<span class="zd-fc-badge settle">钱货两讫</span>' : '';
        const adj = t.overridden ? '<em>本月已调</em>' : '';
        return `<div class="zd-fc-row" title="${t.name}">
          <span class="zd-fc-name">${t.person || t.name}${adj}</span>
          ${left}${settled}${statusBadge(t)}
          <span class="zd-fc-amt">${money(t.amount)}</span>
        </div>`;
      }).join('');
      return `<div class="zd-fc-group">${g} · ${list.length} 项 · ${money(sum)}</div>${items}`;
    }).join('');

    const warn = state.notice && state.notice.shouldNotify
      ? `<div class="zd-fc-warn"><span>本月固定支出待确认</span><button data-act="ack">确认无误</button></div>`
      : '';
    return `${warn}${rows}`;
  }

  function render() {
    const p = state.plan;
    const total = p ? p.total : 0;
    const pending = p ? p.pending : 0;
    const dotClass = state.error ? '' : pending > 0 ? 'warn' : 'ok';
    const pill = `<div class="zd-fc-pill" data-act="toggle">
      <span class="zd-fc-dot ${dotClass}"></span>
      <span>固定支出</span>
      <b>${money(total)}</b>
      <span style="color:#8a90a2">${p ? `${p.count} 项` : ''}</span>
    </div>`;

    if (!state.open) { root.innerHTML = pill; bind(); return; }

    root.innerHTML = `<div class="zd-fc-card">
      <div class="zd-fc-hd"><h4>固定支出<small>${currentPeriod()}</small></h4><span class="zd-fc-x" data-act="close">×</span></div>
      <div class="zd-fc-total"><b>¥ ${money(total)}</b><span>已生成 ${p ? p.generated : 0} / 共 ${p ? p.count : 0} 项</span></div>
      <div class="zd-fc-body">${renderBody()}</div>
      <div class="zd-fc-foot"><button data-act="refresh">刷新</button><button class="primary" data-act="ask">让智能体改</button></div>
    </div>`;
    bind();
  }

  async function ackNotice() {
    try {
      await api('/api/recurring/reminder/ack', { method: 'POST', body: JSON.stringify({ period: currentPeriod() }) });
      await load();
    } catch (e) { alert(e.message); }
  }

  function bind() {
    root.querySelectorAll('[data-act]').forEach((el) => {
      el.addEventListener('click', (ev) => {
        ev.stopPropagation();
        const act = el.getAttribute('data-act');
        if (act === 'toggle') { state.open = true; if (!state.plan) load(); else render(); }
        else if (act === 'close') { state.open = false; render(); }
        else if (act === 'refresh') load();
        else if (act === 'ack') ackNotice();
        else if (act === 'ask') {
          state.open = false; render();
          const box = document.querySelector('textarea');
          if (box) {
            box.focus();
            box.value = '本月固定支出需要调整：';
            box.dispatchEvent(new Event('input', { bubbles: true }));
          }
        }
      });
    });
  }

  render();
  // 登录后再拉一次；切换账套/月份时也刷新
  let lastSet = setId();
  let lastPeriod = currentPeriod();
  setInterval(() => {
    if (!token()) return;
    if (setId() !== lastSet || currentPeriod() !== lastPeriod) {
      lastSet = setId(); lastPeriod = currentPeriod();
      if (state.open || state.plan) load();
    }
  }, 15000);

  const origFetch = window.fetch;
  if (!origFetch.__zdFcWrapped) {
    const wrapped = function (...args) {
      const url = String(args[0] && args[0].url ? args[0].url : args[0] || '');
      const p = origFetch.apply(this, args);
      if (/\/api\/(vouchers|recurring|auth\/login)/.test(url)) {
        p.then(() => { if (state.plan || state.open) setTimeout(load, 400); }).catch(() => {});
      }
      return p;
    };
    wrapped.__zdFcWrapped = true;
    window.fetch = wrapped;
  }

  if (token()) load();
  window.addEventListener('storage', (e) => { if (e.key === 'jl_set_id') load(); });
})();
