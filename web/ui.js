const shapes = {
  folder: 'M3 7V5h7l2 3h9v12H3Z',
  home: 'm3 11 9-7 9 7v9h-6v-6H9v6H3Z',
  assets: 'm12 3 9 5-9 5-9-5Zm-9 10 9 5 9-5m-18 5 9 5 9-5',
  outline: 'M4 6h4m3 0h9M4 12h4m3 0h9M4 18h4m3 0h9',
  script: 'M5 3h10l4 4v14H5ZM8 9h7m-7 4h8m-8 4h6',
  image: 'M3 4h18v16H3Zm0 12 5-5 4 4 4-7 5 7M8 8h.1',
  map: 'M2 9h5v6H2Zm14-7h6v6h-6Zm0 14h6v6h-6ZM7 12h4V5h5m-5 7v7h5',
  video: 'M3 5h13v14H3Zm13 5 6-3v10l-6-3',
  cut: 'M3 5h18v14H3Zm5 0v14m8-14v14',
  spark: 'm12 3 2 7 7 2-7 2-2 7-2-7-7-2 7-2Z',
  plus: 'M12 4v16M4 12h16',
  arrow: 'M4 12h15m-6-6 6 6-6 6',
  chev: 'm9 5 7 7-7 7',
  chevd: 'm6 9 6 6 6-6',
  check: 'm4 12 5 5L20 6',
  close: 'M5 5l14 14M19 5 5 19',
  palette: 'M3 5h6v14H3Zm8 0h5v14h-5Zm7 0h3v14h-3',
  clock: 'M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20Zm0 5v6l4 2',
  download: 'M12 3v12m-5-5 5 5 5-5M4 15v6h16v-6',
  upload: 'M12 16V4m-5 5 5-5 5 5M4 16v5h16v-5',
  edit: 'm4 15 12-12 4 4L8 19l-5 2ZM14 5l5 5',
  fx: 'm4 20 11-11 3 3L7 23m8-21v3m5 1 2-1M4 7h4m-2-2v4',
  play: 'M7 4v16l14-8Z',
  library: 'M3 5h4v15H3Zm6 0h4v15H9Zm6 2 4-1 3 13-4 1Z',
  board: 'M2 9h20v12H2ZM2 7l19-5 1 5-19 5Zm4-1 4 3m2-5 4 4',
  search: 'M10 3a7 7 0 1 0 0 14 7 7 0 0 0 0-14Zm5 12 6 6',
  menu: 'M3 5h18M3 12h18M3 19h18',
  share: 'M12 15V3m-5 5 5-5 5 5M4 14v7h16v-7',
  list: 'M4 6h2m3 0h11M4 12h2m3 0h11M4 18h2m3 0h11',
  trash: 'M3 6h18M7 6l1 15h8l1-15M9 6V3h6v3',
  refresh: 'M4 10a8 8 0 1 1 0 6m0-12v6h6',
  up: 'm5 15 7-7 7 7',
  down: 'm5 9 7 7 7-7',
  frame: 'M4 9V4h5m6 0h5v5m0 6v5h-5m-6 0H4v-5',
  sun: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Zm0-6v3m0 14v3M2 12h3m14 0h3',
  cpu: 'M5 5h14v14H5Zm3 3h8v8H8ZM8 2v3m8-3v3M8 19v3m8-3v3M2 8h3m-3 8h3m14-8h3m-3 8h3',
};
export const icon = (k, sz = 18) =>
  '<svg width="' +
  sz +
  '" height="' +
  sz +
  '" aria-hidden="true" class="icon" viewBox="0 0 24 24"><path d="' +
  (shapes[k] || shapes.frame) +
  '"/></svg>';
export const esc = (s) =>
  String(s ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
export const q = (s, e = document) => e.querySelector(s);
export const qa = (s, e = document) => Array.from(e.querySelectorAll(s));
export const makeId = () => crypto.randomUUID();
export const time = (v) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isFinite(d.valueOf())
    ? d.toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
      })
    : '';
};
export const btn = (s, op, k = '', cls = '') =>
  '<button type="button" class="btn ' +
  cls +
  '" data-act="' +
  esc(op) +
  '">' +
  (k ? icon(k, 16) : '') +
  esc(s) +
  '</button>';
