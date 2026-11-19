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
  empty,
  field,
  notice,
  request,
  listen,
  dialog,
  makeId,
  findAsset,
  shotRows,
  isMovie,
  movieUrl,
} from './ui.js';
const clone = (x) => structuredClone(x);
export function renderWriter(el, ctx) {
  const { p, route, go } = ctx,
    isOutline = route.page === 'outline';
  let outline = clone(p.outline || []),
    chapters = clone(p.chapters || []);
  const index = Math.max(
    0,
    chapters.findIndex((c) => c.id === route.chapter),
  );
  let c = chapters[index];
  let brief = p.brief || '';
  const change = () => {
    q('#content').dataset.dirty = 'true';
  };
  const refresh = () => {
    el.innerHTML =
      h1(
        isOutline ? '故事大纲' : '章节剧本',
        isOutline ? '从创作简报整理章节与节拍。' : '逐章编辑场景、动作、对白与镜头。',
      ) +
      '<div class="editorgrid"><section class="panel" id="writing"></section><aside class="panel" id="writing-tools"></aside></div>';
    const w = q('#writing', el),
      tools = q('#writing-tools', el);
    if (isOutline) {
      w.innerHTML =
        h2('章节大纲', btn('添加章节', 'add', 'plus')) +
        (outline.length
          ? outline
              .map(
                (o, i) =>
                  '<div class="beat"><span class="ordinal">' +
                  String(i + 1).padStart(2, '0') +
                  '</span><div>' +
                  field('章节标题', '<input data-title="' + i + '" value="' + esc(o.title) + '">') +
                  field(
                    '故事节拍',
                    '<textarea data-beat="' + i + '" rows="2">' + esc(o.beat) + '</textarea>',
                  ) +
                  '<div class="miniops"><button data-del="' +
                  i +
                  '" class="textbtn">移除节拍</button></div></div></div>',
              )
              .join('')
          : empty('从右侧生成大纲，也可以直接添加章节。')) +
        '<div class="actions">' +
        btn('保存大纲', 'save', 'check', 'primary') +
        '</div>';
      tools.innerHTML =
        h2('创作简报') +
        field(
          '主题、受众与叙事要求',
          '<textarea id="brief" rows="6" placeholder="描写角色、地点与故事目标">' +
            esc(brief) +
            '</textarea>',
        ) +
        field(
          '目标章节数',
          '<input type="number" id="count" min="1" max="12" value="' +
            Math.max(1, Math.min(12, outline.length || 2)) +
            '">',
        ) +
        btn('生成大纲', 'gen', 'spark', 'primary') +
        '<hr>' +
        btn('进入章节剧本', 'next', 'arrow');
      q('#brief').oninput = (e) => (brief = e.target.value);
      qa('[data-title]', w).forEach(
        (b) => (b.oninput = () => (outline[+b.dataset.title].title = b.value)),
      );
      qa('[data-beat]', w).forEach((b) => (b.oninput = () => (outline[+b.dataset.beat].beat = b.value)));
      qa('[data-del]', w).forEach(
        (b) =>
          (b.onclick = () => {
            outline.splice(+b.dataset.del, 1);
            change();
            refresh();
          }),
      );
      listen(w, 'add', () => {
        outline.push({ id: makeId(), title: '新章节', beat: '' });
        change();
        refresh();
        qa('[data-title]', w).at(-1)?.focus();
      });
      listen(w, 'save', async () => {
        if (outline.some((o) => !o.title.trim() || !o.beat.trim()))
          throw Error('请补齐每章标题和故事节拍');
        await ctx.patch({ outline, brief });
        await ctx.load();
        notice('大纲已保存');
      });
      listen(tools, 'gen', async () => {
        if (!brief.trim()) throw Error('先填写创作简报');
        const count = +q('#count', tools).value;
        if (!Number.isInteger(count) || count < 1 || count > 12) throw Error('请输入 1–12 章');
        if (brief !== p.brief) await ctx.patch({ brief });
        const job = await ctx.submit({ kind: 'outline', projectId: p.id, brief, chapters: count });
        go('jobs', null, { job: job.id });
      });
      listen(tools, 'next', () => go('script', p.id));
    } else {
      w.innerHTML =
        h2('章节正文', btn('新建章节', 'add-ch', 'plus')) +
        (c
          ? field(
              '选择章节',
              '<select id="chapter">' +
                chapters.map((v, i) => opt(v.id, '第 ' + (i + 1) + ' 章 · ' + v.title, c.id)).join('') +
                '</select>',
            ) +
            field('章节标题', '<input id="chapter-title" value="' + esc(c.title) + '">') +
            field(
              '场景、动作与对白',
              '<textarea id="chapter-text" rows="10">' + esc(c.text) + '</textarea>',
            ) +
            btn('保存章节', 'save', 'check', 'primary') +
            '<hr>' +
            h2('章节镜头', btn('添加镜头', 'add-shot', 'plus')) +
            '<div class="shotlist">' +
            (c.shots || [])
              .map(
                (s, i) =>
                  '<div><small>' +
                  String(i + 1).padStart(2, '0') +
                  '</small><b>' +
                  esc(s.title) +
                  '</b><button data-sh="' +
                  esc(s.id) +
                  '" class="textbtn">编辑镜头</button><button data-art="' +
                  esc(s.id) +
                  '" class="textbtn">配图</button></div>',
              )
              .join('') +
            '</div>'
          : empty('依据已采用的大纲展开剧本，或手动创建第一章。'));
      tools.innerHTML =
        h2('从大纲展开') +
        '<p class="hint">' +
        esc(
          p.outline?.length
            ? p.outline.map((o) => o.title).join(' / ')
            : '先写下故事大纲以提供章节结构。',
        ) +
        '</p>' +
        field(
          '起草范围',
          '<select id="script-range">' +
            opt('', '全部章节', c?.outlineId || '') +
            (p.outline || []).map((o) => opt(o.id, o.title, c?.outlineId || '')).join('') +
            '</select>',
        ) +
        '<div class="actions">' +
        btn('生成章节剧本', 'gen', 'spark', 'primary') +
        btn('查看大纲', 'back', 'outline') +
        '</div><hr>' +
        btn('打开完整 Map', 'map', 'map');
      listen(tools, 'back', () => go('outline', p.id));
      listen(tools, 'map', () => go('map', p.id));
      listen(tools, 'gen', async () => {
        if (!p.outline?.length) throw Error('请先保存项目大纲');
        const j = await ctx.submit({
          kind: 'script',
          projectId: p.id,
          brief: p.brief,
          ...(q('#script-range', tools)?.value ? { chapterId: q('#script-range', tools).value } : {}),
        });
        go('jobs', null, { job: j.id });
      });
      listen(w, 'add-ch', async () => {
        const item = { id: makeId(), title: '新章节 ' + (chapters.length + 1), text: '', shots: [] };
        await ctx.patch({ chapters: [...chapters, item] });
        go('script', p.id, { chapter: item.id });
      });
      if (!c) return;
      q('#chapter', w).onchange = (e) => go('script', p.id, { chapter: e.target.value });
      q('#chapter-title', w).oninput = (e) => (c.title = e.target.value);
      q('#chapter-text', w).oninput = (e) => (c.text = e.target.value);
      listen(w, 'save', async () => {
        if (!c.title.trim() || !c.text.trim()) throw Error('请填写章节标题和正文');
        await ctx.patch({ chapters });
        await ctx.load();
        notice('剧本已保存');
      });
      listen(w, 'add-shot', async () => {
        const s = {
          id: makeId(),
          title: '镜头 ' + ((c.shots?.length || 0) + 1),
          prompt: c.text.slice(0, 180),
        };
        c.shots ??= [];
        c.shots.push(s);
        await ctx.patch({ chapters });
        go('map', p.id, { shot: s.id });
      });
      qa('[data-sh]', w).forEach((b) => (b.onclick = () => go('map', p.id, { shot: b.dataset.sh })));
      qa('[data-art]', w).forEach((b) => (b.onclick = () => go('image', p.id, { shot: b.dataset.art })));
    }
  };
  refresh();
}
export function renderAssets(el, ctx) {
  const { p, go } = ctx;
  let filter = 'all';
  const draw = () => {
    const items = (p.assets || []).filter(
      (a) => filter === 'all' || (filter === 'shared' ? a.shared : a.kind === filter),
    );
    el.innerHTML =
      h1(
        '资源与共享',
        p.name + ' · ' + (p.assets?.length || 0) + ' 份可用素材',
        btn('上传素材', 'upload', 'upload'),
      ) +
      '<div class="tabs">' +
      [
        ['all', '全部'],
        ['image', '图片'],
        ['video', '视频'],
        ['shared', '共享给我'],
      ]
        .map(
          ([k, l]) =>
            '<button class="' + (k === filter ? 'on' : '') + '" data-f="' + k + '">' + l + '</button>',
        )
        .join('') +
      '</div><input hidden type="file" id="assetfile" accept="image/png,image/jpeg,image/webp,video/mp4,video/webm"><div class="assetgrid">' +
      items
        .map(
          (a) =>
            '<article class="asset"><div class="asset-thumb">' +
            (a.kind === 'image'
              ? '<img src="' + esc(a.src) + '" loading="lazy" alt="">'
              : a.poster
                ? '<img src="' + esc(a.poster) + '" alt="">'
                : '<video src="' +
                  esc(movieUrl(a)) +
                  '#t=0.1" preload="metadata" muted playsinline></video>') +
            '</div><div><b>' +
            esc(a.title) +
            '</b><small>' +
            esc(a.role === 'mask' ? '选区遮罩' : isMovie(a) ? '视频' : '图片') +
            (a.shared ? ' · 共享引用' : a.copiedFrom ? ' · 独立副本' : ' · 本项目') +
            '</small><nav><a href="' +
            esc(isMovie(a) ? movieUrl(a) : a.src) +
            '?download=1" class="textbtn" download>下载</a>' +
            (a.kind === 'image'
              ? '<button class="textbtn" data-edit="' + esc(a.id) + '">编辑图片</button>'
              : '') +
            (!a.shared ? '<button class="textbtn" data-share="' + esc(a.id) + '">共享</button>' : '') +
            '</nav></div></article>',
        )
        .join('') +
      '</div>' +
      (!items.length ? empty('这里还没有素材。', btn('进入图片工作室', 'image', 'image')) : '') +
      h2('共享授权') +
      '<div class="sharelist">' +
      ((p.grants || [])
        .filter((g) => (g.sourceProjectId || g.ownerProjectId || g.owner) === p.id)
        .map(
          (g) =>
            '<div><span>' +
            esc(findAsset(p, g.assetId)?.title || g.assetId) +
            ' → ' +
            esc(
              ctx.projects.find((o) => o.id === (g.targetProjectId || g.target))?.name ||
                g.targetProjectId,
            ) +
            '</span><button data-revoke="' +
            esc(g.id) +
            '" class="textbtn">撤销授权</button></div>',
        )
        .join('') || '<p class="hint">暂无授出的引用。</p>') +
      '</div>';
    qa('[data-f]', el).forEach(
      (b) =>
        (b.onclick = () => {
          filter = b.dataset.f;
          draw();
        }),
    );
    listen(el, 'image', () => go('image', p.id));
    listen(el, 'upload', () => q('#assetfile').click());
    q('#assetfile').onchange = async (e) => {
      try {
        const f = e.target.files[0];
        if (f) {
          await ctx.upload(f);
          await ctx.load();
          notice('素材已存入项目');
        }
      } catch (err) {
        notice(err.message);
      }
    };
    qa('[data-edit]', el).forEach(
      (b) => (b.onclick = () => go('image', p.id, { main: b.dataset.edit })),
    );
    qa('[data-share]', el).forEach(
      (b) =>
        (b.onclick = () => {
          const targets = ctx.projects.filter((x) => x.id !== p.id);
          if (!targets.length) {
            notice('先创建接收素材的项目');
            return;
          }
          const d = dialog(
            '共享项目素材',
            field(
              '目标项目',
              '<select id="share-target">' +
                targets.map((x) => opt(x.id, x.name)).join('') +
                '</select>',
            ) +
              field(
                '共享方式',
                '<select id="share-mode"><option value="reference">授权引用</option><option value="copy">独立副本</option></select>',
              ) +
              btn('确认共享', 'share', 'share', 'primary'),
          );
          listen(d, 'share', async () => {
            await request('/api/projects/' + id(p.id) + '/share', {
              assetId: b.dataset.share,
              targetProjectId: q('#share-target', d).value,
              mode: q('#share-mode', d).value,
            });
            d.close();
            await ctx.load();
            notice('已共享素材');
          });
        }),
    );
    qa('[data-revoke]', el).forEach(
      (b) =>
        (b.onclick = () => {
          const d = dialog(
            '撤销引用授权',
            '<p>目标项目将失去此引用的使用权限。</p>' + btn('撤销授权', 'revoke', 'share', 'primary'),
          );
          listen(d, 'revoke', async () => {
            await request(
              '/api/projects/' + id(p.id) + '/share/' + id(b.dataset.revoke),
              undefined,
              'DELETE',
            );
            d.close();
            await ctx.load();
          });
        }),
    );
  };
  draw();
}
export function renderMap(el, ctx) {
  const { p, go } = ctx,
    rows = shotRows(p);
  let layout = clone(p.mapLayout || {}),
    links = clone(p.storyLinks || []),
    selected = ctx.route.shot || ctx.route.chapter || p.id;
  const nodes = [];
  nodes.push({
    id: p.id,
    kind: 'root',
    title: p.name,
    x: 12,
    y: Math.max(65, (p.chapters.length - 1) * 84 + 30),
  });
  p.chapters.forEach((c, ci) => {
    nodes.push({ id: c.id, kind: 'chapter', title: c.title, x: 205, y: ci * 163 + 43, ci, c });
    c.shots.forEach((s, si) =>
      nodes.push({
        id: s.id,
        kind: 'shot',
        title: s.title,
        x: 420 + si * 191,
        y: ci * 163 + 18,
        s,
        c,
        ci,
        si,
      }),
    );
  });
  nodes.forEach((n) => Object.assign(n, layout[n.id] || {}));
  const byId = (a) => nodes.find((n) => n.id === a);
  const photo = (n) => n.s && (findAsset(p, n.s.image)?.src || findAsset(p, n.s.video)?.poster);
  el.innerHTML =
    h1(
      '剧本 Map',
      p.chapters.length + ' 章 · ' + rows.length + ' 个镜头',
      btn('进入成片剪辑', 'cut', 'cut'),
    ) +
    '<div class="mapgrid"><section class="mapmain"><div class="mapbar"><span>章节与分镜</span><div>' +
    btn('−', 'less') +
    ' <b id="zoom"></b> ' +
    btn('＋', 'more') +
    ' ' +
    btn('适应画布', 'fit', 'frame') +
    ' ' +
    btn('自动布局', 'reset') +
    '</div></div><div class="mapview"><div class="world"><svg class="edges" aria-hidden="true"></svg>' +
    nodes
      .map(
        (n) =>
          '<button data-node="' +
          esc(n.id) +
          '" class="node ' +
          n.kind +
          '">' +
          (photo(n) ? '<img alt="" data-photo="' + esc(photo(n)) + '">' : '') +
          '<small>' +
          esc(
            n.kind === 'root'
              ? '项目大纲'
              : n.kind === 'chapter'
                ? '第 ' + (n.ci + 1) + ' 章'
                : '镜 ' + (n.ci + 1) + '.' + (n.si + 1),
          ) +
          '</small><b>' +
          esc(n.title) +
          '</b>' +
          (n.s ? '<em>' + esc(n.s.video ? '已出片' : n.s.image ? '已配图' : '待制作') + '</em>' : '') +
          '</button>',
      )
      .join('') +
    '</div></div><p class="mapfoot">拖动画布平移，拖动节点调整位置。点选镜头可编辑与串联。</p></section><aside class="mapdetail" id="detail"></aside></div>';
  const pan = q('.mapview', el),
    world = q('.world', el),
    edges = q('.edges', el),
    detail = q('#detail', el);
  const buttons = new Map(qa('[data-node]', el).map((b) => [b.dataset.node, b]));
  let z = 1,
    x = 10,
    y = 10;
  function lines() {
    const paths = [];
    const edge = (a, b, user = false) => {
      if (!a || !b) return;
      const bx = a.x + 147,
        by = a.y + (a.kind === 'shot' ? 52 : 32),
        tx = b.x,
        ty = b.y + (b.kind === 'shot' ? 52 : 32);
      paths.push(
        '<path class="' +
          (user ? 'storyedge' : 'edge') +
          '" d="M ' +
          bx +
          ' ' +
          by +
          ' C ' +
          (bx + 45) +
          ' ' +
          by +
          ' ' +
          (tx - 45) +
          ' ' +
          ty +
          ' ' +
          tx +
          ' ' +
          ty +
          '"/>',
      );
    };
    for (const n of nodes) {
      const b = buttons.get(n.id);
      b.style.transform = 'translate(' + n.x + 'px,' + n.y + 'px)';
      if (n.kind === 'chapter') edge(nodes[0], n);
      if (n.kind === 'shot') edge(byId(n.c.id), n);
    }
    for (const l of links) edge(byId(l.from), byId(l.to), true);
    edges.innerHTML = paths.join('');
  }
  let paintFrame;
  function thumbnails() {
    if (paintFrame) return;
    paintFrame = requestAnimationFrame(() => {
      paintFrame = 0;
      const w = pan.clientWidth,
        h = pan.clientHeight;
      let count = 0;
      for (const n of nodes) {
        const im = buttons.get(n.id).querySelector('[data-photo]');
        if (!im) continue;
        const left = n.x * z + x,
          top = n.y * z + y,
          near = left + 147 * z >= -12 && top + 110 * z >= -12 && left < w + 12 && top < h + 12;
        const show = near && (z >= 0.35 || nodes.length < 35) && count < 30;
        if (show) {
          count++;
          if (!im.hasAttribute('src')) im.src = im.dataset.photo;
        } else if (im.hasAttribute('src')) im.removeAttribute('src');
      }
    });
  }
  function view() {
    thumbnails();
    world.style.transform = 'translate(' + x + 'px,' + y + 'px) scale(' + z + ')';
    q('#zoom', el).textContent = Math.round(z * 100) + '%';
  }
  function fit() {
    const minX = Math.min(...nodes.map((n) => n.x)),
      minY = Math.min(...nodes.map((n) => n.y)),
      w = Math.max(...nodes.map((n) => n.x + 155)) - minX,
      h = Math.max(...nodes.map((n) => n.y + 115)) - minY;
    z = Math.max(0.04, Math.min(1.05, (pan.clientWidth - 25) / w, (pan.clientHeight - 25) / h));
    x = (pan.clientWidth - w * z) / 2 - minX * z;
    y = (pan.clientHeight - h * z) / 2 - minY * z;
    view();
  }
  function zoom(mult, ox = pan.clientWidth / 2, oy = pan.clientHeight / 2) {
    const nz = Math.max(0.05, Math.min(2.4, z * mult));
    x = ox - ((ox - x) * nz) / z;
    y = oy - ((oy - y) * nz) / z;
    z = nz;
    view();
  }
  function inspector() {
    const n = byId(selected) || nodes[0];
    buttons.forEach((b, k) => b.classList.toggle('selected', k === n.id));
    detail.innerHTML =
      '<small class="caps">' +
      (n.kind === 'root' ? '项目大纲' : n.kind === 'chapter' ? '剧本章节' : '分镜') +
      '</small><h2>' +
      esc(n.title) +
      '</h2>' +
      (n.kind === 'root'
        ? '<p>' +
          esc(p.brief || '暂无简报') +
          '</p>' +
          p.outline
            .map((o, i) => '<h3>' + (i + 1) + '　' + esc(o.title) + '</h3><p>' + esc(o.beat) + '</p>')
            .join('') +
          btn('编辑大纲', 'outline', 'outline')
        : n.kind === 'chapter'
          ? '<p>' + esc(n.c.text || '暂无正文') + '</p>' + btn('编辑章节', 'script', 'script')
          : '<p>' +
            esc(n.s.prompt || '尚未填写导演指令。') +
            '</p><div class="actions">' +
            btn('编辑镜头', 'shot', 'edit') +
            btn('编辑插图', 'image', 'image') +
            btn('生成视频', 'video', 'video') +
            '</div><hr>' +
            field(
              '承接到下一镜',
              '<select id="nextshot">' +
                opt('', '无后续连线', '') +
                rows
                  .filter((r) => r.s.id !== n.id)
                  .map((r) =>
                    opt(r.s.id, r.c.title + ' / ' + r.s.title, links.find((l) => l.from === n.id)?.to),
                  )
                  .join('') +
                '</select>',
            ) +
            btn('保存串联', 'link', 'check') +
            '<hr>' +
            btn('串联镜头入剪', 'append', 'cut', 'primary'));
    listen(detail, 'outline', () => go('outline', p.id));
    listen(detail, 'script', () => go('script', p.id, { chapter: n.id }));
    listen(detail, 'image', () => go('image', p.id, { shot: n.id }));
    listen(detail, 'video', () => go('video', p.id, { shot: n.id }));
    listen(detail, 'shot', () => {
      const d = dialog(
        '编辑镜头',
        field('镜头标题', '<input id="sh-title" value="' + esc(n.title) + '">') +
          field('导演指令', '<textarea id="sh-prompt" rows="5">' + esc(n.s.prompt) + '</textarea>') +
          btn('保存镜头', 'save', 'check', 'primary'),
      );
      listen(d, 'save', async () => {
        const title = q('#sh-title', d).value.trim();
        if (!title) throw Error('请填写镜头标题');
        const cs = clone(p.chapters),
          s = shotRows({ chapters: cs }).find((v) => v.s.id === n.id).s;
        s.title = title;
        s.prompt = q('#sh-prompt', d).value.trim();
        await ctx.patch({ chapters: cs });
        d.close();
        go('map', p.id, { shot: n.id });
      });
    });
    listen(detail, 'link', async () => {
      const to = q('#nextshot', detail).value,
        updated = links.filter((l) => l.from !== n.id);
      if (to) updated.push({ from: n.id, to });
      const seen = new Set();
      let k = n.id;
      while (k) {
        if (seen.has(k)) throw Error('这条连线会形成循环，请选择其他镜头');
        seen.add(k);
        k = updated.find((l) => l.from === k)?.to;
      }
      await ctx.patch({ storyLinks: updated });
      links = updated;
      lines();
      notice('已保存镜头串联');
    });
    listen(detail, 'append', async () => {
      const seq = clone(ctx.project().sequence || []),
        seen = new Set();
      let k = n.id,
        count = 0;
      while (k && !seen.has(k)) {
        seen.add(k);
        const r = rows.find((r) => r.s.id === k),
          a = r && findAsset(p, r.s.video);
        if (!a) throw Error('镜头「' + (r?.s.title || k) + '」缺少可用视频');
        seq.push({
          id: makeId(),
          chapterId: r.c.id,
          shotId: k,
          assetId: a.id,
          title: r.s.title,
          trimIn: 0,
          duration: a.duration || 1,
        });
        count++;
        k = links.find((l) => l.from === k)?.to;
      }
      await ctx.patch({ sequence: seq });
      notice('已将 ' + count + ' 个镜头加入剪辑');
      go('cut', p.id);
    });
  }
  let drag;
  pan.onpointerdown = (e) => {
    if (e.button !== 0) return;
    const target = e.target.closest('[data-node]'),
      n = target && byId(target.dataset.node);
    drag = { n, x: e.clientX, y: e.clientY, nx: n ? n.x : x, ny: n ? n.y : y, moved: false };
    pan.setPointerCapture(e.pointerId);
  };
  pan.onpointermove = (e) => {
    if (!drag) return;
    let dx = e.clientX - drag.x,
      dy = e.clientY - drag.y;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.n) {
      drag.n.x = drag.nx + dx / z;
      drag.n.y = drag.ny + dy / z;
      lines();
    } else {
      x = drag.nx + dx;
      y = drag.ny + dy;
      view();
    }
  };
  pan.onpointerup = async () => {
    const d = drag;
    drag = null;
    if (!d?.n) return;
    if (!d.moved) {
      selected = d.n.id;
      inspector();
      return;
    }
    layout[d.n.id] = { x: Math.round(d.n.x), y: Math.round(d.n.y) };
    try {
      await ctx.patch({ mapLayout: clone(layout) });
    } catch (e) {
      notice(e.message);
      ctx.load();
    }
  };
  pan.onpointercancel = () => {
    drag = null;
  };
  buttons.forEach(
    (b, key) =>
      (b.onclick = (e) => {
        if (e.detail === 0) {
          selected = key;
          inspector();
        }
      }),
  );
  pan.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault();
      const r = pan.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0014), e.clientX - r.left, e.clientY - r.top);
    },
    { passive: false },
  );
  listen(el, 'less', () => zoom(0.82));
  listen(el, 'more', () => zoom(1.2));
  listen(el, 'fit', fit);
  listen(el, 'reset', async () => {
    await ctx.patch({ mapLayout: {} });
    ctx.load();
  });
  listen(el, 'cut', () => go('cut', p.id));
  lines();
  fit();
  inspector();
}
export function renderCut(el, ctx) {
  const { p } = ctx;
  const seq = clone(p.sequence || []);
  const choices = p.assets.filter((a) => isMovie(a) && a.role !== 'delivery'),
    deliveries = p.assets.filter((a) => a.role === 'delivery');
  let pick = 0;
  function paint() {
    const clip = seq[pick],
      a = clip && findAsset(p, clip.assetId);
    const recent = deliveries.at(-1);
    el.innerHTML =
      h1(
        '成片剪辑',
        seq.length +
          ' 个片段 · ' +
          seq.reduce((t, c) => t + (Number(c.duration) || 0), 0).toFixed(2) +
          ' 秒',
        btn('返回剧本 Map', 'map', 'map'),
      ) +
      '<div class="editorgrid"><section><div class="monitor">' +
      (a
        ? '<video controls playsinline src="' +
          esc(movieUrl(a)) +
          '#t=' +
          Number(clip.trimIn || 0) +
          '"></video>'
        : empty('选择时间线上的片段进行预览。')) +
      '</div>' +
      h2('剪辑时间线', btn('保存剪辑', 'save', 'check')) +
      '<div class="timeline">' +
      (seq.length
        ? seq
            .map(
              (c, i) =>
                '<div class="cliprow ' +
                (i === pick ? 'current' : '') +
                '"><button data-pick="' +
                i +
                '"><span class="ordinal">' +
                String(i + 1).padStart(2, '0') +
                '</span><b>' +
                esc(c.title || findAsset(p, c.assetId)?.title) +
                '</b><small>' +
                Number(c.duration || 0).toFixed(2) +
                ' s</small></button><button aria-label="片段上移" class="icobtn" data-move="' +
                i +
                '" data-dir="-1">' +
                icon('up', 14) +
                '</button><button aria-label="片段下移" class="icobtn" data-move="' +
                i +
                '" data-dir="1">' +
                icon('down', 14) +
                '</button><button aria-label="移除片段" class="icobtn" data-del="' +
                i +
                '">' +
                icon('trash', 14) +
                '</button></div>',
            )
            .join('')
        : empty('加入生成好的视频素材以组接短片。')) +
      '</div></section><aside class="panel">' +
      h2('片段控制') +
      field(
        '加入视频素材',
        '<select id="add-asset">' +
          opt('', '选择视频', '') +
          choices.map((a) => opt(a.id, a.title)).join('') +
          '</select>',
      ) +
      btn('加入时间线', 'add', 'plus') +
      (clip
        ? '<hr>' +
          field(
            '源片入点（秒）',
            '<input id="trim" type="number" min="0" step="0.01" value="' +
              Number(clip.trimIn || 0) +
              '">',
          ) +
          field(
            '使用时长（秒）',
            '<input id="length" type="number" min="0.04" step="0.01" value="' +
              Number(clip.duration || 1) +
              '">',
          )
        : '') +
      '<hr>' +
      btn('导出完整影片', 'export', 'download', 'primary') +
      (recent
        ? '<hr>' +
          h2('最近交付') +
          '<video class="delivery" controls playsinline src="' +
          esc(movieUrl(recent)) +
          '"></video><a class="textbtn" href="' +
          esc(movieUrl(recent)) +
          '?download=1" download>下载成片</a>'
        : '') +
      '</aside></div>';
    const dirty = () => (q('#content').dataset.dirty = 'true');
    if (clip) {
      const media = q('.monitor video', el);
      if (media)
        media.ontimeupdate = () => {
          if (
            media.currentTime > Number(clip.trimIn || 0) + Number(clip.duration || 0) + 0.05 &&
            !media.paused
          ) {
            media.pause();
            media.currentTime = Number(clip.trimIn || 0);
          }
        };
      q('#trim').oninput = (e) => (clip.trimIn = Number(e.target.value));
      q('#length').oninput = (e) => (clip.duration = Number(e.target.value));
    }
    const save = async () => {
      for (const c of seq) {
        const asset = findAsset(p, c.assetId);
        if (!asset) throw Error('片段素材缺失');
        if (
          !Number.isFinite(c.duration) ||
          c.duration <= 0 ||
          Number(c.trimIn || 0) < 0 ||
          (asset.duration && Number(c.trimIn || 0) + c.duration > asset.duration + 0.05)
        )
          throw Error('请核对「' + c.title + '」的入点与时长');
      }
      await ctx.patch({ sequence: seq });
      q('#content').dataset.dirty = '';
    };
    qa('[data-pick]', el).forEach(
      (b) =>
        (b.onclick = () => {
          pick = +b.dataset.pick;
          paint();
        }),
    );
    qa('[data-move]', el).forEach(
      (b) =>
        (b.onclick = () => {
          const i = +b.dataset.move,
            j = i + +b.dataset.dir;
          if (j < 0 || j >= seq.length) return;
          [seq[i], seq[j]] = [seq[j], seq[i]];
          pick = j;
          dirty();
          paint();
        }),
    );
    qa('[data-del]', el).forEach(
      (b) =>
        (b.onclick = () => {
          seq.splice(+b.dataset.del, 1);
          pick = Math.max(0, Math.min(pick, seq.length - 1));
          dirty();
          paint();
        }),
    );
    listen(el, 'add', () => {
      const a = findAsset(p, q('#add-asset').value);
      if (!a) throw Error('请选择视频素材');
      const row = shotRows(p).find((r) => r.s.video === a.id);
      seq.push({
        id: makeId(),
        assetId: a.id,
        title: a.title,
        shotId: row?.s.id || null,
        chapterId: row?.c.id || null,
        trimIn: 0,
        duration: a.duration || 1,
      });
      pick = seq.length - 1;
      dirty();
      paint();
    });
    listen(el, 'save', async () => {
      await save();
      notice('已保存剪辑');
    });
    listen(el, 'map', () => ctx.go('map', p.id));
    listen(el, 'export', async () => {
      if (!seq.length) throw Error('请先加入视频片段');
      await save();
      const j = await ctx.submit({ kind: 'export', projectId: p.id });
      ctx.go('jobs', null, { job: j.id });
    });
  }
  paint();
}
