/* 妆点管账 · 用户菜单增强（个人中心 / 修改密码）
 * 背景：原前端「个人中心」未实现（仅提示"功能开发中"），「修改密码」依赖
 *       Element 下拉内部事件链、在桌面壳内触发不稳。
 * 方案：在捕获阶段拦截这两个菜单项的点击，用可靠的原生弹窗统一呈现。
 *       不改动 minified bundle，可随时通过删除本文件 + 回退 index.html 还原。
 */
(function () {
  'use strict';
  if (window.__zdUserMenuEnhance) return;
  window.__zdUserMenuEnhance = true;

  var Z = '99999';
  var BRAND = '#742a54', BRAND_DARK = '#4a2438', PINK = '#fce9f2';

  // ---------- 工具 ----------
  function ls(k, d) { try { return localStorage.getItem(k) || d || ''; } catch (e) { return d || ''; } }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
  }); }
  function token() { return ls('jl_token', ''); }
  function api(path, opts) {
    opts = opts || {};
    var headers = { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + token() };
    var sid = ls('jl_set_id', '');
    if (sid) headers['X-Set-Id'] = sid;
    return fetch('/api' + path, Object.assign({ headers: headers }, opts))
      .then(function (r) { return r.json(); });
  }

  // ---------- 通用弹窗 ----------
  function ensureLayer() {
    var layer = document.getElementById('zd-um-layer');
    if (!layer) {
      layer = document.createElement('div');
      layer.id = 'zd-um-layer';
      layer.style.cssText = 'position:fixed;inset:0;z-index:' + Z + ';display:none;' +
        'align-items:center;justify-content:center;background:rgba(30,12,22,.42);' +
        'font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;';
      document.body.appendChild(layer);
      layer.addEventListener('mousedown', function (e) { if (e.target === layer) close(); });
    }
    return layer;
  }
  function close() {
    var layer = document.getElementById('zd-um-layer');
    if (layer) { layer.style.display = 'none'; layer.innerHTML = ''; }
  }
  function showCard(title, bodyHtml, footerHtml, width) {
    var layer = ensureLayer();
    layer.innerHTML =
      '<div style="width:' + (width || 440) + 'px;max-width:92vw;background:#fff;border-radius:14px;' +
      'box-shadow:0 18px 60px rgba(74,36,56,.28);overflow:hidden;">' +
        '<div style="display:flex;align-items:center;justify-content:space-between;' +
        'padding:18px 22px;border-bottom:1px solid #f0e6ec;">' +
          '<span style="font-size:17px;font-weight:600;color:' + BRAND_DARK + ';">' + esc(title) + '</span>' +
          '<span id="zd-um-x" style="cursor:pointer;font-size:20px;color:#9b7189;line-height:1;">×</span>' +
        '</div>' +
        '<div style="padding:22px;color:' + BRAND_DARK + ';font-size:14px;">' + bodyHtml + '</div>' +
        (footerHtml ? '<div style="padding:14px 22px;border-top:1px solid #f0e6ec;text-align:right;">' + footerHtml + '</div>' : '') +
      '</div>';
    layer.style.display = 'flex';
    document.getElementById('zd-um-x').onclick = close;
  }
  function btn(label, primary) {
    return '<button id="zd-um-btn" style="border:0;border-radius:8px;padding:9px 22px;cursor:pointer;' +
      'font-size:14px;' + (primary
        ? 'background:' + BRAND + ';color:#fff;'
        : 'background:#f5eef2;color:' + BRAND_DARK + ';') + '">' + esc(label) + '</button>';
  }
  function tip(msg, ok) {
    var t = document.createElement('div');
    t.textContent = msg;
    t.style.cssText = 'position:fixed;left:50%;top:24px;transform:translateX(-50%);z-index:' + (Z + 1) +
      ';padding:11px 22px;border-radius:8px;font-size:14px;color:#fff;box-shadow:0 6px 24px rgba(0,0,0,.18);' +
      'background:' + (ok ? '#2e8b57' : '#c0392b') + ';';
    document.body.appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transition = 'opacity .4s'; }, 2200);
    setTimeout(function () { t.remove(); }, 2700);
  }

  // ---------- 个人中心 ----------
  function showProfile() {
    var name = ls('jl_name', '') || ls('jl_username', '用户');
    var initial = name.charAt(0).toUpperCase();
    var username = ls('jl_username', '-');
    var roleId = ls('jl_role', '');
    var isSuper = ls('jl_super', '0') === '1';
    var setId = ls('jl_set_id', '') || '85';
    var menus = [];
    try { menus = JSON.parse(ls('jl_menus', '[]')) || []; } catch (e) {}

    showCard('个人中心',
      '<div style="display:flex;align-items:center;gap:16px;margin-bottom:20px;">' +
        '<div style="width:60px;height:60px;border-radius:50%;background:' + PINK + ';color:' + BRAND +
        ';display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:600;flex:none;">' + esc(initial) + '</div>' +
        '<div><div style="font-size:19px;font-weight:600;">' + esc(name) + '</div>' +
        '<div style="color:#9b7189;font-size:13px;margin-top:4px;">@' + esc(username) + '</div></div>' +
      '</div>' +
      '<div style="border-top:1px solid #f5eef2;padding-top:6px;">' +
        row('登录账号', esc(username)) +
        row('显示名称', esc(name)) +
        row('用户角色', '<span id="zd-um-role">' + (isSuper ? '超级管理员' : (roleId === '1' ? '管理员' : '角色 #' + esc(roleId))) + '</span>') +
        row('当前账套', '账套 #' + esc(setId)) +
        row('可用菜单', menus.length + ' 项') +
        row('登录状态', '<span style="color:#2e8b57;">● 已登录</span>') +
      '</div>',
      btn('关闭', true), 460);

    document.getElementById('zd-um-btn').onclick = close;
    // 异步补充真实角色名与账套名
    var roleEl = document.getElementById('zd-um-role');
    if (roleEl && roleId && roleId !== 'null') {
      api('/roles').then(function (j) {
        var list = (j.data && (j.data.list || j.data)) || [];
        var found = (Array.isArray(list) ? list : []).filter(function (r) { return String(r.id) === String(roleId); })[0];
        if (found && roleEl) roleEl.textContent = found.name;
      }).catch(function () {});
    }
  }
  function row(k, v) {
    return '<div style="display:flex;justify-content:space-between;padding:9px 0;border-bottom:1px dashed #f2e8ee;">' +
      '<span style="color:#9b7189;">' + k + '</span><span style="font-weight:500;">' + v + '</span></div>';
  }

  // ---------- 修改密码 ----------
  function showChangePwd() {
    var f =
      field('原密码', 'oldPassword', '请输入原密码') +
      field('新密码', 'newPassword', '请输入新密码（6-32 位）') +
      field('确认密码', 'confirmPassword', '请再次输入新密码');
    showCard('修改密码',
      '<div id="zd-um-err" style="display:none;color:#c0392b;font-size:13px;margin-bottom:10px;"></div>' + f,
      '<button id="zd-um-cancel" style="border:0;border-radius:8px;padding:9px 22px;cursor:pointer;font-size:14px;' +
      'background:#f5eef2;color:' + BRAND_DARK + ';margin-right:10px;">取消</button>' + btn('确定修改', true), 420);
    document.getElementById('zd-um-cancel').onclick = close;
    document.getElementById('zd-um-btn').onclick = submitPwd;
    ['oldPassword', 'newPassword', 'confirmPassword'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.addEventListener('keydown', function (e) { if (e.key === 'Enter') submitPwd(); });
    });
  }
  function field(label, id, ph) {
    return '<div style="margin-bottom:14px;"><div style="font-size:13px;color:#9b7189;margin-bottom:6px;">' + label + '</div>' +
      '<input id="' + id + '" type="password" placeholder="' + ph + '" ' +
      'style="box-sizing:border-box;width:100%;height:40px;border:1px solid #e3d5de;border-radius:8px;' +
      'padding:0 12px;font-size:14px;color:' + BRAND_DARK + ';outline:none;" ' +
      'onfocus="this.style.borderColor=\'' + BRAND + '\'" onblur="this.style.borderColor=\'#e3d5de\'"></div>';
  }
  function err(msg) {
    var e = document.getElementById('zd-um-err');
    if (e) { e.textContent = msg; e.style.display = 'block'; }
  }
  function submitPwd() {
    var oldP = (document.getElementById('oldPassword') || {}).value || '';
    var newP = (document.getElementById('newPassword') || {}).value || '';
    var cfm = (document.getElementById('confirmPassword') || {}).value || '';
    if (!oldP) return err('请输入原密码');
    if (!newP || newP.length < 6 || newP.length > 32) return err('新密码长度需为 6-32 位');
    if (newP !== cfm) return err('两次输入的新密码不一致');
    var b = document.getElementById('zd-um-btn');
    b.disabled = true; b.textContent = '提交中…';
    api('/auth/change-password', { method: 'POST', body: JSON.stringify({ oldPassword: oldP, newPassword: newP }) })
      .then(function (j) {
        if (j && j.code === 0) {
          // 同步本地自动登录凭据（静默，失败不影响改密成功）
          fetch('/__local/sync-credentials', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ password: newP })
          }).catch(function () {});
          close(); tip(j.message || '密码修改成功', true);
        } else {
          err((j && j.message) || '修改失败');
          b.disabled = false; b.textContent = '确定修改';
        }
      })
      .catch(function () {
        err('网络异常，请稍后重试'); b.disabled = false; b.textContent = '确定修改';
      });
  }

  // ---------- 拦截菜单点击（捕获阶段，先于 Vue） ----------
  document.addEventListener('click', function (e) {
    var item = e.target && e.target.closest && e.target.closest('.el-dropdown-menu__item');
    if (!item) return;
    var label = (item.textContent || '').trim();
    if (label === '个人中心') {
      e.stopImmediatePropagation(); e.preventDefault();
      close(); showProfile();
    } else if (label === '修改密码') {
      e.stopImmediatePropagation(); e.preventDefault();
      close(); showChangePwd();
    }
  }, true);

  // ESC 关闭
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
})();
