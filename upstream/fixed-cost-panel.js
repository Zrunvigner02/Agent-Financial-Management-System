/**
 * 固定支出状态栏（左侧常驻，可折叠）
 * 纯前端注入脚本，不改动编译产物：读 /api/recurring 渲染本月固定支出，支持改本月金额、停用、确认。
 * 依赖：sessionStorage 的 jl_token / jl_set_id（与原前端一致）
 */
(() => {
  if (window.__zdFixedCostPanel) return;
  window.__zdFixedCostPanel = true;

  const API = location.origin;
  const token = () => localStorage.getItem('jl_token') || sessionStorage.getItem('jl_token') || '';
  const setId = () => localStorage.getItem('jl_set_id') || sessionStorage.getItem('jl_set_id') || '85';
  const currentPeriod = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);

  const money = (v) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const css = `
  .zd-fc{position:fixed;left:12px;bottom:14px;z-index:9998;font:13px/1.5 "Microsoft YaHei",system-ui,sans-serif;color:#1f2430}
  .zd-fc *{box-sizing:border-box}
  .zd-fc-pill{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e3e7ef;border-radius:12px;padding:8px 12px;box-shadow:0 6px 20px rgba(20,30,60,.12);cursor:pointer;white-space:nowrap}
  .zd-fc-pill b{color:#1F5E4C;font-size:15px}
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
  .zd-fc-foot button.primary{background:#1F5E4C;border-color:#1F5E4C;color:#fff}
  .zd-fc-empty{padding:18px 14px;color:#8a90a2;font-size:12px;line-height:1.7}
  .zd-fc-row{cursor:pointer}
  .zd-fc-mask{position:fixed;inset:0;background:rgba(16,22,36,.3);z-index:9999}
  .zd-fc-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:420px;max-width:92vw;max-height:78vh;background:#fff;border-radius:14px;z-index:10000;box-shadow:0 20px 60px rgba(16,22,36,.28);display:flex;flex-direction:column;overflow:hidden}
  .zd-fc-modal-hd{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid #eef1f6;font-size:14px;font-weight:600}
  .zd-fc-modal-body{overflow:auto;padding:6px 0}
  .zd-fc-hrow{display:flex;justify-content:space-between;gap:8px;padding:8px 16px;font-size:12px;border-bottom:1px solid #f6f8fb}
  .zd-fc-hrow small{color:#8a90a2}
  .zd-fc-modal-foot{padding:10px 16px;border-top:1px solid #eef1f6;display:flex;gap:8px}
  .zd-fc-modal-foot button{flex:1;border:1px solid #e3e7ef;background:#fff;border-radius:8px;padding:7px 0;font-size:12px;cursor:pointer;color:#3a4152}
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const SIDEBAR = !!window.__ZD_SIDEBAR_MODE;

  if (SIDEBAR) {
    const s2 = document.createElement('style');
    s2.textContent = '.zd-fc.zd-fc-center{left:50% !important;bottom:auto !important;top:50% !important;transform:translate(-50%,-50%);z-index:10050}'
      + '.zd-fc.zd-fc-center .zd-fc-pill{display:none}';
    document.head.appendChild(s2);
  }

  // 内嵌主区样式（像原生页一样，不遮挡侧栏）
  const sInline = document.createElement('style');
  sInline.textContent = `
    .zd-fc.zd-fc-inline{background:var(--bg,#F3F1EB);padding:20px 26px 40px;overflow:auto;border-left:1px solid var(--line,#E2DFD7);font:13px/1.55 "Microsoft YaHei",system-ui,sans-serif}
    .zd-fc.zd-fc-inline .zd-fc-card{width:100%;max-width:1080px;max-height:none;height:auto;border:0;border-radius:0;box-shadow:none;background:transparent;display:block}
    .zd-fc.zd-fc-inline .zd-fc-pill{display:none}
    .zd-fc.zd-fc-inline .zd-fc-hd{padding:0 0 12px;border:0}
    .zd-fc.zd-fc-inline .zd-fc-hd h4{font-size:22px;font-weight:700;color:#17241F}
    .zd-fc.zd-fc-inline .zd-fc-hd small{font-size:12px;color:#6E7B76;font-weight:500;margin-left:8px}
    .zd-fc.zd-fc-inline .zd-fc-total{background:#fff;border:1px solid #E2DFD7;border-radius:14px;padding:14px 16px;margin-bottom:12px}
    .zd-fc.zd-fc-inline .zd-fc-body{padding:0;overflow:visible}
    .zd-fc.zd-fc-inline .zd-fc-row{background:#fff;border:1px solid #E2DFD7;border-radius:12px;margin-bottom:8px;padding:12px 14px}
    .zd-fc.zd-fc-inline .zd-fc-foot{border:0;padding:14px 0 0;display:flex;justify-content:flex-start;gap:8px}
    .zd-fc.zd-fc-inline .zd-fc-foot button{flex:0 0 auto;width:auto;height:32px;padding:0 16px;border-radius:9px;border:1px solid #E2DFD7;background:#fff;color:#3D4F49;cursor:pointer;font-family:inherit;font-size:12.5px}
    .zd-fc.zd-fc-inline .zd-fc-foot button:hover{border-color:#46B391;color:#1F5E4C}
    .zd-fc.zd-fc-inline .zd-fc-foot button.primary{background:linear-gradient(135deg,#1F5E4C,#46B391);color:#fff;border:0}
    .zd-fc-month{display:flex;align-items:center;gap:8px;margin:0 0 14px}
    .zd-fc-month input[type=month]{height:32px;border:1px solid #E2DFD7;border-radius:9px;padding:0 10px;font-family:inherit;font-size:13px;color:#17241F;background:#fff}
    .zd-fc-month button{height:32px;border:1px solid #E2DFD7;background:#fff;border-radius:9px;padding:0 12px;cursor:pointer;font-family:inherit;font-size:12.5px;color:#3D4F49}
    .zd-fc-month button:hover{border-color:#46B391;color:#1F5E4C}
    .zd-fc-month .lbl{font-size:12px;color:#6E7B76}
  `;
  document.head.appendChild(sInline);

  const root = document.createElement('div');
  root.className = 'zd-fc';
  document.body.appendChild(root);
  let unregisterClose = null;
  const closeSimple = () => { state.open = false; render(); };

  let state = { open: false, loading: false, plan: null, notice: null, error: '', period: currentPeriod() };

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
      const period = state.period || currentPeriod();
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
        return `<div class="zd-fc-row" data-act="item" data-id="${t.id}" title="点开看明细">
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

    const inline = !!(SIDEBAR && state.open && window.__zdInline);
    root.classList.toggle('zd-fc-inline', inline);
    root.classList.remove('zd-fc-center');
    if (!state.open) {
      if (SIDEBAR) { root.innerHTML = ''; return; }
      root.innerHTML = pill; bind(); return;
    }
    if (inline) {
      window.__zdInline.key('fixed');
      window.__zdInline.apply(root);
      unregisterClose = window.__zdInline.register(closeSimple);
    }

    root.innerHTML = `<div class="zd-fc-card">
      <div class="zd-fc-hd"><h4>固定支出<small>${state.period || currentPeriod()}</small></h4><span class="zd-fc-x" data-act="close">×</span></div>
      <div class="zd-fc-month">
        <span class="lbl">期间</span>
        <button data-act="prev">上一月</button>
        <input type="month" data-role="period" value="${state.period || currentPeriod()}">
        <button data-act="next">下一月</button>
      </div>
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

  async function openHistory(id) {
    const mask = document.createElement('div');
    mask.className = 'zd-fc-mask';
    const modal = document.createElement('div');
    modal.className = 'zd-fc-modal';
    modal.innerHTML = '<div class="zd-fc-modal-hd"><span>明细</span><span data-act="close">×</span></div><div class="zd-fc-modal-body">加载中…</div>';
    document.body.appendChild(mask);
    document.body.appendChild(modal);
    const close = () => { mask.remove(); modal.remove(); };
    mask.addEventListener('click', close);
    modal.querySelector('[data-act="close"]').addEventListener('click', close);
    try {
      const j = await api(`/api/recurring/${id}/history?months=12`);
      const d = j.data || {};
      const t = d.template || {};
      const runs = (d.runs || []).map((r) => `<div class="zd-fc-hrow">
          <span>${r.period}<small>${r.source === 'manual' ? ' · 手工调整' : ''}</small></span>
          <span>${money(r.amount)}<small>${r.voucher_no ? ` · ${r.word || '记'}-${r.voucher_no}` : ''}</small></span>
        </div>`).join('');
      const ovs = (d.overrides || []).map((o) => `<div class="zd-fc-hrow"><span>${o.period} 单独调整</span><span>${money(o.amount)}<small>${o.reason || ''}</small></span></div>`).join('');
      modal.innerHTML = `<div class="zd-fc-modal-hd"><span>${t.person || t.name || '明细'}</span><span data-act="close" style="cursor:pointer;color:#98a0b0">×</span></div>
        <div class="zd-fc-modal-body">
          <div class="zd-fc-hrow"><span>类别</span><span>${t.category || '—'}</span></div>
          <div class="zd-fc-hrow"><span>每月金额</span><span>${money(t.amount)}</span></div>
          <div class="zd-fc-hrow"><span>入账日</span><span>每月 ${t.day || 1} 号</span></div>
          <div class="zd-fc-hrow"><span>状态</span><span>${t.active ? '启用中' : '已停用'}${t.resigned_from ? ` · 已离职 ${t.resigned_from}` : ''}</span></div>
          ${ovs ? `<div class="zd-fc-group" style="padding:10px 16px 4px">单独调整</div>${ovs}` : ''}
          <div class="zd-fc-group" style="padding:10px 16px 4px">近 12 个月 · 合计 ${money(d.total || 0)}</div>
          ${runs || '<div class="zd-fc-empty">还没有生成过凭证</div>'}
        </div>
        <div class="zd-fc-modal-foot"><button data-act="ask">让智能体改</button><button data-act="close">关闭</button></div>`;
      modal.querySelectorAll('[data-act="close"]').forEach((el) => el.addEventListener('click', close));
      const ask = modal.querySelector('[data-act="ask"]');
      if (ask) ask.addEventListener('click', () => {
        close();
        const box = document.querySelector('textarea');
        if (box) { box.focus(); box.value = `把「${t.person || t.name}」本月金额改成`; box.dispatchEvent(new Event('input', { bubbles: true })); }
      });
    } catch (e) {
      modal.querySelector('.zd-fc-modal-body').textContent = e.message || '加载失败';
    }
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
        else if (act === 'prev' || act === 'next') {
          const [y, m] = String(state.period || currentPeriod()).split('-').map(Number);
          const d = new Date(y, m - 1 + (act === 'next' ? 1 : -1), 1);
          state.period = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
          load();
        }
        else if (act === 'item') { openHistory(el.getAttribute('data-id')); }
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
    root.querySelectorAll('input[data-role="period"]').forEach((inp) => {
      inp.addEventListener('change', () => {
        state.period = inp.value || currentPeriod();
        load();
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

  // 侧栏入口：外部调用即可打开固定支出面板（不再依赖左下浮标）
  window.__zdOpenFixedCost = () => { state.open = true; render(); if (token()) load(); };
})();
