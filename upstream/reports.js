/**
 * 报表中心（财务/销售双口径）
 * 独立浮层：由财务侧栏「报表」或销售侧栏「报表」打开。
 * 支持：日报/半月/月报/季报/半年/年报/三年/自定义首尾时间。
 * 数据：销售=/api/enterprise/sales；财务=/api/reports/income（按月）；员工=/api/enterprise/work-reports。
 */
(() => {
  if (window.__zdReports) return;
  window.__zdReports = true;

  const token = () => localStorage.getItem('jl_token') || sessionStorage.getItem('jl_token') || '';
  const setId = () => localStorage.getItem('jl_set_id') || sessionStorage.getItem('jl_set_id') || '85';
  const money = (v) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const pct = (a, b) => (b ? ((a / b) * 100).toFixed(2) : '0.00');
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const ymd = (d) => d.toLocaleDateString('sv-SE');
  const pad = (n) => String(n).padStart(2, '0');

  const DIMS = [
    ['day', '日报'], ['halfmonth', '半月'], ['month', '月报'], ['quarter', '季报'],
    ['halfyear', '半年'], ['year', '年报'], ['3year', '三年'], ['custom', '自定义'],
  ];
  const CATS = {
    sales: [['summary', '汇总'], ['channel', '渠道汇总'], ['staff', '员工报表'], ['product', '商品报表'], ['intake', '数据归集']],
    finance: [['summary', '利润汇总'], ['staff', '员工报表']],
  };

  const today = new Date();
  const st = { open: false, caliber: 'sales', dim: 'month', cat: 'summary', from: '', to: '', rows: [], kpi: null, loading: false, err: '', note: '' };

  function rangeOf(dim) {
    const y = today.getFullYear(), m = today.getMonth() + 1, d = today.getDate();
    const first = `${y}-${pad(m)}-01`;
    const last = ymd(new Date(y, m, 0));
    switch (dim) {
      case 'day': return { from: ymd(today), to: ymd(today) };
      case 'halfmonth': return d <= 15 ? { from: first, to: `${y}-${pad(m)}-15` } : { from: `${y}-${pad(m)}-16`, to: last };
      case 'month': return { from: first, to: last };
      case 'quarter': { const q = Math.floor((m - 1) / 3); return { from: `${y}-${pad(q * 3 + 1)}-01`, to: ymd(new Date(y, q * 3 + 3, 0)) }; }
      case 'halfyear': { const h = m <= 6 ? 0 : 1; return { from: `${y}-${pad(h * 6 + 1)}-01`, to: ymd(new Date(y, h * 6 + 6, 0)) }; }
      case 'year': return { from: `${y}-01-01`, to: `${y}-12-31` };
      case '3year': return { from: `${y - 2}-01-01`, to: ymd(today) };
      default: return { from: st.from || first, to: st.to || last };
    }
  }

  function bucketOf(dim, date) {
    const s = String(date).slice(0, 10), y = s.slice(0, 4), m = Number(s.slice(5, 7)), d = Number(s.slice(8, 10));
    if (dim === 'day') return s;
    if (dim === 'halfmonth') return `${y}-${pad(m)}-${d <= 15 ? 'H1' : 'H2'}`;
    if (dim === 'quarter') return `${y}-Q${Math.floor((m - 1) / 3) + 1}`;
    if (dim === 'halfyear') return `${y}-H${m <= 6 ? 1 : 2}`;
    if (dim === 'year' || dim === '3year') return y;
    if (dim === 'custom') {
      const span = (new Date(st.to) - new Date(st.from)) / 86400000;
      return span > 31 ? `${y}-${pad(m)}` : s;
    }
    return `${y}-${pad(m)}`;
  }

  async function api(path) {
    const r = await fetch(location.origin + path, { headers: { authorization: `Bearer ${token()}`, 'x-set-id': setId() } });
    if (r.status === 401) throw new Error('登录已过期，请重新登录');
    return r.json();
  }

  async function loadSalesReport(from, to) {
    const j = await api(`/api/enterprise/sales?from=${from}&to=${to}&limit=1000`);
    if (j.code !== 0) throw new Error(j.message || '加载失败');
    return (j.data && j.data.items) || [];
  }

  async function loadFinanceReport(from, to) {
    const months = [];
    let cur = new Date(from.slice(0, 7) + '-01');
    const end = new Date(to.slice(0, 7) + '-01');
    let guard = 0;
    while (cur <= end && guard < 40) {
      months.push(`${cur.getFullYear()}-${pad(cur.getMonth() + 1)}`);
      cur = new Date(cur.getFullYear(), cur.getMonth() + 1, 1);
      guard += 1;
    }
    const out = [];
    for (const p of months) {
      const j = await api(`/api/reports/income?period=${p}`);
      if (j.code !== 0 || !j.data) continue;
      const rows = j.data.rows || j.data.items || [];
      const get = (kw) => { const r = rows.find((x) => String(x.item || x.name || '').includes(kw)); return r ? Number(r.current || r.amount || 0) : 0; };
      const revenue = get('营业收入');
      const cost = get('营业成本');
      const expense = get('销售费用') + get('管理费用') + get('财务费用');
      const profit = get('净利润');
      out.push({ date: `${p}-01`, period: p, amount: revenue, ret: 0, fee: expense, net: profit, cost });
    }
    return out;
  }

  function aggregate(items, dim, keyFn) {
    const M = new Map();
    let t = { amount: 0, ret: 0, fee: 0, net: 0, cnt: 0 };
    for (const it of items) {
      const k = keyFn(it);
      if (!M.has(k)) M.set(k, { amount: 0, ret: 0, fee: 0, net: 0, cnt: 0 });
      const o = M.get(k);
      o.amount += Number(it.amount || 0); o.ret += Number(it.ret || it.return_amount || 0);
      o.fee += Number(it.fee || 0); o.net += Number(it.net || 0); o.cnt += 1;
      t.amount += Number(it.amount || 0); t.ret += Number(it.ret || it.return_amount || 0);
      t.fee += Number(it.fee || 0); t.net += Number(it.net || 0); t.cnt += 1;
    }
    return { list: [...M.entries()].map(([k, v]) => ({ key: k, ...v })).sort((a, b) => (a.key < b.key ? -1 : 1)), total: t };
  }

  const CSS = `
  .zd-rp{position:fixed;inset:0;z-index:10080;background:var(--bg,#F3F1EB);overflow:auto;padding:20px 26px 48px;
    box-sizing:border-box;font:13px/1.55 "Microsoft YaHei",system-ui,sans-serif;color:var(--ink,#17241F);display:none}
  .zd-rp.show{display:block}
  .zd-rp *{box-sizing:border-box}
  .zd-rp-head{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap;margin-bottom:14px}
  .zd-rp-title{font-size:22px;font-weight:700;margin:0}
  .zd-rp-title b{color:#1F5E4C}
  .zd-rp-badge{display:inline-block;margin-left:8px;font-size:11px;font-weight:600;color:#fff;background:#1F5E4C;border-radius:999px;padding:2px 9px;vertical-align:middle}
  .zd-rp-sub{color:var(--muted,#6E7B76);font-size:12px;margin-top:4px}
  .zd-rp-btn{height:32px;border:1px solid var(--line,#E2DFD7);background:#fff;border-radius:9px;padding:0 13px;font-size:12px;cursor:pointer;color:var(--ink-2,#3D4F49);font-family:inherit}
  .zd-rp-btn:hover{border-color:#46B391;color:#1F5E4C}
  .zd-rp-btn.primary{background:linear-gradient(135deg,#1F5E4C,#46B391);color:#fff;border:0}
  .zd-rp-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
  .zd-rp-chip{border:1px solid var(--line,#E2DFD7);background:#fff;color:var(--ink-2,#3D4F49);border-radius:999px;padding:5px 13px;font-size:12px;cursor:pointer}
  .zd-rp-chip.on{background:#1F5E4C;border-color:#1F5E4C;color:#fff}
  .zd-rp-card{background:#fff;border:1px solid var(--line,#E2DFD7);border-radius:14px;padding:15px 16px;margin-bottom:14px;box-shadow:0 1px 2px rgba(23,36,31,.05)}
  .zd-rp-kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px;margin-bottom:14px}
  .zd-rp-kpi{background:#fff;border:1px solid var(--line,#E2DFD7);border-radius:13px;padding:13px 15px}
  .zd-rp-kpi .k{font-size:12px;color:var(--muted,#6E7B76);margin-bottom:6px}
  .zd-rp-kpi .v{font-size:20px;font-weight:700}
  .zd-rp-kpi.hl{background:linear-gradient(135deg,#1F5E4C,#46B391);border:0;color:#fff}
  .zd-rp-kpi.hl .k{color:#d9efe9}
  .zd-rp-table{width:100%;border-collapse:collapse;font-size:12.5px}
  .zd-rp-table th,.zd-rp-table td{padding:9px 8px;border-bottom:1px solid var(--line-2,#EFECE4);text-align:right}
  .zd-rp-table th:first-child,.zd-rp-table td:first-child{text-align:left}
  .zd-rp-table thead th{color:var(--muted,#6E7B76);font-weight:600;font-size:11.5px}
  .zd-rp-table tfoot td{font-weight:700;border-top:2px solid var(--line,#E2DFD7)}
  .zd-rp-date{height:32px;border:1px solid var(--line,#E2DFD7);border-radius:8px;padding:0 8px;font-size:12px;background:#fff;color:var(--ink,#17241F)}
  .zd-rp-note{background:#FBF4E6;border:1px solid #E8D9B5;color:#8A6A2A;border-radius:9px;padding:9px 12px;font-size:12px;margin-bottom:12px}
  .zd-rp-empty{padding:30px;text-align:center;color:var(--faint,#9AA8A0)}
  .zd-rp-pos{color:#B45A4B}.zd-rp-neg{color:#2F7D5E}
  .zd-rp-staff{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:12px}
  .zd-rp-staffcard{border:1px solid var(--line-2,#EFECE4);border-radius:12px;padding:12px 14px}
  .zd-rp-staffcard h4{margin:0 0 6px;font-size:13px}
  .zd-rp-staffcard .m{color:var(--muted,#6E7B76);font-size:12px}
  .zd-dash-dims{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:6px 6px 4px;font-size:12px}
  .zd-dash-dims .t{color:var(--muted,#6E7B76);margin-right:4px}
  .zd-dash-dims .c{border:1px solid var(--line,#E2DFD7);background:#fff;border-radius:999px;padding:4px 11px;cursor:pointer;color:var(--ink-2,#3D4F49)}
  .zd-dash-dims .c:hover{border-color:#46B391;color:#1F5E4C}
  `;
  const style = document.createElement('style'); style.textContent = CSS; document.head.appendChild(style);

  let el = null;
  function ensure() {
    if (el && el.isConnected) return el;
    el = document.createElement('div'); el.className = 'zd-rp';
    document.body.appendChild(el);
    return el;
  }

  let unregister = null;
  function open(caliber = 'sales', dim = 'month', cat = 'summary') {
    st.caliber = caliber === 'finance' ? 'finance' : 'sales';
    st.dim = dim || 'month';
    st.cat = cat || 'summary';
    const r = rangeOf(st.dim); st.from = r.from; st.to = r.to;
    st.open = true;
    const node = ensure();
    node.classList.add('show');
    // 只占主内容区，侧栏保持可见可点
    if (window.__zdInline) {
      window.__zdInline.key('report');
      window.__zdInline.apply(node);
      if (unregister) unregister();
      unregister = window.__zdInline.register(close);
    }
    load();
  }
  window.__zdOpenReports = open;

  function close() {
    st.open = false;
    if (el) el.classList.remove('show');
    if (unregister) { unregister(); unregister = null; }
  }
  window.__zdCloseReports = close;

  async function load() {
    st.loading = true; st.err = ''; st.note = ''; st.rows = []; st.kpi = null;
    render();
    try {
      if (!token()) throw new Error('未登录');
      if (st.cat === 'intake') {
        const j = await api(`/api/enterprise/intake?from=${st.from}&to=${st.to}&limit=300`);
        st.rows = (j.data && j.data.items) || [];
        st.kpi = null;
        st.note = (j.data && j.data.note) || '按提交人 / 日期归档的报表与数据文件。';
      } else if (st.cat === 'staff') {
        const j = await api('/api/enterprise/work-reports?limit=200');
        const all = (j.data && (j.data.items || j.data.list)) || [];
        st.rows = all.filter((x) => { const p = String(x.period || x.created_at || '').slice(0, 10); return !p || (p >= st.from && p <= st.to); });
      } else if (st.caliber === 'finance') {
        const items = await loadFinanceReport(st.from, st.to);
        st.note = '财务口径按已审核/已记账凭证的月度利润表汇总（草稿不计入）。';
        const agg = st.cat === 'channel' ? null : aggregate(items, st.dim, (it) => bucketOf(st.dim, it.date));
        if (agg) { st.rows = agg.list; st.kpi = agg.total; }
        else { st.rows = []; st.kpi = { amount: 0, ret: 0, fee: 0, net: 0, cnt: 0 }; }
      } else {
        const items = (await loadSalesReport(st.from, st.to)).map((x) => ({ ...x, ret: x.return_amount, net: x.net_profit, date: x.date }));
        if (st.cat === 'channel') {
          const agg = aggregate(items, st.dim, (it) => it.group_name || '未分组');
          st.rows = agg.list.sort((a, b) => b.amount - a.amount); st.kpi = agg.total;
        } else if (st.cat === 'product') {
          st.note = '商品/单品维度需先补 SKU 明细，当前数据源仅「全店」。';
          st.rows = []; st.kpi = { amount: 0, ret: 0, fee: 0, net: 0, cnt: 0 };
        } else {
          const agg = aggregate(items, st.dim, (it) => bucketOf(st.dim, it.date));
          st.rows = agg.list; st.kpi = agg.total;
        }
      }
    } catch (e) {
      st.err = e.message || '加载失败';
    } finally { st.loading = false; render(); }
  }

  function kpis(t) {
    if (!t) return '';
    const ns = t.amount - t.ret;
    return `<div class="zd-rp-kpis">
      <div class="zd-rp-kpi hl"><div class="k">销售额</div><div class="v">¥${money(t.amount)}</div></div>
      <div class="zd-rp-kpi"><div class="k">净销售额</div><div class="v">¥${money(ns)}</div></div>
      <div class="zd-rp-kpi"><div class="k">退款</div><div class="v zd-rp-pos">¥${money(t.ret)}</div></div>
      <div class="zd-rp-kpi"><div class="k">费用</div><div class="v">¥${money(t.fee)}</div></div>
      <div class="zd-rp-kpi"><div class="k">净利润</div><div class="v zd-rp-neg">¥${money(t.net)}</div></div>
      <div class="zd-rp-kpi"><div class="k">净利率</div><div class="v">${pct(t.net, ns)}%</div></div>
    </div>`;
  }

  function tableRows() {
    if (!st.rows.length) return '<div class="zd-rp-empty">当前范围没有数据</div>';
    const head = st.cat === 'channel'
      ? '<tr><th>渠道</th><th>销售额</th><th>退款</th><th>费用</th><th>净利润</th><th>净利率</th></tr>'
      : '<tr><th>周期</th><th>销售额</th><th>退款</th><th>净销售</th><th>费用</th><th>净利润</th><th>净利率</th></tr>';
    const body = st.rows.map((r) => {
      const ns = r.amount - r.ret;
      if (st.cat === 'channel') return `<tr><td>${esc(r.key)}</td><td>${money(r.amount)}</td><td class="zd-rp-neg">${money(r.ret)}</td><td>${money(r.fee)}</td><td class="zd-rp-pos">${money(r.net)}</td><td>${pct(r.net, ns)}%</td></tr>`;
      return `<tr><td>${esc(r.key)}</td><td>${money(r.amount)}</td><td class="zd-rp-neg">${money(r.ret)}</td><td>${money(ns)}</td><td>${money(r.fee)}</td><td class="zd-rp-pos">${money(r.net)}</td><td>${pct(r.net, ns)}%</td></tr>`;
    }).join('');
    const t = st.kpi || { amount: 0, ret: 0, fee: 0, net: 0 };
    const ns = t.amount - t.ret;
    const foot = st.cat === 'channel'
      ? `<tfoot><tr><td>合计</td><td>${money(t.amount)}</td><td class="zd-rp-neg">${money(t.ret)}</td><td>${money(t.fee)}</td><td class="zd-rp-pos">${money(t.net)}</td><td>${pct(t.net, ns)}%</td></tr></tfoot>`
      : `<tfoot><tr><td>合计</td><td>${money(t.amount)}</td><td class="zd-rp-neg">${money(t.ret)}</td><td>${money(ns)}</td><td>${money(t.fee)}</td><td class="zd-rp-pos">${money(t.net)}</td><td>${pct(t.net, ns)}%</td></tr></tfoot>`;
    return `<table class="zd-rp-table"><thead>${head}</thead><tbody>${body}</tbody>${foot}</table>`;
  }

  function staffCards() {
    if (!st.rows.length) return '<div class="zd-rp-empty">当前范围没有员工报表（可通过智能体录入工作汇报）</div>';
    const by = new Map();
    for (const r of st.rows) {
      const k = r.author || r.dept || '未署名';
      if (!by.has(k)) by.set(k, []);
      by.get(k).push(r);
    }
    return `<div class="zd-rp-staff">${[...by.entries()].map(([k, list]) => `<div class="zd-rp-staffcard"><h4>${esc(k)}</h4><div class="m">${list.length} 份 · ${esc((list[0].period || list[0].created_at || '').slice(0, 10))}</div><div class="m" style="margin-top:6px">${esc(String(list[0].content || '').slice(0, 80))}</div></div>`).join('')}</div>`;
  }

  const CAT_LABEL = { sales: '销售', finance: '财务', attachment: '附件', report: '报表', other: '其他' };
  function intakeTable() {
    if (!st.rows.length) return '<div class="zd-rp-empty">当前范围没有归集数据</div>';
    const rows = st.rows.map((r) => `<tr><td>${esc(r.doc_date || '')}</td><td>${esc(r.sender_name || r.source || '')}</td><td>${esc(CAT_LABEL[r.category] || r.category || '—')}</td><td>${esc(r.file_name || '')}</td><td>${esc(r.status || '')}</td></tr>`).join('');
    return `<table class="zd-rp-table"><thead><tr><th>日期</th><th>提交人</th><th>类别</th><th>文件</th><th>状态</th></tr></thead><tbody>${rows}</tbody></table>`;
  }

  function render() {
    if (!el) return;
    const caliberLabel = st.caliber === 'finance' ? '财务口径' : '销售口径';
    const cats = CATS[st.caliber];
    let body = '';
    if (st.loading) body = '<div class="zd-rp-empty">加载中…</div>';
    else if (st.err) body = `<div class="zd-rp-note">${esc(st.err)}</div>`;
    else if (st.cat === 'staff') body = staffCards();
    else if (st.cat === 'intake') body = `<div class="zd-rp-card">${intakeTable()}</div>`;
    else body = kpis(st.kpi) + `<div class="zd-rp-card">${tableRows()}</div>`;
    el.innerHTML = `
      <div class="zd-rp-head">
        <div>
          <h2 class="zd-rp-title"><b>报表中心</b><span class="zd-rp-badge">${caliberLabel}</span></h2>
          <div class="zd-rp-sub">时间范围 ${st.from} ~ ${st.to}　|　维度 ${esc((DIMS.find((d) => d[0] === st.dim) || [])[1] || '')}　|　分类 ${esc((cats.find((c) => c[0] === st.cat) || [])[1] || '')}</div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <button class="zd-rp-btn primary" data-a="reload">生成报表</button>
        </div>
      </div>
      <div class="zd-rp-bar">${DIMS.map(([k, l]) => `<span class="zd-rp-chip ${st.dim === k ? 'on' : ''}" data-d="${k}">${l}</span>`).join('')}</div>
      ${st.dim === 'custom' ? `<div class="zd-rp-bar"><input type="date" class="zd-rp-date" data-f value="${st.from}"><span style="color:#9AA8A0">~</span><input type="date" class="zd-rp-date" data-t value="${st.to}"><button class="zd-rp-btn" data-a="reload">应用</button></div>` : ''}
      <div class="zd-rp-bar">${cats.map(([k, l]) => `<span class="zd-rp-chip ${st.cat === k ? 'on' : ''}" data-c="${k}">${l}</span>`).join('')}</div>
      ${st.note ? `<div class="zd-rp-note">${esc(st.note)}</div>` : ''}
      ${body}`;
  }

  // 财务主页看板：顶部注入时间维度切换条（点击打开对应维度汇总）
  function ensureDashBar() {
    const onDash = location.pathname === '/dashboard' && !document.querySelector('.zd-sb.show') && !document.querySelector('.zd-rp.show');
    let bar = document.getElementById('zd-dash-dims');
    if (!onDash) { if (bar) bar.remove(); return; }
    const main = document.querySelector('.app-main');
    if (!main) return;
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'zd-dash-dims';
      bar.className = 'zd-dash-dims';
      bar.innerHTML = '<span class="t">时间维度</span>' + DIMS.map(([k, l]) => `<span class="c" data-x="${k}">${l}</span>`).join('');
      bar.addEventListener('click', (e) => {
        const c = e.target.closest('[data-x]');
        if (c) open('finance', c.getAttribute('data-x'));
      });
    }
    if (main.firstElementChild !== bar) main.insertBefore(bar, main.firstElementChild || null);
  }
  setInterval(ensureDashBar, 800);
  new MutationObserver(ensureDashBar).observe(document.body, { childList: true, subtree: true });

  document.addEventListener('click', (e) => {
    if (!st.open) return;
    const chip = e.target.closest('[data-d]');
    if (chip) { st.dim = chip.getAttribute('data-d'); const r = rangeOf(st.dim); st.from = r.from; st.to = r.to; load(); return; }
    const c2 = e.target.closest('[data-c]');
    if (c2) { st.cat = c2.getAttribute('data-c'); load(); return; }
    const a = e.target.closest('[data-a]');
    if (!a) return;
    if (a.getAttribute('data-a') === 'close') close();
    if (a.getAttribute('data-a') === 'reload') {
      const f = el.querySelector('[data-f]'), t = el.querySelector('[data-t]');
      if (f) st.from = f.value || st.from;
      if (t) st.to = t.value || st.to;
      load();
    }
  });
})();
