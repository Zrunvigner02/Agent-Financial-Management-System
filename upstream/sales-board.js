/**
 * 销售看板（独立统计口径，整页切换）
 * 纯前端注入：在左侧顶部 Tab 增加「销售看板」，点击后覆盖 .app-main 整页展示。
 * 数据：GET /api/enterprise/sales；上传：POST /api/enterprise/sales/parse + /import（后端已去重）。
 */
(() => {
  if (window.__zdSalesBoard) return;
  window.__zdSalesBoard = true;

  const API = location.origin;
  const token = () => localStorage.getItem('jl_token') || sessionStorage.getItem('jl_token') || '';
  const setId = () => localStorage.getItem('jl_set_id') || sessionStorage.getItem('jl_set_id') || '85';
  const money = (v) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const wan = (v) => (Number(v || 0) / 10000).toFixed(1);
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(2) : '0.00');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  const state = { open: false, from: '', to: '', items: [], view: 'board', dim: 'custom', loading: false, err: '' };
  const today = new Date();
  const ymd = (d) => d.toLocaleDateString('sv-SE');
  const pad2 = (n) => String(n).padStart(2, '0');
  state.to = ymd(today);
  state.from = `${today.getFullYear()}-01-01`;

  const DIMS = [['day', '日报'], ['halfmonth', '半月'], ['month', '月报'], ['quarter', '季报'], ['halfyear', '半年'], ['year', '年报'], ['3year', '三年'], ['custom', '自定义']];
  function rangeOf(dim) {
    const y = today.getFullYear(), m = today.getMonth() + 1, d = today.getDate();
    const first = `${y}-${pad2(m)}-01`;
    const last = ymd(new Date(y, m, 0));
    switch (dim) {
      case 'day': return { from: ymd(today), to: ymd(today) };
      case 'halfmonth': return d <= 15 ? { from: first, to: `${y}-${pad2(m)}-15` } : { from: `${y}-${pad2(m)}-16`, to: last };
      case 'month': return { from: first, to: last };
      case 'quarter': { const q = Math.floor((m - 1) / 3); return { from: `${y}-${pad2(q * 3 + 1)}-01`, to: ymd(new Date(y, q * 3 + 3, 0)) }; }
      case 'halfyear': { const h = m <= 6 ? 0 : 1; return { from: `${y}-${pad2(h * 6 + 1)}-01`, to: ymd(new Date(y, h * 6 + 6, 0)) }; }
      case 'year': return { from: `${y}-01-01`, to: `${y}-12-31` };
      case '3year': return { from: `${y - 2}-01-01`, to: ymd(today) };
      default: return { from: state.from, to: state.to };
    }
  }

  const CSS = `
  .zd-sb-tab{flex:0 0 auto;display:flex;align-items:center;justify-content:center;gap:0;height:34px;padding:0 9px;
    border:1px solid transparent;border-radius:10px;background:transparent;color:var(--ink,#17241F);
    font-size:13px;font-weight:700;cursor:pointer;white-space:nowrap;font-family:inherit}
  .zd-sb-tab:hover{background:#fff9}
  .zd-sb-tab.zd-active{background:linear-gradient(135deg,#46b3912e,#46b39114);border-color:#46b39147;color:#1F5E4C}
  .ws-tabs.is-collapsed .zd-sb-tab{flex:none;width:42px;padding:0}
  .ws-tabs.is-collapsed .zd-sb-tab .zd-sb-tab-txt{display:none}
  /* 三个 Tab 统一字重/字号/颜色，并隐藏前置图标 */
  .ws-tabs .ws-tab{font-size:13px;font-weight:700;letter-spacing:.3px;gap:0;padding:0 2px;color:var(--ink,#17241F)}
  .ws-tabs .ws-tab svg,.ws-tabs .ws-tab .ws-icon{display:none !important}
  .ws-tabs .ws-tab.active,.ws-tabs .ws-tab.zd-active{color:#1F5E4C}
  .zd-sb-ico{display:none;width:16px;height:16px;flex:none}
  /* 折叠态：恢复图标，避免只剩空白 */
  .ws-tabs.is-collapsed .ws-tab svg,.ws-tabs.is-collapsed .ws-tab .ws-icon{display:block !important}
  .app-main{position:relative !important}
  .zd-sb{position:absolute;inset:0;z-index:60;background:var(--bg,#F3F1EB);overflow:auto;padding:18px 22px 48px;box-sizing:border-box;
    font:13px/1.55 "Microsoft YaHei",system-ui,sans-serif;color:var(--ink,#17241F);display:none}
  .zd-sb.show{display:block}
  .zd-sb *{box-sizing:border-box}
  .zd-sb-head{display:flex;align-items:flex-end;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:16px}
  .zd-sb-title{font-size:22px;font-weight:700;letter-spacing:.5px;margin:0}
  .zd-sb-title b{color:#1F5E4C}
  .zd-sb-sub{color:var(--muted,#6E7B76);font-size:12px;margin-top:3px}
  .zd-sb-actions{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
  .zd-sb-input{height:32px;border:1px solid var(--line,#E2DFD7);border-radius:8px;padding:0 8px;font-size:12px;background:#fff;color:var(--ink,#17241F)}
  .zd-sb-btn{height:32px;border:1px solid var(--line,#E2DFD7);background:#fff;border-radius:9px;padding:0 12px;font-size:12px;cursor:pointer;color:#3a4152;font-family:inherit}
  .zd-sb-btn:hover{border-color:#46b391;color:#1F5E4C}
  .zd-sb-btn.primary{background:linear-gradient(135deg,#46b391,#1F5E4C);color:#fff;border:0}
  .zd-sb-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:16px}
  .zd-sb-kpi{background:#fff;border:1px solid var(--line-2,#EFECE4);border-radius:13px;padding:13px 15px;box-shadow:0 1px 2px rgba(20,30,60,.04)}
  .zd-sb-kpi .k{font-size:12px;color:var(--muted,#6E7B76);margin-bottom:7px}
  .zd-sb-kpi .v{font-size:21px;font-weight:700;letter-spacing:.3px}
  .zd-sb-kpi .v small{font-size:12px;font-weight:500;color:var(--muted,#6E7B76);margin-left:2px}
  .zd-sb-kpi.hl{background:linear-gradient(135deg,#1F5E4C,#46b391);border:0;color:#fff}
  .zd-sb-kpi.hl .k{color:#f7dcea}
  .zd-sb-grid{display:grid;grid-template-columns:1.5fr 1fr;gap:14px;margin-bottom:14px}
  @media(max-width:900px){.zd-sb-grid{grid-template-columns:1fr}}
  .zd-sb-panel{background:#fff;border:1px solid var(--line-2,#EFECE4);border-radius:14px;padding:15px 16px 8px;box-shadow:0 1px 2px rgba(20,30,60,.04)}
  .zd-sb-panel h3{font-size:14px;margin:0 0 10px;font-weight:600}
  .zd-sb-panel h3 span{font-weight:400;color:var(--muted,#6E7B76);font-size:12px;margin-left:6px}
  .zd-sb-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .zd-sb-table th,.zd-sb-table td{padding:8px 7px;border-bottom:1px solid var(--line-2,#EFECE4);text-align:right}
  .zd-sb-table th:first-child,.zd-sb-table td:first-child{text-align:left}
  .zd-sb-table thead th{color:var(--muted,#6E7B76);font-weight:600;font-size:11.5px}
  .zd-sb-table tfoot td{font-weight:700;border-top:2px solid var(--line,#E2DFD7)}
  .zd-sb-pos{color:#B45A4B}.zd-sb-neg{color:#2F7D5E}
  .zd-sb-empty{padding:30px;text-align:center;color:var(--faint,#9AA8A0)}
  .zd-sb-mask{position:fixed;inset:0;background:#14182859;z-index:10060;backdrop-filter:blur(2px)}
  .zd-sb-modal{position:fixed;left:50%;top:50%;transform:translate(-50%,-50%);width:680px;max-width:94vw;max-height:86vh;
    background:#fff;border-radius:14px;z-index:10061;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 20px 60px rgba(16,22,36,.25)}
  .zd-sb-modal-hd{display:flex;justify-content:space-between;align-items:center;padding:14px 16px;border-bottom:1px solid var(--line-2,#EFECE4);font-weight:600}
  .zd-sb-modal-bd{padding:14px 16px;overflow:auto}
  .zd-sb-modal-ft{padding:12px 16px;border-top:1px solid var(--line-2,#EFECE4);display:flex;justify-content:flex-end;gap:8px}
  .zd-sb-x{cursor:pointer;color:var(--faint,#9AA8A0);font-size:18px;line-height:1}
  .zd-sb-note{background:#fff7ea;border:1px solid #E8D9B5;color:#8A6A2A;border-radius:8px;padding:8px 10px;font-size:12px;margin-bottom:10px}
  .zd-sb-chip{display:inline-block;padding:1px 7px;border-radius:999px;font-size:11px;line-height:18px}
  .zd-sb-chip.ok{background:#e8f6ef;color:#1e8a5a}.zd-sb-chip.part{background:#FBF4E6;color:#b5701a}.zd-sb-chip.todo{background:#eef0f5;color:#6b7280}
  .zd-sb-road{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:900px){.zd-sb-road{grid-template-columns:1fr}}
  .zd-sb-roadcard{background:#fff;border:1px solid var(--line-2,#EFECE4);border-radius:14px;padding:14px 16px}
  .zd-sb-roadcard h4{margin:0 0 10px;font-size:14px}
  .zd-sb-item{display:flex;justify-content:space-between;gap:10px;padding:7px 0;border-bottom:1px dashed var(--line-2,#EFECE4);font-size:12.5px}
  .zd-sb-item:last-child{border-bottom:0}
  .zd-sb-canvas{width:100%;display:block}
  /* 销售端专用侧栏 */
  #zd-sales-menu{display:none;padding:8px;background:transparent;flex-direction:column}
  .zd-sm-item{display:flex;align-items:center;gap:8px;height:34px;line-height:34px;margin-bottom:2px;padding:0 9px;
    border-radius:8px;color:var(--ink-2,#3D4F49);font-size:12.5px;cursor:pointer;white-space:nowrap;position:relative;
    transition:background .2s,color .2s;text-decoration:none}
  .zd-sm-item:hover{background:#17241f0d;color:var(--ink,#17241F)}
  .zd-sm-item.on{background:var(--primary-soft,rgba(31,94,76,.1));color:var(--primary,#1F5E4C);font-weight:500}
  .zd-sm-item.on:before{content:"";position:absolute;left:0;top:6px;bottom:6px;width:3px;border-radius:2px;background:var(--primary,#1F5E4C)}
  .zd-sm-item svg{width:16px;height:16px;flex:none;stroke:#6E7B76;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
  .zd-sm-item:hover svg,.zd-sm-item.on svg{stroke:#1F5E4C}
  .zd-sm-sep{height:1px;background:var(--line-2,#EFECE4);margin:6px 8px}
  /* 文件格式转换固定在左下角 */
  .zd-sm-item[data-sm="convert"]{margin-top:auto}
  #zd-sales-menu.zd-sm-collapsed{padding:8px 0}
  #zd-sales-menu.zd-sm-collapsed .zd-sm-item{padding:0;justify-content:center}
  #zd-sales-menu.zd-sm-collapsed .zd-sm-txt{display:none}
  .zd-sb-dims{display:flex;gap:6px;flex-wrap:wrap;margin:0 0 12px}
  .zd-sb-chip{border:1px solid var(--line,#E2DFD7);background:#fff;color:var(--ink-2,#3D4F49);border-radius:999px;padding:4px 11px;font-size:12px;cursor:pointer}
  .zd-sb-chip.on{background:#1F5E4C;border-color:#1F5E4C;color:#fff}
  `;

  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);

  async function api(path, opts = {}) {
    const r = await fetch(API + path, {
      ...opts,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}`, 'x-set-id': setId(), ...(opts.headers || {}) },
    });
    if (r.status === 401) throw new Error('登录已过期，请重新登录');
    return r.json();
  }

  let overlay = null;

  function ensureOverlay() {
    const main = document.querySelector('.app-main');
    if (!main) return null;
    if (!overlay || !overlay.isConnected) {
      overlay = document.createElement('div');
      overlay.className = 'zd-sb';
      overlay.addEventListener('click', onOverlayClick);
      main.appendChild(overlay);
    }
    return overlay;
  }

  function ensureTab() {
    const tabs = document.querySelector('.ws-tabs');
    if (!tabs) return;
    const others = [...tabs.querySelectorAll('.ws-tab:not([data-zd-sales])')];
    // 原两个 Tab 更名：妆点管账 → 财务；妆点智能体 → 智能体
    const rename = (el, text) => {
      if (!el) return;
      const sp = el.querySelector('span');
      if (sp && sp.textContent.trim() !== text) sp.textContent = text;
      if (el.title !== text) el.title = text;
    };
    rename(others[0], '财务');
    rename(others[1], '智能体');

    let btn = tabs.querySelector('[data-zd-sales]');
    if (!btn) {
      btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'ws-tab zd-sb-tab';
      btn.setAttribute('data-zd-sales', '1');
      btn.title = '销售看板（销售口径）';
      btn.innerHTML = '<svg class="zd-sb-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-7"/></svg><span class="zd-sb-tab-txt">销售</span>';
      btn.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); openBoard(); });
    }
    // 固定顺序：财务 → 销售 → 智能体
    const anchor = others[1] || null;
    if (btn.parentElement !== tabs || btn.nextElementSibling !== anchor) tabs.insertBefore(btn, anchor);
    syncTab();
  }

  function syncTab() {
    const tabs = document.querySelector('.ws-tabs');
    if (!tabs) return;
    const mine = tabs.querySelector('[data-zd-sales]');
    const others = [...tabs.querySelectorAll('.ws-tab')].filter((t) => t !== mine);
    if (!mine) return;
    mine.classList.toggle('zd-active', state.open);
    if (state.open) others.forEach((t) => t.classList.remove('active'));
    else restoreActive(others);
  }

  function restoreActive(others) {
    const arr = others || [...document.querySelectorAll('.ws-tabs .ws-tab')].filter((t) => !t.hasAttribute('data-zd-sales'));
    const isAgent = location.pathname.startsWith('/agent');
    arr.forEach((t, i) => t.classList.toggle('active', isAgent ? i === 1 : i === 0));
  }

  const ICO = {
    summary: '<svg viewBox="0 0 24 24"><path d="M4 19V5M4 19h16M8 16v-5M12 16V8M16 16v-7"/></svg>',
    channel: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8"/><path d="M12 4v16M4 12h16"/></svg>',
    staff: '<svg viewBox="0 0 24 24"><circle cx="9" cy="8" r="3"/><path d="M3 20c0-3 3-5 6-5s6 2 6 5"/><path d="M16 6a3 3 0 010 6"/></svg>',
    report: '<svg viewBox="0 0 24 24"><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 8h8M8 12h8M8 16h5"/></svg>',
    order: '<svg viewBox="0 0 24 24"><path d="M6 2h12l1 5H5l1-5z"/><path d="M5 7v13a2 2 0 002 2h10a2 2 0 002-2V7"/><path d="M9 11h6"/></svg>',
    cost: '<svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="13" rx="2"/><path d="M2 10h20"/><circle cx="17" cy="14.5" r="1.2"/></svg>',
    conv: '<svg viewBox="0 0 24 24"><path d="M4 8h14l-3-3M20 16H6l3 3"/></svg>',
  };

  function ensureSalesMenu() {
    const appMenu = document.querySelector('.app-menu');
    if (!appMenu) return;
    let m = document.getElementById('zd-sales-menu');
    if (!m) {
      m = document.createElement('div');
      m.id = 'zd-sales-menu';
      m.innerHTML = `
        <a class="zd-sm-item on" data-sm="summary" data-zd-open="board">${ICO.summary}<span class="zd-sm-txt">销售汇总</span></a>
        <a class="zd-sm-item" data-sm="channel" data-zd-open="report">${ICO.channel}<span class="zd-sm-txt">各渠道汇总</span></a>
        <a class="zd-sm-item" data-sm="staff" data-zd-open="report">${ICO.staff}<span class="zd-sm-txt">员工业绩</span></a>
        <div class="zd-sm-sep"></div>
        <a class="zd-sm-item" data-sm="orders" data-zd-open="orders">${ICO.order}<span class="zd-sm-txt">订单</span></a>
        <a class="zd-sm-item" data-sm="fixed" data-zd-open="fixed">${ICO.cost}<span class="zd-sm-txt">固定支出</span></a>
        <a class="zd-sm-item" data-sm="report" data-zd-open="report">${ICO.report}<span class="zd-sm-txt">报表</span></a>
        <a class="zd-sm-item" data-sm="convert" data-zd-open="convert">${ICO.conv}<span class="zd-sm-txt">文件格式转换</span></a>`;
      m.addEventListener('click', onSalesMenuClick);
      appMenu.parentElement.insertBefore(m, appMenu.nextSibling);
    }
    m.classList.toggle('zd-sm-collapsed', appMenu.classList.contains('el-menu--collapse'));
    fitHeight();
  }

  // 让菜单撑满侧栏剩余高度，使「文件格式转换」真正贴到左下角
  function fitHeight() {
    const m = document.getElementById('zd-sales-menu');
    if (!m) return;
    const r = m.getBoundingClientRect();
    if (r.height > 0) m.style.minHeight = Math.max(240, window.innerHeight - r.top - 44) + 'px';
  }
  window.addEventListener('resize', fitHeight);

  function onSalesMenuClick(e) {
    const it = e.target.closest('[data-sm]');
    if (!it) return;
    e.preventDefault();
    const k = it.getAttribute('data-sm');
    if (k === 'summary') { state.view = 'board'; openBoard(); }
    else if (k === 'channel') { if (window.__zdOpenReports) window.__zdOpenReports('sales', 'month', 'channel'); }
    else if (k === 'staff') { if (window.__zdOpenReports) window.__zdOpenReports('sales', 'month', 'staff'); }
    else if (k === 'report') { if (window.__zdOpenReports) window.__zdOpenReports('sales', 'month', 'summary'); }
    else if (k === 'orders') { if (window.__zdOpenOrders) window.__zdOpenOrders(); }
    else if (k === 'fixed') { if (window.__zdOpenFixedCost) window.__zdOpenFixedCost(); }
    else if (k === 'convert') { if (typeof window.__zdOpenConvert === 'function') window.__zdOpenConvert(); else location.href = '/convert.html'; }
    document.querySelectorAll('#zd-sales-menu .zd-sm-item').forEach((x) => x.classList.toggle('on', x === it));
  }

  function setMenuMode(mode) {
    const appMenu = document.querySelector('.app-menu');
    const sm = document.getElementById('zd-sales-menu');
    if (appMenu) appMenu.style.display = mode === 'sales' ? 'none' : '';
    if (sm) sm.style.display = mode === 'sales' ? 'flex' : 'none';
  }

  function openBoard() {
    state.open = true;
    ensureSalesMenu();
    setMenuMode('sales');
    setTimeout(fitHeight, 0);
    const el = ensureOverlay();
    if (!el) return;
    el.classList.add('show');
    syncTab();
    load();
  }

  function closeBoard() {
    state.open = false;
    if (overlay) overlay.classList.remove('show');
    setMenuMode('finance');
    syncTab();
  }

  async function load() {
    state.loading = true; state.err = '';
    render();
    try {
      if (!token()) throw new Error('未登录');
      const q = `from=${encodeURIComponent(state.from)}&to=${encodeURIComponent(state.to)}&limit=1000`;
      const j = await api(`/api/enterprise/sales?${q}`);
      if (j.code !== 0) throw new Error(j.message || '加载失败');
      state.items = (j.data && j.data.items) || [];
    } catch (e) {
      state.err = e.message || '加载失败';
      state.items = [];
    } finally {
      state.loading = false;
      render();
    }
  }

  function aggregate(items) {
    const M = {}, C = {}, D = {};
    const t = { amount: 0, ret: 0, fee: 0, net: 0, cnt: 0 };
    for (const it of items) {
      const m = String(it.date || '').slice(0, 7);
      const c = it.group_name || '未分组';
      const d = String(it.date || '');
      const add = (o) => { o.amount += Number(it.amount || 0); o.ret += Number(it.return_amount || 0); o.fee += Number(it.fee || 0); o.net += Number(it.net_profit || 0); };
      M[m] = M[m] || { amount: 0, ret: 0, fee: 0, net: 0, cnt: 0 }; add(M[m]); M[m].cnt += 1;
      C[c] = C[c] || { amount: 0, ret: 0, fee: 0, net: 0, cnt: 0 }; add(C[c]); C[c].cnt += 1;
      D[d] = D[d] || { amount: 0, ret: 0, fee: 0, net: 0, cnt: 0 }; add(D[d]); D[d].cnt += 1;
      t.amount += Number(it.amount || 0); t.ret += Number(it.return_amount || 0);
      t.fee += Number(it.fee || 0); t.net += Number(it.net_profit || 0); t.cnt += 1;
    }
    return { M, C, D, t };
  }

  function bars(M) {
    const keys = Object.keys(M).sort();
    if (!keys.length) return '<div class="zd-sb-empty">当前区间没有销售数据</div>';
    const W = 640, H = 250, pad = { l: 10, r: 10, t: 12, b: 26 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const max = Math.max(...keys.map((k) => Math.max(M[k].amount, M[k].net)), 1) * 1.1;
    const n = keys.length, gw = iw / n, bw = Math.min(16, gw * 0.3);
    let s = `<svg class="zd-sb-canvas" viewBox="0 0 ${W} ${H}">`;
    for (let i = 0; i <= 4; i += 1) { const y = pad.t + (ih * i) / 4; s += `<line x1="${pad.l}" y1="${y}" x2="${W - pad.r}" y2="${y}" stroke="var(--line-2,#EFECE4)"/>`; }
    keys.forEach((k, i) => {
      const cx = pad.l + gw * i + gw / 2;
      const h1 = (ih * M[k].amount) / max, h2 = (ih * M[k].net) / max;
      s += `<rect x="${cx - bw - 2}" y="${pad.t + ih - h1}" width="${bw}" height="${Math.max(0, h1)}" rx="3" fill="#46b391"/>`;
      s += `<rect x="${cx + 2}" y="${pad.t + ih - h2}" width="${bw}" height="${Math.max(0, h2)}" rx="3" fill="#E0A458"/>`;
      s += `<text x="${cx}" y="${H - 8}" font-size="10" fill="var(--muted,#6E7B76)" text-anchor="middle">${k.slice(5)}月</text>`;
    });
    s += '</svg>';
    return `<div style="font-size:12px;color:var(--muted,#6E7B76);margin-bottom:4px"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#46b391;margin-right:5px"></span>销售额　<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:#E0A458;margin:0 5px 0 14px"></span>净利润</div>${s}`;
  }

  function donut(C) {
    const keys = Object.keys(C).sort((a, b) => C[b].amount - C[a].amount);
    const total = keys.reduce((s, k) => s + C[k].amount, 0);
    if (!total) return '<div class="zd-sb-empty">暂无渠道数据</div>';
    const cols = ['#1F5E4C', '#46b391', '#E0A458', '#8FD0BF', '#c9a227', '#9AA8A0'];
    let a0 = -Math.PI / 2;
    let s = '<svg class="zd-sb-canvas" viewBox="0 0 200 200" style="max-width:190px;margin:0 auto">';
    keys.forEach((k, i) => {
      const ang = (C[k].amount / total) * Math.PI * 2;
      const a1 = a0 + ang;
      const x0 = 100 + 78 * Math.cos(a0), y0 = 100 + 78 * Math.sin(a0), x1 = 100 + 78 * Math.cos(a1), y1 = 100 + 78 * Math.sin(a1);
      const large = ang > Math.PI ? 1 : 0;
      s += `<path d="M100,100 L${x0},${y0} A78,78 0 ${large} 1 ${x1},${y1} Z" fill="${cols[i % cols.length]}"/>`;
      a0 = a1;
    });
    s += '<circle cx="100" cy="100" r="44" fill="#fff"/>';
    s += `<text x="100" y="96" text-anchor="middle" font-size="10" fill="var(--muted,#6E7B76)">销售总额</text>`;
    s += `<text x="100" y="116" text-anchor="middle" font-size="13" font-weight="700" fill="var(--ink,#17241F)">¥${wan(total)}万</text></svg>`;
    const legend = keys.map((k, i) => `<div style="display:flex;justify-content:space-between;font-size:12px;padding:3px 0"><span><i style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${cols[i % cols.length]};margin-right:5px"></i>${esc(k)}</span><span style="color:var(--muted,#6E7B76)">${pct(C[k].amount, total)}%</span></div>`).join('');
    return s + `<div style="margin-top:4px">${legend}</div>`;
  }

  function line(D) {
    const keys = Object.keys(D).sort().slice(-31);
    if (!keys.length) return '<div class="zd-sb-empty">暂无日数据</div>';
    const W = 640, H = 170, pad = { l: 10, r: 10, t: 12, b: 22 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const max = Math.max(...keys.map((k) => D[k].amount), 1) * 1.15;
    const step = keys.length > 1 ? iw / (keys.length - 1) : 0;
    let s = `<svg class="zd-sb-canvas" viewBox="0 0 ${W} ${H}">`;
    let dpath = '';
    keys.forEach((k, i) => {
      const x = pad.l + step * i, y = pad.t + ih - (ih * D[k].amount) / max;
      dpath += `${i ? 'L' : 'M'}${x},${y} `;
    });
    s += `<path d="${dpath}" fill="none" stroke="#1F5E4C" stroke-width="2"/>`;
    keys.forEach((k, i) => {
      if (i % Math.ceil(keys.length / 6) && i !== keys.length - 1) return;
      const x = pad.l + step * i;
      s += `<text x="${x}" y="${H - 6}" font-size="9" fill="var(--muted,#6E7B76)" text-anchor="middle">${k.slice(5)}</text>`;
    });
    s += '</svg>';
    return s;
  }

  function kpis(t) {
    const ns = t.amount - t.ret;
    return `<div class="zd-sb-kpis">
      <div class="zd-sb-kpi hl"><div class="k">销售总额</div><div class="v">¥${money(t.amount)}</div></div>
      <div class="zd-sb-kpi"><div class="k">净销售额</div><div class="v">¥${money(ns)}</div></div>
      <div class="zd-sb-kpi"><div class="k">退款金额</div><div class="v zd-sb-pos">¥${money(t.ret)}</div></div>
      <div class="zd-sb-kpi"><div class="k">平台费用</div><div class="v">¥${money(t.fee)}</div></div>
      <div class="zd-sb-kpi"><div class="k">净利润</div><div class="v zd-sb-neg">¥${money(t.net)}</div></div>
      <div class="zd-sb-kpi"><div class="k">净利率</div><div class="v">${pct(t.net, ns)}<small>%</small></div></div>
    </div>`;
  }

  function tableM(M) {
    const keys = Object.keys(M).sort();
    const rows = keys.map((k) => {
      const d = M[k], ns = d.amount - d.ret;
      return `<tr><td>${k}</td><td>${money(d.amount)}</td><td class="zd-sb-neg">${money(d.ret)}</td><td>${money(ns)}</td><td>${money(d.fee)}</td><td class="zd-sb-pos">${money(d.net)}</td><td>${pct(d.net, ns)}%</td></tr>`;
    }).join('');
    const t = keys.reduce((s, k) => { s.amount += M[k].amount; s.ret += M[k].ret; s.fee += M[k].fee; s.net += M[k].net; return s; }, { amount: 0, ret: 0, fee: 0, net: 0 });
    const ns = t.amount - t.ret;
    return `<table class="zd-sb-table"><thead><tr><th>月份</th><th>销售额</th><th>退款</th><th>净销售</th><th>平台费用</th><th>净利润</th><th>净利率</th></tr></thead>
      <tbody>${rows || '<tr><td colspan="7" class="zd-sb-empty">无数据</td></tr>'}</tbody>
      <tfoot><tr><td>合计</td><td>${money(t.amount)}</td><td class="zd-sb-neg">${money(t.ret)}</td><td>${money(ns)}</td><td>${money(t.fee)}</td><td class="zd-sb-pos">${money(t.net)}</td><td>${pct(t.net, ns)}%</td></tr></tfoot></table>`;
  }

  function tableC(C) {
    const keys = Object.keys(C).sort((a, b) => C[b].amount - C[a].amount);
    const total = keys.reduce((s, k) => s + C[k].amount, 0);
    const rows = keys.map((k) => {
      const d = C[k], ns = d.amount - d.ret;
      return `<tr><td>${esc(k)}</td><td>${money(d.amount)}</td><td class="zd-sb-neg">${money(d.ret)}</td><td>${money(d.fee)}</td><td class="zd-sb-pos">${money(d.net)}</td><td>${pct(d.amount, total)}%</td></tr>`;
    }).join('');
    return `<table class="zd-sb-table"><thead><tr><th>渠道</th><th>销售额</th><th>退款</th><th>平台费用</th><th>净利润</th><th>占比</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="zd-sb-empty">无数据</td></tr>'}</tbody></table>`;
  }

  const ROADMAP = [
    { group: '财务 / 银企智联', items: [
      ['采购→生产→发货→剩余库存→自库入库→销售发货→退货→库存数量及金额', 'todo'],
      ['销售日统计损益表（品牌/渠道/单品贡献率 + 毛利率，含赠品）', 'part'],
      ['现金流量表（日/月收支、各渠道月收入、月支出、营业内外收入、汇兑损益）', 'part'],
      ['月报报表（当年月对比表、年的月对比表）', 'ok'],
      ['核账（采购数量金额 → 回款数量金额 → 实际库存数量金额）', 'todo'],
      ['资产负债表', 'ok'],
      ['利润表', 'ok'],
      ['借贷表', 'ok'],
      ['票据自动扫描上传', 'part'],
      ['仓物（日快递/物流费、日单量总费用、月整体费用、月退货）', 'todo'],
    ] },
    { group: '销售口径（本次新增）', items: [
      ['销售看板（KPI + 月度趋势 + 渠道结构 + 日趋势）', 'ok'],
      ['文件/图片上传更新（CSV/Excel 解析 + 去重）', 'ok'],
      ['图片 OCR 结构化入账（识别文本 → 自动成行）', 'part'],
      ['品牌 / 单品维度（贡献率、毛利率）', 'todo'],
    ] },
    { group: '内容', items: [
      ['图文视频内容制作 · 日 200 条', 'todo'],
      ['自动发出投放 · 所有渠道', 'todo'],
    ] },
  ];

  function chip(st) {
    if (st === 'ok') return '<span class="zd-sb-chip ok">已具备</span>';
    if (st === 'part') return '<span class="zd-sb-chip part">部分/待完善</span>';
    return '<span class="zd-sb-chip todo">待接入</span>';
  }

  function renderRoadmap() {
    const cards = ROADMAP.map((g) => `<div class="zd-sb-roadcard"><h4>${esc(g.group)}</h4>${g.items.map(([t, s]) => `<div class="zd-sb-item"><span>${esc(t)}</span>${chip(s)}</div>`).join('')}</div>`).join('');
    return `<div class="zd-sb-note">以下为项目功能蓝图：状态按“已具备 / 部分具备 / 待接入”标注。无数据源的项先做可视化骨架，后续接数据。</div><div class="zd-sb-road">${cards}</div>`;
  }

  function renderBoard() {
    const { M, C, D, t } = aggregate(state.items);
    if (state.err) return `<div class="zd-sb-note">${esc(state.err)}</div>`;
    if (!state.items.length) return '<div class="zd-sb-empty">当前区间没有销售数据。<br>点「上传数据」导入 CSV/Excel，或先用智能体同步销售数据。</div>';
    return `${kpis(t)}
      <div class="zd-sb-grid">
        <div class="zd-sb-panel"><h3>月度趋势 <span>销售额 / 净利润</span></h3>${bars(M)}</div>
        <div class="zd-sb-panel"><h3>渠道结构 <span>销售额占比</span></h3>${donut(C)}</div>
      </div>
      <div class="zd-sb-panel" style="margin-bottom:14px"><h3>日销售趋势 <span>最近 31 天</span></h3>${line(D)}</div>
      <div class="zd-sb-grid">
        <div class="zd-sb-panel"><h3>月度明细</h3>${tableM(M)}</div>
        <div class="zd-sb-panel"><h3>渠道明细</h3>${tableC(C)}</div>
      </div>`;
  }

  function render() {
    if (!overlay) return;
    const body = state.view === 'roadmap' ? renderRoadmap() : (state.loading ? '<div class="zd-sb-empty">加载中…</div>' : renderBoard());
    overlay.innerHTML = `
      <div class="zd-sb-head">
        <div>
          <h2 class="zd-sb-title"><b>销售看板</b> · 销售口径</h2>
          <div class="zd-sb-sub">数据来源：销售日数据（与财务账套独立核算）· 共 ${state.items.length} 条日记录</div>
        </div>
        <div class="zd-sb-actions">
          <input type="date" class="zd-sb-input" data-role="from" value="${state.from}">
          <span style="color:var(--faint,#9AA8A0)">~</span>
          <input type="date" class="zd-sb-input" data-role="to" value="${state.to}">
          <button class="zd-sb-btn" data-act="query">查询</button>
          <button class="zd-sb-btn" data-act="upload">上传数据</button>
          <button class="zd-sb-btn ${state.view === 'roadmap' ? 'primary' : ''}" data-act="roadmap">${state.view === 'roadmap' ? '返回看板' : '功能蓝图'}</button>
          <button class="zd-sb-btn primary" data-act="refresh">刷新</button>
        </div>
      </div>
      ${state.view === 'roadmap' ? '' : `<div class="zd-sb-dims">${DIMS.map(([k, l]) => `<span class="zd-sb-chip ${state.dim === k ? 'on' : ''}" data-dim="${k}">${l}</span>`).join('')}</div>`}
      ${body}`;
  }

  function onOverlayClick(e) {
    const dimEl = e.target.closest('[data-dim]');
    if (dimEl) {
      state.dim = dimEl.getAttribute('data-dim');
      const r = rangeOf(state.dim);
      state.from = r.from; state.to = r.to;
      render(); load();
      return;
    }
    const btn = e.target.closest('[data-act]');
    if (!btn) return;
    const act = btn.getAttribute('data-act');
    if (act === 'refresh' || act === 'query') {
      const f = overlay.querySelector('[data-role="from"]');
      const tt = overlay.querySelector('[data-role="to"]');
      if (f) state.from = f.value || state.from;
      if (tt) state.to = tt.value || state.to;
      if (act === 'query') state.dim = 'custom';
      load();
    } else if (act === 'roadmap') {
      state.view = state.view === 'roadmap' ? 'board' : 'roadmap';
      render();
    } else if (act === 'upload') {
      pickFile();
    }
  }

  /* ---------- 上传 / 解析 / 去重导入 ---------- */
  function pickFile() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.csv,.xlsx,.xls,.txt,.png,.jpg,.jpeg,.webp';
    inp.addEventListener('change', () => { const f = inp.files && inp.files[0]; if (f) handleFile(f); });
    inp.click();
  }

  function readBase64(file) {
    return new Promise((res, rej) => {
      const r = new FileReader();
      r.onload = () => res(String(r.result).split(',')[1] || '');
      r.onerror = rej;
      r.readAsDataURL(file);
    });
  }

  async function handleFile(file) {
    modal('解析中…', '<div class="zd-sb-empty">正在解析文件，请稍候…</div>', []);
    try {
      const b64 = await readBase64(file);
      const j = await api('/api/enterprise/sales/parse', { method: 'POST', body: JSON.stringify({ name: file.name, dataBase64: b64 }) });
      if (j.code !== 0) throw new Error(j.message || '解析失败');
      const d = j.data;
      if (d.kind === 'text') {
        modal('图片识别结果', `<div class="zd-sb-note">图片已识别为文本。自动结构化入账为「部分具备」，请核对文本；可复制整理为 CSV 后再导入。</div><pre style="white-space:pre-wrap;font-size:12px;background:var(--bg,#F3F1EB);padding:12px;border-radius:8px;max-height:360px;overflow:auto">${esc(d.text || '（未识别到文本）')}</pre>`, [['关闭', 'close']]);
        return;
      }
      const rows = d.rows || [];
      const preview = rows.slice(0, 8).map((r) => `<tr><td>${esc(r.date)}</td><td>${esc(r.product || r.sku)}</td><td>${money(r.amount)}</td><td>${money(r.return_amount)}</td><td>${r.channel ? esc(r.channel) : '—'}</td></tr>`).join('');
      modal('导入预览', `<div class="zd-sb-note">解析到 <b>${rows.length}</b> 行可导入数据（字段：${esc((d.fields || []).join('、') || '—')}）。导入时后端会自动去重，重复行不会重复入库。</div>
        <table class="zd-sb-table"><thead><tr><th>日期</th><th>商品</th><th>销售额</th><th>退款</th><th>渠道</th></tr></thead><tbody>${preview || '<tr><td colspan="5" class="zd-sb-empty">没有可导入的行</td></tr>'}</tbody></table>`,
      rows.length ? [['取消', 'close'], ['确认导入', 'import', rows]] : [['关闭', 'close']]);
    } catch (e) {
      modal('解析失败', `<div class="zd-sb-note">${esc(e.message)}</div>`, [['关闭', 'close']]);
    }
  }

  function modal(title, body, actions) {
    document.querySelectorAll('.zd-sb-mask,.zd-sb-modal').forEach((n) => n.remove());
    const mask = document.createElement('div'); mask.className = 'zd-sb-mask';
    const box = document.createElement('div'); box.className = 'zd-sb-modal';
    box.innerHTML = `<div class="zd-sb-modal-hd"><span>${esc(title)}</span><span class="zd-sb-x" data-m="close">×</span></div>
      <div class="zd-sb-modal-bd">${body}</div>
      <div class="zd-sb-modal-ft">${actions.map((a, i) => `<button class="zd-sb-btn ${i === actions.length - 1 ? 'primary' : ''}" data-m="${a[1]}" data-i="${i}">${esc(a[0])}</button>`).join('')}</div>`;
    document.body.appendChild(mask); document.body.appendChild(box);
    const close = () => { mask.remove(); box.remove(); };
    mask.addEventListener('click', close);
    box.querySelectorAll('[data-m]').forEach((el) => el.addEventListener('click', async () => {
      const m = el.getAttribute('data-m');
      if (m === 'close') return close();
      if (m === 'import') {
        const a = actions[Number(el.getAttribute('data-i'))];
        const rows = a[2];
        el.disabled = true; el.textContent = '导入中…';
        try {
          const j = await api('/api/enterprise/sales/import', { method: 'POST', body: JSON.stringify({ rows, source: 'sales_dept' }) });
          const msg = j.code === 0 ? (j.message || '导入完成') : (j.message || '导入失败');
          modal('导入结果', `<div class="zd-sb-note" style="background:#e8f6ef;border-color:#bfe6d3;color:#1e8a5a">${esc(msg)}</div>`, [['好的', 'close']]);
          await load();
        } catch (e) {
          modal('导入失败', `<div class="zd-sb-note">${esc(e.message)}</div>`, [['关闭', 'close']]);
        }
      }
    }));
  }

  /* ---------- 挂载与生命周期 ---------- */
  let tries = 0;
  const timer = setInterval(() => {
    ensureTab(); ensureSalesMenu(); setMenuMode(state.open ? 'sales' : 'finance');
    tries += 1; if (tries > 80) clearInterval(timer);
  }, 250);
  new MutationObserver(() => {
    ensureTab(); ensureSalesMenu(); setMenuMode(state.open ? 'sales' : 'finance');
    if (state.open && overlay && !overlay.isConnected) ensureOverlay();
  }).observe(document.body, { childList: true, subtree: true });

  // 点击其它 Tab 或路由变化时关闭销售看板
  document.addEventListener('click', (e) => {
    const t = e.target.closest('.ws-tab');
    if (state.open && t && !t.hasAttribute('data-zd-sales')) closeBoard();
  }, true);
  window.addEventListener('popstate', () => { if (state.open) closeBoard(); });
})();
