/**
 * 内嵌主区宿主：让注入的「报表中心 / 订单 / 文件格式转换」像财务原生页一样
 * 只占据主内容区（侧栏始终可见可点），而不是整页遮罩。
 *
 * 用法：
 *   window.__zdInline.apply(el)        把 fixed 定位的浮层收进主区
 *   window.__zdInline.mask(el)         遮罩改为不覆盖侧栏且透明
 *   window.__zdInline.register(fn)     登记关闭函数（点击侧栏时自动关闭）
 *   window.__zdInline.openFrame(url)   在主区内嵌 iframe 打开一个页面
 *   window.__zdInline.closeAll()
 */
(() => {
  if (window.__zdInline) return;
  const closers = new Set();

  function sidebarRight() {
    // 财务模式看 .app-menu，销售模式 .app-menu 被隐藏、改看 #zd-sales-menu；
    // 两者都取「侧栏容器」的右边缘，保证浮层恰好贴住主内容区左边界。
    const anchors = [document.querySelector('#zd-sales-menu'), document.querySelector('.app-menu')];
    for (const a of anchors) {
      if (!a) continue;
      const box = a.closest('aside') || a.parentElement || a;
      const r = box.getBoundingClientRect();
      if (r && r.width > 60) return Math.round(r.right);
    }
    const aside = document.querySelector('aside') || document.querySelector('.app-sidebar');
    const ra = aside && aside.getBoundingClientRect();
    if (ra && ra.width > 60) return Math.round(ra.right);
    return 236;
  }

  function apply(el) {
    if (!el) return;
    const L = sidebarRight();
    el.style.setProperty('left', L + 'px', 'important');
    el.style.setProperty('top', '0px', 'important');
    el.style.setProperty('right', '0px', 'important');
    el.style.setProperty('bottom', '0px', 'important');
    el.style.setProperty('width', 'auto', 'important');
    el.style.setProperty('max-width', 'none', 'important');
    el.style.setProperty('box-shadow', 'none', 'important');
    el.style.setProperty('border-left', '1px solid #E2DFD7', 'important');
    return L;
  }

  // 遮罩：不盖侧栏、不拦截点击（侧栏始终可操作）
  function mask(el) {
    if (!el) return;
    el.style.setProperty('left', sidebarRight() + 'px', 'important');
    el.style.setProperty('background', 'transparent', 'important');
    el.style.setProperty('pointer-events', 'none', 'important');
  }

  let openKey = '';
  function key(k) { openKey = k || ''; }
  function register(fn) {
    closers.add(fn);
    return () => closers.delete(fn);
  }

  function closeAll() {
    for (const fn of [...closers]) {
      try { fn(); } catch { /* ignore */ }
    }
    openKey = '';
  }

  let frameHost = null;
  function openFrame(url, title, k) {
    closeAll();
    openKey = k || 'convert';
    if (!frameHost) {
      frameHost = document.createElement('div');
      frameHost.id = 'zd-inline-frame';
      frameHost.style.cssText = 'position:fixed;z-index:10082;background:#F3F1EB;display:none;overflow:hidden';
      document.body.appendChild(frameHost);
    }
    apply(frameHost);
    frameHost.style.display = 'block';
    frameHost.innerHTML = `<iframe src="${url}" title="${title || ''}" style="width:100%;height:100%;border:0;display:block;background:#F3F1EB"></iframe>`;
    register(() => closeFrame());
    return frameHost;
  }
  function closeFrame() {
    if (frameHost) { frameHost.style.display = 'none'; frameHost.innerHTML = ''; }
  }

  // 点击侧栏入口 → 关闭主区浮层（但点的是同一个入口时不关，允许重复刷新）
  document.addEventListener('click', (e) => {
    const inSidebar = e.target.closest('.app-menu') || e.target.closest('#zd-sales-menu') || e.target.closest('#zd-side-foot');
    if (!inSidebar) return;
    const opener = e.target.closest('[data-zd-open]');
    const k = opener ? opener.getAttribute('data-zd-open') : '';
    if (k && k === openKey) return;
    closeAll();
  }, true);

  // 顶部 Tab 切换时也收起
  document.addEventListener('click', (e) => {
    if (e.target.closest('.ws-tabs')) setTimeout(closeAll, 0);
  }, true);

  window.__zdInline = { apply, mask, register, closeAll, openFrame, closeFrame, key, isOpen: () => !!frameHost && frameHost.style.display !== 'none' };
  window.__zdOpenConvert = () => window.__zdInline.openFrame('/convert.html?embed=1', '文件格式转换', 'convert');
})();
