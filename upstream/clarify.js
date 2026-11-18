/* 妆点智能体 · 意图追问 + 全格式附件 + 会话自动命名（前端注入层 v2.2）
 * 不侵入 minified bundle：
 *  - patch fetch 给 /api/agent/chat 声明「本页能渲染选项」，并旁路解析 SSE
 *  - 即使 SSE 旁路失效，也能从消息文本 + REST /clarify/state|last 兜底恢复卡片
 *  - 卡片为 grill-me 式编号选项列表，末项固定「✎ 其他补充…（我自己输入）」
 *  - 上传控件 accept 扩容到表格 / 文档 / PDF / 图片等全部格式
 *  - 接收 event: session_title，实时更新侧栏会话名与顶部「妆点智能体·xxx」
 */
(function () {
  'use strict';

  var VERSION = '2.2';
  var KEY = 'zd_clarify_enabled';
  var enabled = localStorage.getItem(KEY) === '1';
  var pending = null;
  var finalPayload = null;
  var lastSessionId = '';
  var recovering = false;
  var rendered = {};
  var origFetch = window.fetch;
  var lastPrefSync = 0;
  var lastUserToggle = 0;
  var titleOverrides = {};   // session_id -> 最新会话名（列表响应兜底）
  var titleRefined = {};     // session_id -> 是否已请求过 LLM 精修
  var pendingRefine = '';    // 等 done 事件再精修，避免与主对话抢模型连接

  var ACCEPT = [
    '.txt,.text,.log,.csv,.tsv,.md,.markdown,.json,.xml,.html,.htm,.yaml,.yml,.ini,.conf,.sql',
    '.xlsx,.xlsm,.xls,.docx,.docm,.doc,.pptx,.ppt,.odt,.ods,.odp,.epub,.pdf,.rtf',
    '.png,.jpg,.jpeg,.webp,.bmp,.gif,.tif,.tiff,.heic,image/*,application/pdf'
  ].join(',');

  console.info('[clarify] injected v' + VERSION + ' · 选项渲染层已加载');

  /* ---------------- 样式（贴近 grill-me 的编号卡片） ---------------- */
  var css = document.createElement('style');
  css.textContent = [
    '.zd-clarify-card{margin-top:12px;border:1px solid #e6e7eb;background:#fff;border-radius:12px;padding:14px 14px 12px;max-width:620px;box-shadow:0 2px 10px rgba(31,35,41,.05);font-family:inherit}',
    '.zd-clarify-head{display:flex;align-items:center;gap:8px;font-size:11px;color:#8a9099;margin-bottom:10px}',
    '.zd-clarify-head .zd-pager{margin-left:auto;color:#9aa0a6;letter-spacing:.5px}',
    '.zd-clarify-x{margin-left:6px;border:none;background:transparent;color:#9aa0a6;font-size:15px;line-height:1;cursor:pointer;padding:0 2px;font-family:inherit}',
    '.zd-clarify-x:hover{color:#303133}',
    '.zd-clarify-q{font-size:14px;font-weight:600;color:#1f2329;margin:0 0 8px;line-height:1.5}',
    '.zd-clarify-tip{font-size:11px;color:#8a9099;margin:0 0 10px;line-height:1.6}',
    '.zd-opt{display:flex;align-items:flex-start;gap:10px;width:100%;box-sizing:border-box;text-align:left;border:1px solid transparent;border-bottom:1px solid #f0f1f3;background:transparent;border-radius:6px;padding:8px 10px;margin:0;cursor:pointer;transition:background .15s,border-color .15s;font-family:inherit}',
    '.zd-opt:last-of-type{border-bottom:none}',
    '.zd-opt:hover{background:#f6f7f9;border-color:#ececf0}',
    '.zd-opt-num{flex:none;width:18px;color:#9aa0a6;font-size:12px;line-height:20px;text-align:center;font-variant-numeric:tabular-nums}',
    '.zd-opt-main{flex:1;min-width:0}',
    '.zd-opt-label{display:block;color:#303133;font-size:13px;font-weight:500;line-height:20px}',
    '.zd-opt-desc{display:block;color:#9aa0a6;font-size:11px;line-height:1.5;margin-top:1px}',
    '.zd-opt-custom .zd-opt-label{color:#742a54}',
    '.zd-clarify-card.zd-done .zd-opt{opacity:.5;pointer-events:none}',
    '.zd-clarify-card.zd-done .zd-mini{opacity:.5;pointer-events:none}',
    '.zd-clarify-picked{display:none;font-size:12px;color:#742a54;margin-top:8px}',
    '.zd-clarify-card.zd-done .zd-clarify-picked{display:block}',
    '.zd-clarify-foot{display:flex;gap:14px;align-items:center;flex-wrap:wrap;margin-top:10px;border-top:1px solid #f0f1f3;padding-top:9px}',
    '.zd-mini{border:none;background:transparent;color:#8a9099;font-size:11px;cursor:pointer;padding:2px 0;text-decoration:underline;font-family:inherit}',
    '.zd-mini:hover{color:#742a54}',
    '.zd-reopen{display:inline-block;margin-top:8px;border:1px solid #ececf0;background:#fff;color:#742a54;border-radius:6px;padding:5px 10px;font-size:11px;cursor:pointer;font-family:inherit}',
    '.zd-download{display:inline-block;border:none;background:#742a54;color:#fff;border-radius:7px;padding:8px 14px;font-size:12px;cursor:pointer;font-family:inherit}',
    '.zd-download:hover{background:#8f3568}',
    '.zd-clarify-toggle{margin-left:auto;border:1px solid #f0d7e6;background:#fffafc;color:#742a54;border-radius:14px;padding:2px 10px;font-size:11px;cursor:pointer;white-space:nowrap;font-family:inherit}',
    '.zd-clarify-toggle.zd-off{color:#9b7189;background:#fff}'
  ].join('\n');
  (document.head || document.body).appendChild(css);

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined) n.textContent = text;
    return n;
  }

  function authHeaders() {
    var h = { 'Content-Type': 'application/json' };
    var token = sessionStorage.getItem('jl_token');
    if (token) h.Authorization = 'Bearer ' + token;
    var setId = sessionStorage.getItem('jl_set_id');
    if (setId) h['X-Set-Id'] = setId;
    return h;
  }

  function api(method, url, body) {
    return origFetch(url, {
      method: method, headers: authHeaders(),
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) { return r.json(); });
  }

  function apiTimeout(method, url, body, ms) {
    var ctrl = new AbortController();
    var timer = setTimeout(function () { ctrl.abort(); }, ms);
    return origFetch(url, {
      method: method, headers: authHeaders(), signal: ctrl.signal,
      body: body === undefined ? undefined : JSON.stringify(body),
    }).then(function (r) { return r.json(); })
      .finally(function () { clearTimeout(timer); });
  }

  /* ---------------- fetch 拦截 ---------------- */
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : (input && input.url) || '';
    var isChat = url.indexOf('/api/agent/chat') !== -1;
    var isSessions = /\/api\/agent\/sessions(?:\?|$)/.test(url)
      && (!init || !init.method || String(init.method).toUpperCase() === 'GET');
    var opts = init;
    if (isChat && init && typeof init.body === 'string') {
      try {
        var b = JSON.parse(init.body);
        if (b.session_id) lastSessionId = String(b.session_id);
        b.clarify = enabled ? 1 : 0;   // 只有本层存在时才允许后端在聊天窗口反问
        opts = Object.assign({}, init, { body: JSON.stringify(b) });
      } catch (e) { /* 非 JSON 请求体原样透传 */ }
    }
    var p = origFetch.call(this, input, opts);
    // 会话列表响应兜底：即使 Vue 状态尚未刷新，也不会把名字还原成「新对话」
    if (isSessions) return p.then(rewriteSessions).catch(function () { return p; });
    if (!isChat) return p;
    return p.then(function (resp) {
      if (!resp || !resp.ok || !resp.body || typeof resp.body.tee !== 'function') return resp;
      var pair = resp.body.tee();
      readClarify(pair[1]);
      return new Response(pair[0], { status: resp.status, statusText: resp.statusText, headers: resp.headers });
    });
  };

  function rewriteSessions(resp) {
    if (!resp || !resp.ok || typeof resp.clone !== 'function') return resp;
    var copy = resp.clone();
    return copy.json().then(function (j) {
      if (!j || j.code !== 0 || !Array.isArray(j.data)) return resp;
      j.data.forEach(function (s) {
        if (s && s.id && titleOverrides[s.id] && /^(新对话|新会话|未命名|)$/.test(String(s.title || '').trim())) {
          s.title = titleOverrides[s.id];
        }
      });
      var h = new Headers(resp.headers);
      h.delete('content-length');   // 重写后长度可能变化
      return new Response(JSON.stringify(j), { status: resp.status, statusText: resp.statusText, headers: h });
    }).catch(function () { return resp; });
  }

  function readClarify(stream) {
    var reader = stream.getReader();
    var dec = new TextDecoder();
    var buf = '';
    (function pump() {
      reader.read().then(function (r) {
        if (r.done) return;
        buf += dec.decode(r.value, { stream: true });
        var parts = buf.split('\n\n');
        buf = parts.pop();
        for (var i = 0; i < parts.length; i++) handleFrame(parts[i]);
        pump();
      }).catch(function () { try { reader.cancel(); } catch (e) { /* ignore */ } });
    })();
  }

  function handleFrame(frame) {
    var ev = 'message', data = '';
    frame.split('\n').forEach(function (line) {
      if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
      else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
    });
    if (!data) return;
    if (ev === 'session_title') {
      try { onSessionTitle(JSON.parse(data)); } catch (e) { /* 忽略坏帧 */ }
      return;
    }
    if (ev === 'done') { flushTitleRefine(); return; }
    if (ev !== 'clarify') return;
    try { onClarify(JSON.parse(data)); } catch (e) { /* 忽略坏帧 */ }
  }

  /* ---------------- 会话自动命名 ---------------- */
  function onSessionTitle(d) {
    if (!d || !d.session_id || !d.title) return;
    var id = String(d.session_id), title = String(d.title);
    titleOverrides[id] = title;
    if (!titleRefined[id]) pendingRefine = id;
    applySessionTitle(id, title);
  }

  function applySessionTitle(id, title) {
    // 首选：bundle 暴露的响应式状态更新（侧栏 + 顶部标题一起变，且不会被 Vue 重渲染覆盖）
    var ok = false;
    try {
      if (typeof window.__zdApplySessionTitle === 'function') {
        ok = window.__zdApplySessionTitle({ id: id, title: title });
      }
    } catch (e) { /* 继续走 DOM 兜底 */ }
    if (ok) return;
    // 兜底：旧版 bundle 没有钩子时，至少直接把当前会话显示改对；刷新后由后端持久化值兜住
    var act = document.querySelector('.session-item.active .session-title');
    if (act && /^(新对话|新会话|未命名)?$/.test(String(act.textContent || '').trim())) {
      act.textContent = title;
      act.setAttribute('title', title);
    }
    var sub = document.querySelector('.agent-topbar .tb-sub');
    if (sub && /^·\s*(新对话|新会话|未命名)\s*$/.test(String(sub.textContent || ''))) {
      sub.textContent = '· ' + title;
    }
  }

  function flushTitleRefine() {
    var id = pendingRefine;
    pendingRefine = '';
    if (!id || titleRefined[id]) return;
    titleRefined[id] = true;
    // 主对话流结束后才发起精修；模型未配置/失败时后端立即回退本地标题
    apiTimeout('POST', '/api/agent/sessions/' + encodeURIComponent(id) + '/auto-title', {}, 12000)
      .then(function (j) {
        var d = j && j.data;
        if (d && d.title && d.title !== titleOverrides[id]) {
          onSessionTitle({ session_id: id, title: d.title });
        }
      }).catch(function () { /* 精修失败保留本地标题 */ });
  }

  /* ---------------- 事件 -> 卡片 ---------------- */
  function version(p) { return [p.kind, p.anchor, p.step || 0, p.key || ''].join('|'); }
  function anchorOf(node) { return (node.textContent || '').replace(/\s+/g, '').slice(0, 12); }

  function onClarify(p) {
    if (!p || !p.anchor) return;
    if (p.kind === 'ask') {
      pending = p; finalPayload = null; disableCards();
    } else {
      pending = null;
      if (p.kind === 'notice') disableCards();
      if (p.decision === 'disable' || p.prefs_disabled) setEnabled(false, false);
    }
    if (p.kind === 'final') finalPayload = p;
    setTimeout(function () { tryMount(); mountResult(); }, 60);
  }

  function findAnchorBubble(anchor) {
    var list = document.querySelectorAll('.agent-chat .msg.assistant .bubble.assistant');
    for (var i = list.length - 1; i >= 0; i--) {
      if ((list[i].textContent || '').replace(/\s+/g, '').indexOf(anchor) !== -1) return list[i];
    }
    return null;
  }

  function lastClarifyBubble() {
    var list = document.querySelectorAll('.agent-chat .msg.assistant .bubble.assistant');
    for (var i = list.length - 1; i >= 0; i--) {
      if (/【意图追问|【已按你的选择输出】/.test(list[i].textContent || '')) return list[i];
    }
    return null;
  }

  /* SSE 旁路失效时的文本驱动兜底：从 REST 状态 / 最后一次产出恢复卡片 */
  function recoverFromText() {
    if (pending || recovering || !lastSessionId) return;
    var bubble = lastClarifyBubble();
    if (!bubble || bubble.querySelector('.zd-clarify-card') || bubble.dataset.zdRec === '1') return;
    var isFinal = /【已按你的选择输出】/.test(bubble.textContent || '');
    var url = isFinal ? '/api/agent/clarify/last?session_id=' : '/api/agent/clarify/state?session_id=';
    recovering = true;
    api('GET', url + encodeURIComponent(lastSessionId)).then(function (j) {
      var d = j && j.data;
      if (isFinal) {
        var p = d && d.payload;
        if (p && p.kind === 'final') onClarify(p);
        else bubble.dataset.zdRec = '1';
      } else if (d && d.active && d.question) {
        onClarify({
          kind: 'ask', phase: 'recovered', step: d.step, total: d.total,
          question: d.question.title, key: d.question.key, options: d.question.options,
          summary: d.answers, anchor: anchorOf(bubble),
          hint: '点选项即可继续，也可以自己输入；最后一项可自由填写',
        });
      } else bubble.dataset.zdRec = '1';
    }).catch(function () { /* 静默，等下次 tick */ })
      .then(function () { recovering = false; });
  }

  function tryMount() {
    mountToggle();
    if (!pending) { recoverFromText(); return; }
    var bubble = findAnchorBubble(pending.anchor);
    if (!bubble) return;
    var v = version(pending);
    if (rendered[pending.anchor] === v && bubble.querySelector('.zd-clarify-card')) return;
    renderAskCard(bubble, pending);
    rendered[pending.anchor] = v;
  }

  function renderAskCard(bubble, p) {
    var old = bubble.querySelector('.zd-clarify-card');
    if (old) old.remove();
    var card = el('div', 'zd-clarify-card zd-ask-card');
    card.dataset.zdv = version(p);

    var head = el('div', 'zd-clarify-head');
    head.appendChild(el('span', '', '🔍 意图追问'));
    head.appendChild(el('span', 'zd-pager', '‹ ' + (p.step || 1) + '/' + (p.total || 1) + ' ›'));
    var x = el('button', 'zd-clarify-x', '×');
    x.type = 'button';
    x.title = '收起选项卡（仍可直接输入答案）';
    x.onclick = function () { collapse(card, bubble, p); };
    head.appendChild(x);
    card.appendChild(head);
    card.appendChild(el('div', 'zd-clarify-q', p.question || '请确认一下需求'));
    card.appendChild(el('div', 'zd-clarify-tip', p.hint || '点选项即可继续，也可以自己输入；看不到卡片请按 Ctrl+R 刷新'));

    (p.options || []).forEach(function (o, i) {
      var btn = el('button', 'zd-opt' + (o.custom ? ' zd-opt-custom' : ''));
      btn.type = 'button';
      btn.appendChild(el('span', 'zd-opt-num', o.custom ? '✎' : String(i + 1)));
      var main = el('span', 'zd-opt-main');
      main.appendChild(el('span', 'zd-opt-label', String(o.label || '').replace(/^✎\s*/, '')));
      if (o.desc) main.appendChild(el('span', 'zd-opt-desc', o.desc));
      btn.appendChild(main);
      btn.onclick = function () {
        if (o.custom) focusInput(o, card);
        else choose(o.value, o.label, card);
      };
      card.appendChild(btn);
    });

    card.appendChild(el('div', 'zd-clarify-picked'));
    var foot = el('div', 'zd-clarify-foot');
    var skip = el('button', 'zd-mini', '跳过追问，按默认直接给');
    skip.type = 'button';
    skip.onclick = function () { choose('__skip__', '跳过追问', card); };
    foot.appendChild(skip);
    var off = el('button', 'zd-mini', '不用反问了（关闭追问）');
    off.type = 'button';
    off.onclick = function () { setEnabled(false, false); choose('__skip__', '不用反问了', card); };
    foot.appendChild(off);
    card.appendChild(foot);
    bubble.appendChild(card);
  }

  function collapse(card, bubble) {
    card.remove();
    var btn = el('button', 'zd-reopen', '🔍 重新显示选项');
    btn.type = 'button';
    btn.onclick = function () { btn.remove(); rendered = {}; tryMount(); };
    bubble.appendChild(btn);
  }

  function focusInput(o, card) {
    var ta = document.querySelector('.agent-chat textarea');
    if (ta) {
      ta.focus();
      ta.placeholder = o.value === 'custom'
        ? '输入期间，例如 2026-09，然后点「发送」'
        : '直接写出你的要求，然后点「发送」（也可以输入序号 1/2/3）';
    }
    var tip = card.querySelector('.zd-clarify-tip');
    if (tip) tip.textContent = '✎ 已切换到自主输入：在下方输入框写完点「发送」即可；也可以继续点其它选项。';
  }

  function choose(value, label, card) {
    if (card) {
      card.classList.add('zd-done');
      var picked = card.querySelector('.zd-clarify-picked');
      if (picked) picked.textContent = '✓ 已选择：' + label;
    }
    sendText('【澄清选择】' + value + '｜' + label);
  }

  function disableCards() {
    var cards = document.querySelectorAll('.zd-clarify-card.zd-ask-card');
    for (var i = 0; i < cards.length; i++) cards[i].classList.add('zd-done');
  }

  /* ---------------- 复用 SPA 原生发送 ---------------- */
  function sendText(text) {
    var ta = document.querySelector('.agent-chat textarea');
    if (!ta) return false;
    var setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
    setter.call(ta, text);
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    setTimeout(function () {
      var btns = document.querySelectorAll('.agent-chat .input-actions button');
      for (var i = 0; i < btns.length; i++) {
        if ((btns[i].textContent || '').indexOf('发送') !== -1 && !btns[i].disabled) {
          btns[i].click(); return;
        }
      }
      ta.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    }, 40);
    return true;
  }

  /* ---------------- 结果卡片 / 下载 ---------------- */
  function mountResult() {
    if (!finalPayload) return;
    var p = finalPayload;
    var bubble = findAnchorBubble(p.anchor);
    if (!bubble) return;
    if (bubble.querySelector('.zd-result-card')) return;
    var card = el('div', 'zd-clarify-card zd-result-card');
    card.appendChild(el('div', 'zd-clarify-q', '✅ 已按你的选择生成结果'));
    if (p.spec) {
      card.appendChild(el('div', 'zd-clarify-tip',
        '需求：' + (p.spec.intentLabel || '') + ' · 形式：' + (p.spec.output || '') +
        ' · 期间：' + (p.spec.period || '') + ' · 格式：' + (p.spec.format || '')));
    }
    if (p.download && p.download.url) {
      var btn = el('button', 'zd-download', '⬇ 下载 ' + p.download.filename);
      btn.type = 'button';
      btn.onclick = function () { downloadFile(p.download.url, p.download.filename); };
      card.appendChild(btn);
      if (p.download.degraded) card.appendChild(el('div', 'zd-clarify-tip', p.download.degraded));
    }
    var foot = el('div', 'zd-clarify-foot');
    var again = el('button', 'zd-mini', '再追问一次（重新确认需求）');
    again.type = 'button';
    again.onclick = function () { sendText('请追问我，重新确认需求'); };
    foot.appendChild(again);
    card.appendChild(foot);
    bubble.appendChild(card);
  }

  function downloadFile(url, filename) {
    var headers = {};
    var token = sessionStorage.getItem('jl_token');
    if (token) headers.Authorization = 'Bearer ' + token;
    var setId = sessionStorage.getItem('jl_set_id');
    if (setId) headers['X-Set-Id'] = setId;
    origFetch(url, { headers: headers }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = filename || 'report';
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    }).catch(function (e) { console.warn('[clarify] 下载失败', e); });
  }

  /* ---------------- 开关（与后端偏好同步） ---------------- */
  function setEnabled(v, sync) {
    enabled = Boolean(v);
    localStorage.setItem(KEY, enabled ? '1' : '0');
    if (sync !== false) {
      lastUserToggle = Date.now();
      api('POST', '/api/agent/clarify/prefs', { enabled: enabled, scope: 'global' }).catch(function () {});
    }
    mountToggle();
  }

  function syncPrefs(force) {
    var t = Date.now();
    if (!force && t - lastPrefSync < 15000) return;
    lastPrefSync = t;
    api('GET', '/api/agent/clarify/prefs').then(function (j) {
      var d = j && j.data;
      if (!d || typeof d.global !== 'boolean') return;
      // 用户刚手动切换过：POST 可能还在路上，别用旧快照把界面改回去
      if (t - lastUserToggle < 5000) { mountToggle(); return; }
      // 后端全局偏好是唯一权威。旧逻辑只在 localStorage 无记录时才同步，
      // 会留下「后端=开、界面=关、反问实际被禁用」的不一致状态。
      if (d.global !== enabled) setEnabled(d.global, false);
      else mountToggle();
    }).catch(function () {});
  }

  function mountToggle() {
    var bar = document.querySelector('.agent-chat .skills-bar');
    if (!bar) return;
    var btn = bar.querySelector('.zd-clarify-toggle');
    if (!btn) {
      btn = el('button', 'zd-clarify-toggle');
      btn.type = 'button';
      btn.onclick = function () { setEnabled(!enabled, true); };
      bar.appendChild(btn);
    }
    btn.textContent = enabled ? '🔍 意图追问：开（逐步反问）' : '🔍 意图追问：关';
    btn.title = '注入层 v' + VERSION + ' · ' + (enabled
      ? '开启后，对模糊的报表/数据需求会逐步反问并给出可点击选项；说「不用反问了」可永久关闭'
      : '关闭后所有问题直接交给模型回答；说「开启追问」可恢复');
    btn.classList.toggle('zd-off', !enabled);
  }

  /* ---------------- 上传控件扩容 ---------------- */
  function patchUpload() {
    var inputs = document.querySelectorAll('.agent-chat input[type=file]');
    for (var i = 0; i < inputs.length; i++) {
      if (inputs[i].dataset.zdAccept !== VERSION) {
        inputs[i].setAttribute('accept', ACCEPT);
        inputs[i].dataset.zdAccept = VERSION;
      }
    }
    var btns = document.querySelectorAll('.agent-chat button');
    for (var j = 0; j < btns.length; j++) {
      if (/附件\s*图片\/PDF/.test(btns[j].textContent || '')) btns[j].textContent = '附件 任意格式';
    }
    var ta = document.querySelector('.agent-chat textarea');
    if (ta && /可上传图片\/PDF/.test(ta.placeholder || '')) {
      ta.placeholder = '问我账务问题，可上传任意格式文件（表格 / 文档 / PDF / 图片）';
    }
    var hints = document.querySelectorAll('.agent-chat .hint');
    for (var k = 0; k < hints.length; k++) {
      if (/附件会先识别文字/.test(hints[k].textContent || '')) {
        hints[k].textContent = 'Enter 发送 · Shift+Enter 换行 · 附件自动解析为文字/表格后交给 AI';
      }
    }
  }

  /* ---------------- DOM 观察 ---------------- */
  var ticking = false;
  new MutationObserver(function () {
    if (ticking) return;
    ticking = true;
    setTimeout(function () {
      ticking = false;
      mountToggle();
      tryMount();
      mountResult();
      patchUpload();
      syncPrefs(false);
    }, 30);
  }).observe(document.body, { childList: true, subtree: true, characterData: true });

  setInterval(function () { tryMount(); mountResult(); patchUpload(); }, 1200);
  syncPrefs(true);
})();
