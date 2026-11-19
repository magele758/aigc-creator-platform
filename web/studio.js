import {
  esc,
  q,
  qa,
  id,
  icon,
  btn,
  opt,
  h1,
  h2,
  stages,
  empty,
  field,
  notice,
  request,
  listen,
  dialog,
  saveJSON,
  readJSON,
  kindLabel,
  statusLabel,
  fileToData,
  time,
  run,
} from './ui.js';
import { renderWriter, renderAssets, renderCut, renderMap } from './workspace.js';
import { renderMedia } from './media.js';
const state = {
  projects: [],
  project: null,
  jobs: [],
  route: {},
};
const themes = { classic: '叠映经典', field: 'Higgsfield · 荧光', cinema: 'Cinema · 红黑' };
const names = Object.fromEntries([
  ...stages.map(([s, n]) => [s, n]),
  ['assets', '资源与共享'],
  ['home', '项目目录'],
  ['overview', '项目总览'],
  ['jobs', '制作任务'],
]);
const stageNames = new Set(Object.keys(names));
let navigation = 0,
  busyPoll = false,
  cleanup;
function currentRoute() {
  const [path, query] = location.hash.replace(/^#\/?/, '').split('?'),
    bits = path.split('/');
  let route =
    bits[0] === 'p'
      ? { projectId: decodeURIComponent(bits[1] || ''), page: bits[2] || 'overview' }
      : { page: bits[0] || 'home' };
  if (!stageNames.has(route.page)) route = { page: 'home' };
  for (const [k, v] of new URLSearchParams(query)) {
    if (['shot', 'chapter', 'result', 'main', 'job'].includes(k)) route[k] = v;
  }
  return route;
}
function go(page, projectId, params = {}) {
  const query = new URLSearchParams(Object.entries(params).filter(([, v]) => v));
  const dest =
    '#/' + (projectId ? 'p/' + id(projectId) + '/' : '') + page + (query.size ? '?' + query : '');
  if (location.hash === dest) {
    load();
    return;
  }
  location.hash = dest;
}
function activeProject() {
  return state.projects.some((p) => p.id === state.route.projectId)
    ? state.route.projectId
    : state.projects.find((p) => p.id === readJSON('cine.project', ''))?.id || state.projects[0]?.id;
}
async function refreshProjects() {
  state.projects = (await request('/api/projects?summary=1')).projects || [];
}
function globalHead() {
  const rail = q('#rail'),
    r = state.route,
    p = state.project,
    current = activeProject(),
    selected = state.projects.find((x) => x.id === current),
    activeJobs = state.jobs.filter((j) => ['running', 'queued'].includes(j.status));
  rail.innerHTML =
    '<div class="railhead"><button class="brand" data-nav="home" aria-label="叠映项目目录"><span class="mark" aria-hidden="true"><i></i><i></i><i></i></span><b>叠映</b><em>CINE</em></button><button id="mobile-menu" class="icobtn" aria-label="展开导航" aria-expanded="false">' +
    icon('menu') +
    '</button></div><div class="railbody"><nav class="rprimary">' +
    [
      ['home', 'folder', '项目目录'],
      ['assets', 'library', '资源与共享'],
      ['jobs', 'clock', '制作任务'],
    ]
      .map(
        ([s, k, l]) =>
          '<button class="rnav ' +
          (r.page === s ? 'sel' : '') +
          '" data-nav="' +
          s +
          '">' +
          icon(k) +
          '<span>' +
          l +
          '</span>' +
          (s === 'jobs' && activeJobs.length ? '<small>' + activeJobs.length + '</small>' : '') +
          '</button>',
      )
      .join('') +
    '</nav><div class="railrule"></div><div class="rail-label">当前项目</div><button class="rnav ' +
    (r.page === 'overview' ? 'sel' : '') +
    '" data-nav="overview">' +
    icon('folder') +
    '<b>' +
    esc(selected?.name || '选择项目') +
    '</b>' +
    icon('chevd', 13) +
    '</button><div class="rail-label">制作流程</div><nav>' +
    stages
      .map(
        ([s, l], i) =>
          '<button class="rnav ' +
          (r.page === s ? 'sel' : '') +
          '" data-nav="' +
          s +
          '"><span class="stepno">0' +
          (i + 1) +
          '</span>' +
          l +
          '</button>',
      )
      .join('') +
    '</nav></div><div class="railfoot">' +
    icon('cpu', 21) +
    '<div>本地制作工作室<small>私有模型与项目素材</small></div></div>';
  const top = q('#top');
  top.innerHTML =
    '<div class="crumb"><button data-nav="home">工作室</button>' +
    icon('chev', 12) +
    (p && r.page !== 'home'
      ? '<button data-nav="overview">' + esc(p.name) + '</button>' + icon('chev', 12)
      : '') +
    '<b>' +
    esc(names[r.page]) +
    '</b></div><div class="topops"><button type="button" class="btn thematic" id="theme-button">' +
    icon('palette', 16) +
    '<span>主题</span></button>' +
    btn('导演 Agent', 'agent', 'spark', 'primary') +
    '</div>';
  for (const el of [rail, top])
    qa('[data-nav]', el).forEach(
      (x) =>
        (x.onclick = () => {
          const s = x.dataset.nav;
          if (s === 'home' || s === 'jobs') {
            go(s);
            return;
          }
          if (s === 'overview' && !p && state.projects.length > 1) {
            choose(s);
            return;
          }
          if (current) go(s, current);
          else choose(s);
        }),
    );
  q('#mobile-menu').onclick = (e) => {
    const is = rail.classList.toggle('expanded');
    e.currentTarget.setAttribute('aria-expanded', is);
  };
  q('#theme-button').onclick = () => {
    const d = dialog(
      '工作台主题',
      '<div class="theme-list">' +
        Object.entries(themes)
          .map(
            ([k, v]) =>
              '<button data-theme-choice="' +
              k +
              '" aria-pressed="' +
              (document.documentElement.dataset.theme === k) +
              '"><i class="themechip t-' +
              k +
              '"></i>' +
              esc(v) +
              (document.documentElement.dataset.theme === k ? icon('check') : '') +
              '</button>',
          )
          .join('') +
        '</div>',
    );
    qa('[data-theme-choice]', d).forEach(
      (b) =>
        (b.onclick = () => {
          document.documentElement.dataset.theme = b.dataset.themeChoice;
          try {
            localStorage.setItem('cine.appearance', b.dataset.themeChoice);
          } catch {}
          d.close();
        }),
    );
  };
  listen(top, 'agent', () => director(p?.id));
}
function makeFlow() {
  return (
    '<div class="workflow">' +
    stages
      .map(
        ([k, l, n], i) =>
          '<button data-stage="' +
          k +
          '"><span>' +
          icon(k) +
          '<small>0' +
          (i + 1) +
          '</small></span><b>' +
          l +
          '</b><em>' +
          n +
          '</em></button>',
      )
      .join('') +
    '</div>'
  );
}
function mediaCover(p) {
  return (
    p.cover ||
    p.coverUrl ||
    p.thumbnail ||
    p.assets?.find((x) => x.kind === 'image' && !['mask', 'input-mask'].includes(x.role))?.src ||
    p.assets?.find((x) => x.poster)?.poster ||
    ''
  );
}
function projectCard(p) {
  const cover = mediaCover(p);
  return (
    '<button class="projectCard" data-project="' +
    esc(p.id) +
    '">' +
    (cover
      ? '<img src="' + esc(cover) + '" alt="" loading="lazy">'
      : '<span class="cover-empty">' + icon('board', 36) + '</span>') +
    '<span><strong>' +
    esc(p.name) +
    '</strong><small>' +
    esc(p.brief || '打开项目工作区') +
    '</small></span>' +
    icon('chev', 16) +
    '</button>'
  );
}
function home(el) {
  const p = state.projects.find((x) => x.id === activeProject()) || state.projects[0],
    c = p && mediaCover(p);
  el.innerHTML =
    h1(
      '项目目录',
      state.projects.length + ' 个项目 · 剧本、镜头与素材按项目归档',
      btn('新建项目', 'new', 'plus', 'primary'),
    ) +
    '<div class="featured"><div class="hero-main"><div class="hero-bg" aria-hidden="true">' +
    (c ? '<img src="' + esc(c) + '" alt="">' : '<div class="shutter"></div>') +
    '</div><div class="hero-copy"><div class="hero-icon">' +
    icon('board', 25) +
    '</div><h2>' +
    (p ? esc(p.name) : '从剧本到成片') +
    '</h2><p>' +
    esc(p ? p.brief || '继续编写、制图和制作镜头。' : '写下创作简报，由导演 Agent 完成整部短片。') +
    '</p>' +
    btn(p ? '打开项目' : '委托导演 Agent', 'featured', p ? 'arrow' : 'spark', 'heroBtn') +
    '</div></div><div class="quick-column"><button data-quick="image">' +
    icon('image', 21) +
    '<span><b>独立生图与修图</b><small>从文字、主图或参考图开始。</small></span>' +
    icon('arrow', 17) +
    '</button><button data-quick="video">' +
    icon('video', 21) +
    '<span><b>生成单个镜头</b><small>试拍后可加入剪辑时间线。</small></span>' +
    icon('arrow', 17) +
    '</button></div></div>' +
    h2('制作流程') +
    makeFlow() +
    h2(
      '我的项目',
      state.projects.length > 2
        ? '<input class="search" id="filter" aria-label="搜索项目" placeholder="搜索项目">'
        : '',
    ) +
    '<div class="project-list" id="project-list"></div>';
  const list = q('#project-list', el);
  function cards(term = '') {
    const found = state.projects.filter((p) => (p.name || '').includes(term));
    list.innerHTML = found.length
      ? found.map(projectCard).join('')
      : empty(term ? '没有匹配的项目。' : '创建第一个项目，或直接委托导演 Agent。');
    qa('[data-project]', list).forEach((b) => (b.onclick = () => go('overview', b.dataset.project)));
  }
  cards();
  q('#filter', el)?.addEventListener('input', (e) => cards(e.target.value));
  listen(el, 'new', () => newProject());
  listen(el, 'featured', () => (p ? go('overview', p.id) : director()));
  qa('[data-stage]', el).forEach((b) => (b.onclick = () => choose(b.dataset.stage)));
  qa('[data-quick]', el).forEach((b) => (b.onclick = () => choose(b.dataset.quick)));
}
function choose(stage) {
  if (!state.projects.length) {
    newProject(stage);
    return;
  }
  const d = dialog(
    '选择工作项目',
    field(
      '项目归属',
      '<select id="choose-project">' +
        state.projects.map((p) => opt(p.id, p.name, activeProject())).join('') +
        '</select>',
    ) +
      '<div class="actions">' +
      btn('进入工作区', 'open', 'arrow', 'primary') +
      btn('新建项目', 'create', 'plus') +
      '</div>',
  );
  listen(d, 'create', () => newProject(stage));
  listen(d, 'open', () => {
    const k = q('#choose-project', d).value;
    d.close();
    go(stage, k);
  });
}
function newProject(stage = 'overview') {
  const d = dialog(
    '新建项目',
    '<form id="newproject">' +
      field(
        '项目名称',
        '<input id="pname" maxlength="100" required autofocus placeholder="例如，雾中的邮局">',
      ) +
      field(
        '创作简报',
        '<textarea id="pbrief" rows="4" placeholder="主题、人物、地点或创作方向"></textarea>',
      ) +
      '<div class="actions"><button class="btn primary">创建项目</button></div></form>',
  );
  q('form', d).onsubmit = (e) => {
    e.preventDefault();
    run(q('[type=submit]', d) || q('.primary', d), async () => {
      const { project } = await request('/api/projects', {
        name: q('#pname').value.trim(),
        brief: q('#pbrief').value.trim(),
      });
      await refreshProjects();
      d.close();
      go(stage, project.id);
    });
  };
}
function director(pid) {
  const selection = pid && window.cineSelectedMedia?.projectId === pid ? window.cineSelectedMedia : null;
  const d = dialog(
    '导演 Agent',
    '<form id="director">' +
      field(
        '作用项目',
        '<select id="agent-project">' +
          opt('', '新建独立项目', pid || '') +
          state.projects.map((p) => opt(p.id, p.name, pid)).join('') +
          '</select>',
      ) +
      field(
        '委托方式',
        '<select id="agent-mode"><option value="command">操作当前项目</option><option value="agent">从剧本制作成片</option></select>',
      ) +
      field('新项目名称', '<input id="agent-name" maxlength="100" placeholder="由导演命名">') +
      field(
        '制作委托',
        '<textarea id="agent-brief" rows="5" required placeholder="例如，把第二章镜头移到开头并导出，或为当前项目独立生成一张图。"></textarea>',
      ) +
      field('章节数', '<input id="agent-count" type="number" min="1" max="12" value="2">') +
      '<label class="include-selection" hidden><input id="agent-context" type="checkbox" checked> 使用当前工作区选中的素材与镜头</label><p id="agent-hint" class="hint"></p><div class="actions"><button class="btn primary">' +
      icon('spark', 16) +
      '开始制作</button></div></form>',
  );
  const sel = q('#agent-project', d),
    mode = q('#agent-mode', d),
    name = q('#agent-name', d),
    brief = q('#agent-brief', d),
    count = q('#agent-count', d),
    use = q('#agent-context', d),
    hint = q('#agent-hint', d);
  const update = () => {
    name.closest('label').hidden = !!sel.value;
    mode.closest('label').hidden = !sel.value;
    const k = sel.value ? mode.value : 'agent';
    count.closest('label').hidden = k !== 'agent';
    use.closest('label').hidden =
      k !== 'command' || pid !== sel.value || !(selection || state.route.shot);
    hint.textContent =
      k === 'command'
        ? '导演会依据指令调用项目编辑、模型生成与交付操作。'
        : '导演会按简报规划章节，依次制作剧本、插图、视频与成片。';
  };
  mode.value = pid ? 'command' : 'agent';
  sel.onchange = () => {
    mode.value = sel.value ? 'command' : 'agent';
    update();
  };
  mode.onchange = update;
  update();
  q('form', d).onsubmit = (e) => {
    e.preventDefault();
    run(q('.primary', d), async () => {
      const projectId = sel.value,
        pr = brief.value.trim(),
        kind = projectId ? mode.value : 'agent';
      if (!pr) throw Error('请写下制作委托');
      const attachments =
        kind === 'command' && !use.closest('label').hidden && use.checked
          ? {
              ...(state.route.shot ? { shotId: state.route.shot } : {}),
              ...(selection ? await selection.inputs() : {}),
            }
          : {};
      const job = await submit({
        kind,
        ...(projectId ? { projectId } : {}),
        ...(kind === 'agent'
          ? { name: name.value.trim() || undefined, brief: pr, chapters: +count.value }
          : {}),
        prompt: pr,
        ...attachments,
      });
      d.close();
      go('jobs', null, { job: job.id });
    });
  };
}
async function submit(body) {
  // Retain the same request ID until an acknowledgement arrives. If the worker started
  // but the connection dropped, retrying the form retrieves the already-created job.
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(body)));
  const pending =
    'cine.pending.' +
    Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
  let requestId = crypto.randomUUID();
  try {
    requestId = sessionStorage.getItem(pending) || requestId;
    sessionStorage.setItem(pending, requestId);
  } catch {
    /* The service still receives a request ID when browser storage is unavailable. */
  }
  const { job } = await request('/api/jobs', { ...body, idempotencyKey: requestId });
  try {
    sessionStorage.removeItem(pending);
  } catch {
    /* Session storage is optional. */
  }
  state.jobs = [job, ...state.jobs.filter((j) => j.id !== job.id)];
  globalHead();
  updateActivity();
  notice('任务已提交，可离开本页继续工作');
  return job;
}
async function patch(body) {
  const p = state.project;
  if (!p) throw Error('请先选择项目');
  const { project } = await request(
    '/api/projects/' + id(p.id),
    { ...body, expectedRevision: p.revision },
    'PATCH',
  );
  if (state.project?.id === p.id) state.project = project;
  return project;
}
async function upload(file, label, role) {
  const p = state.project;
  if (!p) throw Error('请先选择项目');
  const dataUrl = typeof file === 'string' ? file : await fileToData(file);
  const { asset, project } = await request('/api/projects/' + id(p.id) + '/assets', {
    title: label || file.name,
    dataUrl,
    ...(role === 'mask' ? { role } : {}),
  });
  if (state.project?.id === p.id) {
    if (project) state.project = project;
    else state.project = (await request('/api/projects/' + id(p.id))).project;
  }
  return asset;
}
function stageText(event) {
  if (typeof event === 'string') event = { stage: event };
  const key = event.stage || event.type;
  const action = {
    'project.created': '已创建项目',
    'outline.saved': '大纲已保存',
    'script.saved': '剧本已保存',
    'map.ready': '剧本 Map 已建立',
    'illustration.requested': '开始生成插图',
    'illustration.saved': '插图已归档',
    'video.requested': '开始生成镜头',
    'video.saved': '视频已归档',
    'cut.saved': '时间线已保存',
    'command.applying': '导演正在执行操作',
    'media.running': '模型执行中',
    'worker.progress': '模型进度',
    'export.running': '正在合成影片',
    complete: '制作完成',
    queued: '已加入队列',
    failed: '制作失败',
  };
  const parts = String(key || '').split('.');
  const phases = { directing: '正在规划', accepted: '已采纳模型指令' };
  const stage = action[key] || (phases[parts[1]] ? phases[parts[1]] : key);
  const detail = [
    event.title || event.name,
    event.chapters != null ? event.chapters + ' 章' : null,
    event.shots != null ? event.shots + ' 镜' : null,
    event.seconds != null ? Number(event.seconds).toFixed(1) + ' 秒' : null,
  ].filter(Boolean);
  return (
    event.message ||
    event.text ||
    event.label ||
    [stage, ...detail].filter(Boolean).join(' · ') ||
    '等待执行'
  );
}
function jobs(el) {
  const all = state.jobs,
    sel = all.find((j) => j.id === state.route.job) || all[0];
  el.innerHTML =
    h1('制作任务', '跟踪导演、模型和导出的实际运行记录。', btn('刷新', 'refresh', 'refresh')) +
    (all.length
      ? '<div class="jobsgrid"><div class="joblist">' +
        all
          .map(
            (j) =>
              '<button data-job="' +
              esc(j.id) +
              '" class="' +
              (j === sel ? 'current' : '') +
              '"><span>' +
              icon(j.kind === 'agent' ? 'spark' : 'clock', 16) +
              '<b>' +
              esc(kindLabel(j.kind)) +
              '</b></span><span class="tag ' +
              esc(j.status) +
              '">' +
              esc(statusLabel(j.status)) +
              '</span><small>' +
              esc(time(j.createdAt) || j.id.slice(0, 8)) +
              '</small></button>',
          )
          .join('') +
        '</div><article class="panel logpanel" id="job-detail"></article></div>'
      : empty('这里会显示你提交的制作任务。', btn('委托导演', 'director', 'spark', 'primary')));
  listen(el, 'director', () => director());
  listen(el, 'refresh', () => load());
  qa('[data-job]', el).forEach((b) => (b.onclick = () => go('jobs', null, { job: b.dataset.job })));
  if (sel) {
    const detail = q('#job-detail', el);
    const events = (sel.events || []).slice(-35);
    const metric = sel.metrics || {};
    const error = sel.error?.message || sel.error;
    const dest = sel.result?.deliveryUrl;
    detail.innerHTML =
      '<div class="sectionhead"><h2>' +
      esc(kindLabel(sel.kind)) +
      '</h2><span class="tag ' +
      esc(sel.status) +
      '">' +
      esc(statusLabel(sel.status)) +
      '</span></div><p>' +
      esc(stageText(sel.stage || '等待工作线程')) +
      '</p>' +
      (error
        ? '<p class="error" role="alert">' +
          esc(typeof error === 'string' ? error : JSON.stringify(error)) +
          '</p>'
        : '') +
      (sel.result?.summary ? '<p class="agent-summary">' + esc(sel.result.summary) + '</p>' : '') +
      (events.length
        ? '<ol class="events">' +
          events
            .map(
              (ev) =>
                '<li><time>' +
                esc(time(ev.at || ev.time || ev.ts || ev.createdAt)) +
                '</time>' +
                esc(stageText(ev)) +
                '</li>',
            )
            .join('') +
          '</ol>'
        : '') +
      (Object.keys(metric).length
        ? '<details><summary>运行指标</summary><pre>' +
          esc(JSON.stringify(metric, null, 2)) +
          '</pre></details>'
        : '') +
      '<div class="actions">' +
      (sel.projectId ? btn('打开所属项目', 'project', 'folder') : '') +
      (sel.status === 'succeeded' && sel.projectId && sel.result?.assetId
        ? btn('查看产物', 'result', 'image', 'primary')
        : '') +
      (['failed', 'interrupted'].includes(sel.status) ? btn('从断点重试', 'retry', 'refresh') : '') +
      (dest
        ? '<a class="btn primary" href="' +
          esc(dest) +
          '?download=1" download>' +
          icon('download', 16) +
          '下载成片</a>'
        : '') +
      '</div>';
    listen(detail, 'retry', async () => {
      await request('/api/jobs/' + id(sel.id) + '/retry', {});
      await load();
    });
    listen(detail, 'project', () => go('overview', sel.projectId));
    listen(detail, 'result', async () => {
      const pid = sel.projectId,
        assetId = sel.result.assetId;
      const { project } = await request('/api/projects/' + id(pid));
      const a = project.assets.find((x) => x.id === assetId);
      if (!a) throw Error('产物已失去授权或已归档');
      go(a.role === 'delivery' ? 'cut' : a.kind === 'video' ? 'video' : 'image', pid, {
        result: assetId,
      });
    });
  }
}
function updateActivity() {
  const bar = q('#activity');
  if (!bar) return;
  const recent = state.jobs.find((j) => j.projectId === state.route.projectId);
  if (!recent) {
    bar.innerHTML = '';
    return;
  }
  bar.innerHTML =
    '<button class="activity-row" data-status="' +
    esc(recent.status) +
    '"><span class="statusdot"></span><b>' +
    esc(kindLabel(recent.kind)) +
    '</b><span>' +
    esc(statusLabel(recent.status)) +
    ' · ' +
    esc(stageText(recent.stage || '任务详情')) +
    '</span>' +
    icon('arrow', 15) +
    '</button>';
  q('button', bar).onclick = () => go('jobs', null, { job: recent.id });
}
async function load() {
  const ticket = ++navigation;
  const route = currentRoute();
  state.route = route;
  cleanup?.();
  cleanup = null;
  window.cineSelectedMedia = null;
  const el = q('#content');
  el.dataset.dirty = '';
  try {
    const [list, all, one] = await Promise.all([
      request('/api/projects?summary=1'),
      request('/api/jobs?summary=1'),
      route.projectId
        ? request('/api/projects/' + id(route.projectId))
        : Promise.resolve({ project: null }),
    ]);
    if (ticket !== navigation) return;
    let currentJobs = all.jobs || [];
    if (route.page === 'jobs' && (route.job || currentJobs.length)) {
      const jid = route.job || currentJobs[0].id;
      const detail = (await request('/api/jobs/' + id(jid))).job;
      if (ticket !== navigation) return;
      currentJobs = currentJobs.some((j) => j.id === jid)
        ? currentJobs.map((j) => (j.id === jid ? detail : j))
        : [detail, ...currentJobs];
    }
    state.projects = list.projects || [];
    state.jobs = currentJobs;
    state.project = one.project;
    if (route.projectId) saveJSON('cine.project', route.projectId);
    globalHead();
    el.innerHTML =
      '<div class="page" id="screen"></div>' +
      (route.projectId ? '<div id="activity" class="activity"></div>' : '');
    const screen = q('#screen');
    const ctx = {
      p: state.project,
      route,
      projects: state.projects,
      jobs: state.jobs,
      go,
      patch,
      submit,
      upload,
      load,
      director,
      project: () => state.project,
    };
    if (route.page === 'home') home(screen);
    else if (route.page === 'jobs') jobs(screen);
    else if (!state.project) choose(route.page);
    else
      switch (route.page) {
        case 'overview':
          overview(screen, state.project);
          break;
        case 'outline':
        case 'script':
          renderWriter(screen, ctx);
          break;
        case 'assets':
          renderAssets(screen, ctx);
          break;
        case 'image':
        case 'video':
          cleanup = renderMedia(screen, ctx);
          break;
        case 'map':
          cleanup = renderMap(screen, ctx);
          break;
        case 'cut':
          renderCut(screen, ctx);
          break;
      }
    updateActivity();
  } catch (e) {
    if (ticket !== navigation) return;
    globalHead();
    el.innerHTML =
      '<section class="page">' +
      h1('无法打开工作区') +
      empty(e.message, btn('重新连接', 'retry', 'refresh') + ' ' + btn('返回目录', 'home', 'folder')) +
      '</section>';
    listen(el, 'retry', load);
    listen(el, 'home', () => go('home'));
  }
}
async function poll() {
  if (busyPoll || document.hidden) return;
  const wasRoute = state.route,
    active = state.jobs.some((j) => ['running', 'queued'].includes(j.status));
  if (!active && wasRoute.page !== 'jobs') return;
  busyPoll = true;
  try {
    const list = (await request('/api/jobs?summary=1')).jobs || [];
    if (wasRoute !== state.route) return;
    const changed = list.filter((j) =>
      state.jobs.some((old) => old.id === j.id && old.status !== j.status),
    );
    if (wasRoute.page === 'jobs') {
      const prev = state.jobs,
        selected = wasRoute.job || list[0]?.id,
        old = prev.find((j) => j.id === selected),
        next = list.find((j) => j.id === selected);
      const altered =
        list.length !== prev.length ||
        list.some(
          (j) =>
            !prev.some(
              (o) =>
                o.id === j.id &&
                o.updatedAt === j.updatedAt &&
                o.stage === j.stage &&
                o.status === j.status,
            ),
        );
      if (!altered) return;
      const detail =
        selected && (!old || next?.updatedAt !== old.updatedAt || next?.status !== old.status)
          ? (await request('/api/jobs/' + id(selected))).job
          : old;
      if (wasRoute !== state.route) return;
      state.jobs = detail
        ? list.some((j) => j.id === selected)
          ? list.map((j) => (j.id === selected ? detail : j))
          : [detail, ...list]
        : list;
      const screen = q('#screen');
      if (screen) jobs(screen);
      globalHead();
    } else {
      state.jobs = list;
      updateActivity();
      const changes = changed.filter(
        (j) =>
          j.projectId === wasRoute.projectId &&
          ['succeeded', 'failed', 'interrupted'].includes(j.status),
      );
      if (changes.length) {
        if (changes.some((j) => j.status === 'succeeded') && q('#content').dataset.dirty !== 'true')
          await load();
        else
          notice(
            changes.some((j) => j.status === 'succeeded')
              ? '新产物已入库，当前编辑草稿已保留'
              : '制作任务未完成，请查看任务详情。',
          );
        globalHead();
      }
    }
  } catch {
  } finally {
    busyPoll = false;
  }
}
window.addEventListener('hashchange', load);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) poll();
});
setInterval(poll, 2200);
document.addEventListener('input', (e) => {
  if (e.target.closest('#content')) q('#content').dataset.dirty = 'true';
});
load();
function overview(el, p) {
  el.innerHTML =
    h1(p.name, '项目工作区', btn('编辑简报', 'brief', 'edit')) +
    '<div class="brief-card"><div>' +
    icon('script', 22) +
    '<h2>创作简报</h2></div><p>' +
    esc(p.brief || '尚未填写项目简报。') +
    '</p></div>' +
    h2('制作流程') +
    makeFlow() +
    h2('剧本章节', btn('打开剧本 Map', 'map', 'map')) +
    '<div class="chapter-list">' +
    (p.chapters?.length
      ? p.chapters
          .map(
            (c, i) =>
              '<button data-ch="' +
              esc(c.id) +
              '"><small>' +
              String(i + 1).padStart(2, '0') +
              '</small><b>' +
              esc(c.title) +
              '</b><span>' +
              c.shots.length +
              ' 个镜头</span>' +
              icon('chev', 15) +
              '</button>',
          )
          .join('')
      : empty('项目还没有章节。', btn('从大纲开始', 'outline', 'outline'))) +
    '</div>';
  qa('[data-stage]', el).forEach((b) => (b.onclick = () => go(b.dataset.stage, p.id)));
  qa('[data-ch]', el).forEach((b) => (b.onclick = () => go('script', p.id, { chapter: b.dataset.ch })));
  listen(el, 'map', () => go('map', p.id));
  listen(el, 'outline', () => go('outline', p.id));
  listen(el, 'brief', () => {
    const d = dialog(
      '编辑项目',
      field('名称', '<input id="editname" value="' + esc(p.name) + '">') +
        field('简报', '<textarea rows="6" id="editbrief">' + esc(p.brief) + '</textarea>') +
        btn('保存', 'save', 'check', 'primary'),
    );
    listen(d, 'save', async () => {
      await patch({ name: q('#editname', d).value.trim(), brief: q('#editbrief', d).value.trim() });
      d.close();
      load();
    });
  });
}
