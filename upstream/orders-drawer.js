/**
 * 订单 / 支出明细抽屉（注入式，不改编译产物）
 *
 * 左下角常驻一个「订单」胶囊：进行中 / 已结清 单量；
 * 点开右侧抽屉，两个页签：
 *   - 订单：列表 → 详情（明细、状态时间线、物流、改价记录）
 *   - 支出明细：按月列出凭证明细，可导出 Excel
 * 登录态沿用 sessionStorage 的 jl_token / jl_set_id。
 */
(() => {
  if (window.__zdOrdersDrawer) return;
  window.__zdOrdersDrawer = true;

  const API = location.origin;
  const token = () => sessionStorage.getItem('jl_token') || '';
  const setId = () => sessionStorage.getItem('jl_set_id') || '85';
  const period = () => new Date().toLocaleDateString('sv-SE').slice(0, 7);
  const money = (v) => Number(v || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const ST = { open: '进行中', partial: '部分发货', settled: '已结清', returning: '退货中', returned: '已退货', cancelled: '已取消' };
  const SH = { pending: '待发货', picked: '已揽收', transit: '运输中', delivering: '派送中', signed: '已签收', returned: '退回' };
  const ST_COLOR = { open: '#2f6fe4', partial: '#a86a12', settled: '#1e8e4e', returning: '#c0392b', returned: '#7c8394', cancelled: '#7c8394' };

  const css = `
  .zd-od{position:fixed;left:12px;bottom:70px;z-index:9997;font:13px/1.55 "Microsoft YaHei",system-ui,sans-serif;color:#1f2430}
  .zd-od *{box-sizing:border-box}
  .zd-od-pill{display:flex;align-items:center;gap:8px;background:#fff;border:1px solid #e3e7ef;border-radius:12px;padding:8px 12px;box-shadow:0 6px 20px rgba(20,30,60,.12);cursor:pointer;white-space:nowrap}
  .zd-od-pill b{color:#1f6feb}
  .zd-od-pill span.k{color:#8a90a2;font-size:12px}
  .zd-od-mask{position:fixed;inset:0;background:rgba(16,22,36,.28);z-index:9997}
  .zd-od-drawer{position:fixed;top:0;right:0;bottom:0;width:440px;max-width:92vw;background:#fff;z-index:9998;box-shadow:-12px 0 40px rgba(16,22,36,.18);display:flex;flex-direction:column}
  .zd-od-hd{display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #eef1f6}
  .zd-od-hd h3{margin:0;font-size:15px}
  .zd-od-x{cursor:pointer;color:#98a0b0;font-size:18px;padding:0 4px}
  .zd-od-tabs{display:flex;gap:6px;padding:10px 16px;border-bottom:1px solid #eef1f6}
  .zd-od-tab{padding:5px 12px;border-radius:999px;background:#f4f6fa;color:#5b6273;cursor:pointer;font-size:12px}
  .zd-od-tab.on{background:#1f6feb;color:#fff}
  .zd-od-body{flex:1;overflow:auto;padding:10px 0}
  .zd-od-row{padding:10px 16px;border-bottom:1px solid #f4f6fa;cursor:pointer}
  .zd-od-row:hover{background:#f8fafd}
  .zd-od-line{display:flex;justify-content:space-between;gap:8px;align-items:center}
  .zd-od-no{font-weight:600;font-variant-numeric:tabular-nums}
  .zd-od-sub{color:#8a90a2;font-size:12px;margin-top:2px}
  .zd-od-amt{font-variant-numeric:tabular-nums;font-weight:600}
  .zd-od-badge{font-size:10px;padding:1px 7px;border-radius:999px;color:#fff}
  .zd-od-sec{padding:12px 16px;border-bottom:1px solid #f4f6fa}
  .zd-od-sec h4{margin:0 0 8px;font-size:12px;color:#8a90a2;font-weight:500;letter-spacing:.5px}
  .zd-od-kv{display:flex;justify-content:space-between;padding:3px 0;font-size:12px}
  .zd-od-kv span:first-child{color:#8a90a2}
  .zd-od-tl{list-style:none;margin:0;padding:0}
  .zd-od-tl li{position:relative;padding:0 0 12px 14px;border-left:2px solid #eef1f6;font-size:12px}
  .zd-od-tl li:last-child{border-left-color:transparent;padding-bottom:0}
  .zd-od-tl li:before{content:'';position:absolute;left:-4px;top:4px;width:6px;height:6px;border-radius:50%;background:#c9ced9}
  .zd-od-tl small{color:#8a90a2;display:block}
  .zd-od-empty{padding:26px 16px;color:#8a90a2;font-size:12px;text-align:center;line-height:1.8}
  .zd-od-foot{padding:10px 16px;border-top:1px solid #eef1f6;display:flex;gap:8px}
  .zd-od-foot button{flex:1;border:1px solid #e3e7ef;background:#fff;border-radius:8px;padding:7px 0;font-size:12px;cursor:pointer;color:#3a4152}
  .zd-od-foot button.primary{background:#1f6feb;border-color:#1f6feb;color:#fff}
  .zd-od-back{color:#1f6feb;cursor:pointer;font-size:12px;padding:8px 16px;display:inline-block}
  `;

  const style = document.createElement('style');
  style.textContent = css;
  document.head.appendChild(style);

  const pill = document.createElement('div');
  pill.className = 'zd-od';
  document.body.appendChild(pill);

  let sum = null;
  let mask = null;
  let drawer = null;
  let tab = 'orders';
  let detail = null;

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
    if (r.status === 401) throw new Error('登录已过期');
    return r.json();
  }

  async function loadSummary() {
    if (!token()) return;
    try {
      const j = await api(`/api/orders/summary?period=${period()}`);
      if (j.code === 0) { sum = j.data; renderPill(); }
    } catch { /* 静默 */ }
  }

  function renderPill() {
    if (!sum) {
      pill.innerHTML = '<div class="zd-od-pill" data-act="open"><span>订单</span><span class="k">加载中…</span></div>';
    } else {
      pill.innerHTML = `<div class="zd-od-pill" data-act="open">
        <span>订单</span>
        <b>${sum.open_count}</b><span class="k">进行中</span>
        <span class="k">·</span>
        <span>${sum.total}</span><span class="k">本月单</span>
      </div>`;
    }
    bind(pill);
  }

  function badge(status) {
    const label = ST[status] || status;
    const color = ST_COLOR[status] || '#7c8394';
    return `<span class="zd-od-badge" style="background:${color}">${label}</span>`;
  }

  function ensureDrawer() {
    if (drawer) return;
    mask = document.createElement('div');
    mask.className = 'zd-od-mask';
    mask.addEventListener('click', close);
    drawer = document.createElement('div');
    drawer.className = 'zd-od-drawer';
    document.body.appendChild(mask);
    document.body.appendChild(drawer);
  }

  function close() {
    if (mask) mask.remove();
    if (drawer) drawer.remove();
    mask = null; drawer = null;
  }

  async function open(t = 'orders') {
    ensureDrawer();
    tab = t;
    detail = null;
    await render();
  }

  async function render() {
    if (!drawer) return;
    const head = `<div class="zd-od-hd"><h3>${detail ? '订单详情' : (tab === 'orders' ? '订单' : '支出明细')}</h3><span class="zd-od-x" data-act="close">×</span></div>`;
    const tabs = detail ? `<span class="zd-od-back" data-act="back">← 返回列表</span>` : `<div class="zd-od-tabs">
        <div class="zd-od-tab ${tab === 'orders' ? 'on' : ''}" data-act="tab" data-tab="orders">订单</div>
        <div class="zd-od-tab ${tab === 'expenses' ? 'on' : ''}" data-act="tab" data-tab="expenses">支出明细</div>
      </div>`;

    let body = '<div class="zd-od-empty">加载中…</div>';
    let foot = '';
    if (detail) {
      body = renderDetail(detail);
    } else if (tab === 'orders') {
      const j = await api(`/api/orders?limit=100`);
      const items = (j.data && j.data.items) || [];
      body = items.length
        ? items.map((o) => `<div class="zd-od-row" data-act="detail" data-id="${o.id}">
            <div class="zd-od-line"><span class="zd-od-no">${o.order_no}</span>${badge(o.status)}</div>
            <div class="zd-od-line zd-od-sub"><span>${o.customer || '散客'} · ${o.order_date}</span><span class="zd-od-amt">${money(o.net)}</span></div>
            ${o.shipment ? `<div class="zd-od-sub">物流：${SH[o.shipment.status] || o.shipment.status} ${o.shipment.tracking_no || ''}</div>` : ''}
          </div>`).join('')
        : '<div class="zd-od-empty">本月还没有订单。<br>对智能体说「建个订单，客户张三，面膜 2 盒 129 元」即可。</div>';
      foot = `<div class="zd-od-foot"><button data-act="refresh">刷新</button><button class="primary" data-act="exp-xlsx">导出订单 Excel</button></div>`;
    } else {
      const j = await api(`/api/expenses/detail?period=${period()}&limit=300`);
      const d = j.data || { items: [], count: 0, total: 0 };
      body = d.items.length
        ? `<div class="zd-od-sec"><h4>${period()} · 共 ${d.count} 条 · 净额 ${money(d.total)}</h4></div>` +
          d.items.map((x) => `<div class="zd-od-row">
            <div class="zd-od-line"><span>${x.summary || '（无摘要）'}</span><span class="zd-od-amt">${money(x.amount)}</span></div>
            <div class="zd-od-sub">${x.date} · ${x.voucher} · ${x.subject}</div>
          </div>`).join('')
        : '<div class="zd-od-empty">本月还没有凭证，支出明细为空。</div>';
      foot = `<div class="zd-od-foot"><button data-act="refresh">刷新</button><button class="primary" data-act="exp-xlsx">导出支出明细</button></div>`;
    }

    drawer.innerHTML = head + tabs + `<div class="zd-od-body">${body}</div>` + foot;
    bind(drawer);
  }

  function renderDetail(d) {
    const o = d.order;
    const items = d.items.map((it) => `<div class="zd-od-kv"><span>${it.name || it.sku} × ${it.qty}</span><span>${money(it.amount)}</span></div>`).join('');
    const tl = d.events.map((e) => `<li>${e.type === 'status' ? `${ST[e.from_v] || '—'} → ${ST[e.to_v] || e.to_v}` : (e.note || e.type)}
      <small>${e.effective_at || e.created_at}${e.created_by ? ` · ${e.created_by}` : ''}</small></li>`).join('');
    const ships = d.shipments.length
      ? d.shipments.map((s) => `<div class="zd-od-kv"><span>${s.carrier || '—'} ${s.tracking_no || ''}</span><span>${s.status_label || s.status}</span></div>`).join('')
      : '<div class="zd-od-kv"><span>暂无物流</span><span>—</span></div>';
    const prices = d.price_changes.length
      ? d.price_changes.map((p) => `<div class="zd-od-kv"><span>${p.old_price} → ${p.new_price}</span><span>${p.reason || '改价'}</span></div>`).join('')
      : '';
    return `
      <div class="zd-od-sec"><h4>订单</h4>
        <div class="zd-od-kv"><span>订单号</span><span>${o.order_no}</span></div>
        <div class="zd-od-kv"><span>客户 / 渠道</span><span>${o.customer || '散客'} · ${o.channel || '—'}</span></div>
        <div class="zd-od-kv"><span>状态</span><span>${badge(o.status)}</span></div>
        <div class="zd-od-kv"><span>金额 / 折扣</span><span>${money(o.amount)} / ${money(o.discount)}</span></div>
        <div class="zd-od-kv"><span>应收</span><span><b>${money(Number(o.amount) - Number(o.discount))}</b></span></div>
      </div>
      <div class="zd-od-sec"><h4>明细</h4>${items || '<div class="zd-od-sub">无</div>'}</div>
      <div class="zd-od-sec"><h4>物流</h4>${ships}</div>
      ${prices ? `<div class="zd-od-sec"><h4>改价记录</h4>${prices}</div>` : ''}
      <div class="zd-od-sec"><h4>状态时间线</h4><ul class="zd-od-tl">${tl || '<li>暂无记录</li>'}</ul></div>
    `;
  }

  function bind(root) {
    root.querySelectorAll('[data-act]').forEach((el) => {
      el.addEventListener('click', async (ev) => {
        ev.stopPropagation();
        const act = el.getAttribute('data-act');
        if (act === 'open') { await open('orders'); }
        else if (act === 'close') close();
        else if (act === 'tab') { tab = el.getAttribute('data-tab'); await render(); }
        else if (act === 'refresh') await render();
        else if (act === 'back') { detail = null; await render(); }
        else if (act === 'detail') {
          const id = el.getAttribute('data-id');
          const j = await api(`/api/orders/${id}`);
          if (j.code === 0) { detail = j.data; await render(); }
        } else if (act === 'exp-xlsx') {
          const kind = tab === 'orders' ? 'orders' : 'expenses';
          const url = `/api/export/report?kind=${kind}&period=${period()}&format=xlsx&token=${encodeURIComponent(token())}`;
          window.open(url, '_blank');
        }
      });
    });
  }

  renderPill();
  loadSummary();
  setInterval(loadSummary, 60000);
  window.addEventListener('storage', (e) => { if (e.key === 'jl_set_id') loadSummary(); });
})();