export const opt = (v, l, sel) =>
  '<option value="' +
  esc(v) +
  '"' +
  (String(v) === String(sel) ? ' selected' : '') +
  '>' +
  esc(l) +
  '</option>';
export const h2 = (t, e = '') => '<div class="sectionhead"><h2>' + esc(t) + '</h2>' + e + '</div>';
export const h1 = (title, note = '', actions = '') =>
  '<header class="headline"><div><h1>' +
  esc(title) +
  '</h1>' +
  (note ? '<p>' + esc(note) + '</p>' : '') +
  '</div>' +
  actions +
  '</header>';
export const id = encodeURIComponent;
export const stages = [
  ['outline', '大纲', '故事与章节'],
  ['script', '剧本', '场景与分镜'],
  ['image', '插图与修图', '独立创作或配图'],
  ['map', '剧本 Map', '全剧关系图'],
  ['video', '镜头生成', '分章制作'],
  ['cut', '成片剪辑', '跨章编排'],
];
export const shotRows = (p) =>
  (p?.chapters || []).flatMap((c, ci) => (c.shots || []).map((s, si) => ({ c, s, ci, si })));
export const findAsset = (p, a) => (p.assets || []).find((x) => x.id === a);
export const isMovie = (a) => a?.kind === 'video';
export const movieUrl = (a) => a?.playback || a?.src || '';
export const empty = (t, action = '') => '<div class="empty"><p>' + esc(t) + '</p>' + action + '</div>';
export const field = (label, input) =>
  '<label class="field"><span>' + esc(label) + '</span>' + input + '</label>';
export function notice(msg) {
  const n = q('#notice');
  n.textContent = String(msg);
  n.classList.add('on');
  clearTimeout(notice.t);
  notice.t = setTimeout(() => n.classList.remove('on'), 4200);
}
export async function request(path, body, method) {
  const r = await fetch(path, {
    method: method || (body === undefined ? 'GET' : 'POST'),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  });
  let data = {};
  try {
    data = await r.json();
  } catch {}
  if (!r.ok) {
    const error = Error(data.error?.message || data.error || data.message || '服务响应 ' + r.status);
    error.status = r.status;
    throw error;
  }
  return data;
}
export function listen(el, op, fn) {
  el?.querySelector('[data-act="' + op + '"]')?.addEventListener('click', (e) =>
    run(e.currentTarget, fn),
  );
}
export async function run(button, fn) {
  if (button?.disabled) return;
  if (button) button.disabled = true;
  try {
    return await fn();
  } catch (e) {
    const message = e?.message || String(e);
    const open = q('#dialog[open]');
    if (open) {
      let err = q('.dialog-error', open);
      if (!err) {
        err = document.createElement('p');
        err.className = 'dialog-error';
        err.setAttribute('role', 'alert');
        q('.dialogbody', open).append(err);
      }
      err.textContent = message;
    } else notice(message);
  } finally {
    if (button?.isConnected) button.disabled = false;
  }
}
export function dialog(title, content) {
  const d = q('#dialog');
  if (d.open) d.close();
  d.innerHTML =
    '<div class="dialoghead"><h2 id="dialog-title">' +
    esc(title) +
    '</h2><button type="button" data-dismiss aria-label="关闭窗口" class="icobtn">' +
    icon('close') +
    '</button></div><div class="dialogbody">' +
    content +
    '</div>';
  q('[data-dismiss]', d).onclick = () => d.close();
  d.showModal();
  return d;
}
export const saveJSON = (key, value) => {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
};
export const readJSON = (key, fallback) => {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
};
export const kindLabel = (k) =>
  ({
    command: '导演指令',
    agent: '导演 Agent',
    outline: '起草大纲',
    script: '展开剧本',
    image: '生成图片',
    edit: '编辑图片',
    video: '生成镜头',
    export: '导出成片',
  })[k] || k;
export const statusLabel = (s) =>
  ({
    queued: '排队中',
    running: '执行中',
    succeeded: '已完成',
    failed: '失败',
    interrupted: '已中断',
    cancelled: '已取消',
  })[s] || s;
export const fileToData = (f) =>
  new Promise((res, rej) => {
    const r = new FileReader();
    r.onload = () => res(r.result);
    r.onerror = () => rej(Error('文件读取失败'));
    r.readAsDataURL(f);
  });
