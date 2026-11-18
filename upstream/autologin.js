/* 妆点管账 · 本地版自动登录
 * 目标：打开页面即免输入账号密码，直接进入主界面。
 * 原理：在 Vue bundle 执行前，同步检查 localStorage 是否已登录；未登录则用
 *       本地后端提供的 /__local/auto-login 端点换取会话，并按前端约定的键名
 *       （jl_token / jl_username / jl_name / jl_role / jl_super / jl_menus）
 *       写入 localStorage。所有操作同步完成，确保 bundle 启动时登录态已就绪。
 * 说明：仅在本地后端可达时生效；任何异常都静默回退到正常登录页，不影响使用。
 */
(function () {
  'use strict';
  var KEY_TOKEN = 'jl_token';
  try {
    // 已有登录态：不重复登录（尊重用户主动选择的账号）
    if (localStorage.getItem(KEY_TOKEN)) return;

    // 同步请求本地自动登录端点（仅回环地址，毫秒级）
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/__local/auto-login', false); // false = 同步，阻塞至返回
    xhr.setRequestHeader('Content-Type', 'application/json');
    xhr.send('{}');
    if (xhr.status < 200 || xhr.status >= 300) return;

    var resp;
    try { resp = JSON.parse(xhr.responseText); } catch (e) { return; }
    if (!resp || resp.code !== 0 || !resp.data || !resp.data.token) return;

    var d = resp.data;
    localStorage.setItem('jl_token', d.token || '');
    localStorage.setItem('jl_username', d.username || '');
    localStorage.setItem('jl_name', (d.name != null && d.name !== '') ? d.name : (d.username || ''));
    localStorage.setItem('jl_role', String(d.roleId != null ? d.roleId : 'null'));
    // 前端约定：isSuper 仅当 role === 'super' 时为真
    localStorage.setItem('jl_super', d.role === 'super' ? '1' : '0');
    localStorage.setItem('jl_menus', JSON.stringify(d.menus || null));
  } catch (e) {
    // 静默失败：保持未登录，前端正常显示登录页
  }
})();
