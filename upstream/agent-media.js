/**
 * 智能体聊天媒体渲染：把消息里的 [[MEDIA:url|name|img|file]] 变成可点击图片/文件链接。
 * 纯 DOM 增强，不改编译产物。配合 tools/claw-sync.mjs 的媒体同步使用。
 */
(() => {
  if (window.__zdAgentMedia) return;
  window.__zdAgentMedia = true;

  const RX = /\[\[MEDIA:([^|\]]+)\|([^|\]]*)\|(img|file)\]\]/g;

  function render(el) {
    if (!el || el.dataset.zdMedia === '1') return;
    const original = el.textContent || '';
    const hasMedia = original.includes('[[MEDIA:');
    const sm = original.match(/^\[([^\]\n]{1,20})\]\s*/);
    if (!hasMedia && !sm) return;
    el.dataset.zdMedia = '1';
    const frag = document.createDocumentFragment();
    let text = original;
    if (sm) {
      const badge = document.createElement('span');
      badge.textContent = sm[1];
      badge.style.cssText = 'display:inline-block;background:#E8F6EF;color:#1F5E4C;border-radius:999px;padding:0 8px;font-size:11px;font-weight:600;margin-right:6px;vertical-align:middle';
      frag.appendChild(badge);
      text = original.slice(sm[0].length);
    }
    let last = 0;
    let m;
    RX.lastIndex = 0;
    while ((m = RX.exec(text))) {
      if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
      const url = m[1];
      const name = m[2] || '附件';
      const kind = m[3];
      if (kind === 'img') {
        const img = document.createElement('img');
        img.src = url;
        img.alt = name;
        img.title = name + '（点击打开）';
        img.style.cssText = 'max-width:320px;max-height:240px;border-radius:8px;margin:6px 0;display:block;cursor:zoom-in;border:1px solid #E2DFD7;background:#fff';
        img.addEventListener('click', () => window.open(url, '_blank'));
        frag.appendChild(img);
      } else {
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener';
        a.textContent = '📎 ' + name;
        a.style.cssText = 'display:inline-block;margin:4px 0;color:#1F5E4C;text-decoration:underline;font-size:13px';
        frag.appendChild(a);
      }
      last = RX.lastIndex;
    }
    if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
    el.textContent = '';
    el.appendChild(frag);
  }

  function scan() { document.querySelectorAll('.chat-text').forEach(render); }
  setInterval(scan, 1200);
  new MutationObserver(scan).observe(document.body, { childList: true, subtree: true });
})();
