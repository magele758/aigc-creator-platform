import {
  q,
  qa,
  esc,
  icon,
  h1,
  h2,
  btn,
  opt,
  empty,
  field,
  listen,
  notice,
  dialog,
  findAsset,
  shotRows,
  isMovie,
  movieUrl,
  readJSON,
  saveJSON,
  request,
} from './ui.js';
const maskMemory = new Map();
export function renderMedia(el, ctx) {
  const { p, route } = ctx,
    pictures = () => ctx.project().assets.filter((a) => a.kind === 'image' && a.role !== 'mask'),
    video = route.page === 'video',
    row = shotRows(p).find((r) => r.s.id === route.shot),
    key = 'cine.draft.' + p.id + '.' + route.page + '.' + (row?.s.id || 'independent');
  const stored = readJSON(key, {});
  let d = {
    textOn: true,
    mainOn: !!row?.s.image,
    refsOn: false,
    prompt: row?.s.prompt || '',
    basePrompt: row?.s.prompt || '',
    main: row?.s.image || '',
    refs: [],
    target: row?.s.id || '',
    provider: 'local',
    size: '',
    videoProfile: 'standard',
    frames: '',
    seed: '',
    compose: false,
    ...stored,
  };
  if (row && d.basePrompt !== row.s.prompt) {
    if (d.prompt === d.basePrompt) d.prompt = row.s.prompt;
    d.basePrompt = row.s.prompt;
  }
  if (route.main && route.main !== d.launchMain) {
    d.main = route.main;
    d.mainOn = true;
    d.launchMain = route.main;
  }
  if (!findAsset(ctx.project(), d.main)) {
    d.main = '';
    if (!row && !route.main) d.mainOn = false;
  }
  d.refs = d.refs.filter((a) => findAsset(ctx.project(), a));
  const persist = () => saveJSON(key, d);
  const masks = maskMemory.get(key) || new Map();
  maskMemory.set(key, masks);
  let brushing = false,
    display = route.result || '',
    compare = false,
    providers = [],
    live = true;
  const candidates = () =>
    ctx
      .project()
      .assets.filter((a) =>
        video
          ? isMovie(a) && a.role !== 'delivery'
          : a.kind === 'image' &&
            a.role !== 'mask' &&
            (a.metrics ||
              a.role === 'generated' ||
              a.origin === 'generation' ||
              a.model ||
              a.sourceJobId ||
              a.jobId),
      )
      .slice()
      .reverse();
  if (!display) {
    const selected = row?.s[video ? 'video' : 'image'];
    display = selected || candidates()[0]?.id || '';
  }
  const bound = () => findAsset(ctx.project(), d.main),
    all = () => ctx.project().assets;
  const candidate = () => findAsset(ctx.project(), display);
  const kind = () => (video ? 'video' : d.mainOn ? 'edit' : 'image');
  function inputToggle(k, label) {
    return (
      '<button type="button" data-input="' +
      k +
      '" class="toggle ' +
      (d[k] ? 'on' : '') +
      '" aria-pressed="' +
      !!d[k] +
      '">' +
      icon(d[k] ? 'check' : 'plus', 13) +
      label +
      '</button>'
    );
  }
  function draw() {
    const base = bound(),
      out = candidate(),
      inputs = pictures();
    const visual = brushing || compare ? base : out || base;
    const showBoth = compare && base && out && out.id !== base.id && !video;
    el.innerHTML =
      h1(
        video ? '镜头工作室' : '图片工作室',
        (row ? row.c.title + ' / ' + row.s.title : '独立创作') + ' · ' + p.name,
        row ? btn('回到剧本 Map', 'map', 'map') : '',
      ) +
      '<div class="media-grid"><div><section class="media-stage"><div class="stagehead">' +
      icon(video ? 'video' : 'image', 15) +
      '<b>' +
      (video ? '镜头监视器' : '图片监视器') +
      '</b><small>' +
      esc(brushing ? '作用选区' : showBoth ? '原图 / 候选对照' : visual?.title || '预览') +
      '</small></div><div class="viewport">' +
      (visual
        ? isMovie(visual)
          ? '<video controls playsinline src="' + esc(movieUrl(visual)) + '"></video>'
          : '<div class="pixels"><img id="view-image" alt="' +
            esc(visual.title) +
            '" src="' +
            esc(visual.src) +
            '">' +
            (brushing
              ? '<canvas id="brush-canvas" aria-label="在主图上涂抹需要修改的选区"></canvas>'
              : '') +
            (showBoth
              ? '<div class="compare-layer"><img alt="编辑结果" src="' +
                esc(out.src) +
                '"></div><i class="split-line"></i>'
              : '') +
            '</div>'
        : empty(video ? '生成后可在这里查看镜头。' : '生成或上传图片后，在这里查看与编辑。')) +
      '</div><div class="stagefoot">' +
      (showBoth
        ? '<label>原图与结果 <input type="range" id="compare" min="0" max="100" value="50"></label>'
        : '<span>' + esc(brushing ? '在图上涂抹要修改的区域' : visual?.title || '待制作') + '</span>') +
      (out
        ? '<a href="' +
          esc(isMovie(out) ? movieUrl(out) : out.src) +
          '?download=1" download>' +
          icon('download', 15) +
          ' 下载' +
          (video ? '视频' : '图片') +
          '</a>'
        : '') +
      '</div></section>' +
      h2(video ? '已归档镜头' : '项目图片') +
      '<div class="thumblist">' +
      (video ? all().filter((a) => isMovie(a) && a.role !== 'delivery') : inputs)
        .slice()
        .reverse()
        .map(
          (a) =>
            '<button data-preview="' +
            esc(a.id) +
            '" title="' +
            esc(a.title) +
            '">' +
            (isMovie(a)
              ? a.poster
                ? '<img src="' + esc(a.poster) + '" alt="">'
                : '<span>' + icon('play', 16) + '</span>'
              : '<img src="' + esc(a.src) + '" alt="" loading="lazy">') +
            '<small>' +
            esc(a.title) +
            '</small></button>',
        )
        .join('') +
      '</div></div><aside class="panel media-tools">' +
      h2(video ? '生成视频' : '生图与修图') +
      '<div class="hint">输入来源 · 可组合</div><div class="toggles">' +
      inputToggle('textOn', '文字') +
      inputToggle('mainOn', video ? '主图 / 首帧' : '主图') +
      inputToggle('refsOn', '参考图') +
      '</div>' +
      (d.textOn
        ? field(
            video ? '镜头动作与摄影要求' : '图片描述或修改要求',
            '<textarea id="prompt" rows="5" placeholder="' +
              (video ? '例如，镜头缓慢靠近，保留人物轮廓。' : '例如，温暖的侧光照亮陶制台灯。') +
              '">' +
              esc(d.prompt) +
              '</textarea>',
          )
        : '') +
      (d.mainOn
        ? field(
            video ? '首帧或构图主图' : '要编辑的主图',
            '<select id="base">' +
              opt('', '从项目选择，或上传图片', d.main) +
              inputs.map((a) => opt(a.id, a.title, d.main)).join('') +
              '</select>',
          ) +
          '<div class="actions">' +
          btn('上传主图', 'upload', 'upload') +
          (!video && base ? btn(brushing ? '完成涂抹' : '涂抹选区', 'brush', 'edit') : '') +
          (!video && masks.has(d.main) ? btn('清除选区', 'clear') : '') +
          '</div>'
        : '') +
      (brushing
        ? field('画笔大小', '<input type="range" id="brush-size" min="1" max="18" value="6">')
        : '') +
      (d.refsOn
        ? '<div class="field"><span>参考图</span><div class="refchoices">' +
          inputs
            .map(
              (a) =>
                '<label><input type="checkbox" data-ref="' +
                esc(a.id) +
                '" ' +
                (d.refs.includes(a.id) ? 'checked' : '') +
                '>' +
                esc(a.title) +
                '</label>',
            )
            .join('') +
          '</div>' +
          btn('上传参考图', 'upload-ref', 'upload') +
          '</div>'
        : '') +
      '<input id="upload" hidden type="file" accept="image/png,image/webp,image/jpeg"><input id="ref-upload" hidden type="file" accept="image/png,image/webp,image/jpeg">' +
      field('执行端', '<select id="provider"></select>') +
      '<p class="hint" id="route-note"></p>' +
      (d.provider === 'local'
        ? '<details class="model-options"><summary>本地模型参数</summary>' +
          field(
            '工作画幅',
            '<select id="model-size">' +
              [
                ['', '工作流默认'],
                ['640x352', '横构图 · 640 × 352'],
                ['512x512', '方形 · 512 × 512'],
                ['352x640', '竖构图 · 352 × 640'],
              ]
                .map(([k, l]) => opt(k, l, d.size))
                .join('') +
              '</select>',
          ) +
          (video
            ? field(
                'Wan 生成档位',
                '<select id="model-profile">' +
                  opt('standard', '标准 · 基础模型', d.videoProfile) +
                  opt('turbo', '快速 · Turbo', d.videoProfile) +
                  '</select>',
              ) +
              field(
                '镜头长度（12 fps）',
                '<select id="model-frames">' +
                  [
                    ['', '工作流默认'],
                    ['13', '13 帧 · 约 1.08 秒'],
                    ['25', '25 帧 · 约 2.08 秒'],
                    ['49', '49 帧 · 约 4.08 秒'],
                    ['73', '73 帧 · 约 6.08 秒'],
                  ]
                    .map(([k, l]) => opt(k, l, d.frames))
                    .join('') +
                  '</select>',
              )
            : '') +
          field(
            '随机种子（可选）',
            '<input id="model-seed" type="number" min="0" max="2147483647" step="1" placeholder="自动分配" value="' +
              esc(d.seed) +
              '">',
          ) +
          '</details>'
        : '') +
      (d.refsOn && d.provider === 'local'
        ? '<label class="compose-option"><input id="allow-compose" type="checkbox" ' +
          (d.compose ? 'checked' : '') +
          '> 允许将参考图合成为工作流输入</label>'
        : '') +
      field(
        '结果归属',
        '<select id="target">' +
          opt('', '只保存到项目素材', d.target) +
          shotRows(p)
            .map((r) => opt(r.s.id, r.c.title + ' / ' + r.s.title, d.target))
            .join('') +
          '</select>',
      ) +
      '<div class="actions">' +
      btn(video ? '生成镜头' : d.mainOn ? '执行修图' : '生成图片', 'generate', 'spark', 'primary') +
      '</div>' +
      (out
        ? '<hr>' +
          h2('已选素材') +
          '<p class="hint">' +
          esc(out.title) +
          '</p>' +
          mediaFacts(out) +
          '<div class="actions">' +
          (!video && base && out.id !== base.id ? btn('原图对照', 'compare', 'image') : '') +
          (d.target ? btn('绑定到镜头', 'bind', 'check') : '') +
          (video ? btn('加入时间线', 'append', 'cut') : '') +
          '</div>'
        : '') +
      '</aside></div>';
    function syncProviders() {
      const sel = q('#provider', el);
      if (!sel) return;
      const k = kind(),
        opts = providers.filter((pr) => !pr.kinds?.length || pr.kinds.includes(k));
      if (!opts.some((pr) => pr.id === 'local'))
        opts.unshift({ id: 'local', label: '本地 4090 · 模型工作流', configured: true });
      if (!opts.some((pr) => pr.id === d.provider && pr.configured !== false)) d.provider = 'local';
      sel.innerHTML = opts
        .map(
          (pr) =>
            '<option value="' +
            esc(pr.id) +
            '"' +
            (pr.id === d.provider ? ' selected' : '') +
            (pr.configured === false ? ' disabled' : '') +
            '>' +
            esc(pr.label) +
            (pr.configured === false ? '（未配置）' : '') +
            '</option>',
        )
        .join('');
      q('#route-note', el).textContent =
        d.provider === 'local'
          ? '提交到本地生成队列。'
          : '生成请求与所选图像将发送至「' +
            (opts.find((pr) => pr.id === d.provider)?.label || d.provider) +
            '」。';
    }
    syncProviders();
    q('#provider', el).onchange = (e) => {
      d.provider = e.target.value;
      persist();
      draw();
    };
    for (const [name, key] of [
      ['size', 'size'],
      ['profile', 'videoProfile'],
      ['frames', 'frames'],
      ['seed', 'seed'],
    ]) {
      const control = q('#model-' + name, el);
      if (control)
        control.oninput = () => {
          d[key] = control.value;
          persist();
        };
    }
    const compose = q('#allow-compose', el);
    if (compose)
      compose.onchange = (e) => {
        d.compose = e.target.checked;
        persist();
      };
    qa('[data-input]', el).forEach(
      (b) =>
        (b.onclick = () => {
          d[b.dataset.input] = !d[b.dataset.input];
          brushing = false;
          compare = false;
          persist();
          draw();
        }),
    );
    const prompt = q('#prompt', el);
    if (prompt)
      prompt.oninput = (e) => {
        d.prompt = e.target.value;
        persist();
      };
    const baseSel = q('#base', el);
    if (baseSel)
      baseSel.onchange = (e) => {
        d.main = e.target.value;
        brushing = false;
        compare = false;
        display = '';
        persist();
        draw();
      };
    qa('[data-ref]', el).forEach(
      (ch) =>
        (ch.onchange = () => {
          d.refs = qa('[data-ref]:checked', el).map((x) => x.dataset.ref);
          persist();
        }),
    );
    q('#target', el).onchange = (e) => {
      d.target = e.target.value;
      persist();
      draw();
    };
    listen(el, 'upload', () => q('#upload', el).click());
    listen(el, 'upload-ref', () => q('#ref-upload', el).click());
    for (const [selector, isRef] of [
      ['#upload', false],
      ['#ref-upload', true],
    ]) {
      q(selector, el).onchange = async (e) => {
        try {
          const f = e.target.files[0];
          if (!f) return;
          const a = await ctx.upload(f);
          if (!live) return;
          if (isRef) d.refs = [...new Set([...d.refs, a.id])];
          else {
            d.main = a.id;
            display = '';
            d.mainOn = true;
          }
          brushing = false;
          compare = false;
          persist();
          draw();
          notice('图片已保存到项目');
        } catch (err) {
          notice(err.message);
        }
      };
    }
    listen(el, 'map', () => ctx.go('map', p.id, { shot: row?.s.id }));
    listen(el, 'brush', () => {
      brushing = !brushing;
      compare = false;
      draw();
    });
    listen(el, 'compare', () => {
      compare = !compare;
      brushing = false;
      draw();
    });
    listen(el, 'clear', () => {
      masks.delete(d.main);
      draw();
    });
    qa('[data-preview]', el).forEach(
      (b) =>
        (b.onclick = () => {
          display = b.dataset.preview;
          compare = false;
          brushing = false;
          draw();
        }),
    );
    if (showBoth)
      q('#compare').oninput = (e) => {
        q('.compare-layer').style.clipPath = 'inset(0 0 0 ' + e.target.value + '%)';
        q('.split-line').style.left = e.target.value + '%';
      };
    if (brushing && base) mountBrush();
    listen(el, 'bind', async () => {
      if (!out || !d.target) return;
      const chapters = structuredClone(ctx.project().chapters),
        r = shotRows({ chapters }).find((r) => r.s.id === d.target);
      if (!r) throw Error('未找到目标镜头');
      r.s[video ? 'video' : 'image'] = out.id;
      await ctx.patch({ chapters });
      notice('素材已绑定到目标镜头');
    });
    listen(el, 'append', async () => {
      if (!isMovie(out)) throw Error('请选择视频');
      const target = shotRows(p).find((r) => r.s.id === d.target);
      const sequence = [
        ...ctx.project().sequence,
        {
          id: crypto.randomUUID(),
          title: out.title,
          assetId: out.id,
          chapterId: target?.c.id || null,
          shotId: target?.s.id || null,
          duration: out.duration || 1,
          trimIn: 0,
        },
      ];
      await ctx.patch({ sequence });
      ctx.go('cut', p.id);
    });
    listen(el, 'generate', async () => {
      if (!d.textOn && !d.mainOn && !d.refsOn) throw Error('至少启用一种输入来源');
      if (d.textOn && !d.prompt.trim()) throw Error('请填写文字描述，或关闭文字输入');
      if (d.mainOn && !bound()) throw Error('请上传或选择主图');
      if (d.refsOn && !d.refs.length) throw Error('请指定参考图');
      const mask = masks.get(d.main);
      const opts = {};
      if (d.provider === 'local') {
        if (d.size) {
          const [width, height] = d.size.split('x').map(Number);
          Object.assign(opts, { width, height });
        }
        if (d.seed !== '') {
          const seed = Number(d.seed);
          if (!Number.isInteger(seed) || seed < 0 || seed > 2147483647)
            throw Error('请填写 0–2147483647 之间的整数种子');
          opts.seed = seed;
        }
        if (video) {
          opts.videoProfile = d.videoProfile;
          if (d.frames) Object.assign(opts, { frames: Number(d.frames), fps: 12 });
        }
      }
      const payload = {
        ...opts,
        kind: kind(),
        projectId: p.id,
        provider: d.provider,
        prompt: d.textOn ? d.prompt.trim() : '',
        ...(d.mainOn ? { mainAssetId: d.main } : {}),
        ...(d.refsOn
          ? {
              referenceAssetIds: d.refs,
              ...(d.provider === 'local' && d.compose ? { allowReferenceComposition: true } : {}),
            }
          : {}),
        ...(d.target ? { shotId: d.target } : {}),
      };
      if (!video && d.mainOn && mask?.points.length) {
        if (!mask.assetId) {
          const painted = await maskPng(bound().src, mask.points);
          mask.assetId = (await ctx.upload(painted, '作用选区 · ' + bound().title, 'mask')).id;
        }
        payload.maskAssetId = mask.assetId;
      }
      const j = await ctx.submit(payload);
      ctx.go('jobs', null, { job: j.id });
    });
  }
  function mountBrush() {
    const c = q('#brush-canvas', el),
      im = q('#view-image', el);
    let active;
    function setup() {
      if (!c.isConnected || !im.naturalWidth) return;
      const r = im.getBoundingClientRect(),
        scale = Math.min(
          1,
          Math.min(1200, r.width * 1.5) / im.naturalWidth,
          Math.min(900, r.height * 1.5) / im.naturalHeight,
        );
      const w = Math.max(1, Math.round(im.naturalWidth * scale)),
        h = Math.max(1, Math.round(im.naturalHeight * scale));
      if (c.width !== w || c.height !== h) {
        c.width = w;
        c.height = h;
      }
      drawStrokes(c, masks.get(d.main)?.points || [], 'rgba(190,255,110,.6)');
    }
    if (im.complete) setup();
    else im.onload = setup;
    const xy = (e) => {
      const r = c.getBoundingClientRect();
      return [
        Math.max(0, Math.min(1, (e.clientX - r.x) / r.width)),
        Math.max(0, Math.min(1, (e.clientY - r.y) / r.height)),
      ];
    };
    c.onpointerdown = (e) => {
      if (e.button !== 0 || !c.width) return;
      const mask = masks.get(d.main) || { points: [] };
      mask.assetId = null;
      active = { w: Number(q('#brush-size').value) / 100, xy: [xy(e)] };
      mask.points.push(active);
      masks.set(d.main, mask);
      c.setPointerCapture(e.pointerId);
      setup();
    };
    c.onpointermove = (e) => {
      if (!active) return;
      active.xy.push(xy(e));
      setup();
    };
    c.onpointerup = c.onpointercancel = () => (active = null);
  }
  window.cineSelectedMedia = {
    projectId: p.id,
    inputs: async () => {
      const ref = {
        ...(d.mainOn && d.main ? { mainAssetId: d.main } : {}),
        ...(d.refsOn && d.refs.length ? { referenceAssetIds: d.refs } : {}),
        ...(d.target ? { shotId: d.target } : {}),
      };
      const m = masks.get(d.main);
      if (d.mainOn && m?.points.length) {
        if (!m.assetId)
          m.assetId = (
            await ctx.upload(await maskPng(bound().src, m.points), '作用选区 · ' + bound().title, 'mask')
          ).id;
        ref.maskAssetId = m.assetId;
      }
      return ref;
    },
  };
  draw();
  request('/api/providers')
    .then((result) => {
      if (live) {
        providers = result.providers || [];
        const s = q('#provider', el);
        if (s) {
          const previous = s.value;
          const next = providers.filter(
            (x) => (!x.kinds || x.kinds.includes(kind())) && x.id !== 'local',
          );
          for (const pr of next) {
            const o = new Option(pr.label + (pr.configured === false ? '（未配置）' : ''), pr.id);
            o.disabled = pr.configured === false;
            s.add(o);
          }
          if ([...s.options].some((o) => o.value === d.provider && !o.disabled)) s.value = d.provider;
          else s.value = previous;
        }
      }
    })
    .catch(() => {});
  return () => {
    live = false;
  };
}
function drawStrokes(canvas, strokes, color) {
  const c = canvas.getContext('2d');
  c.clearRect(0, 0, canvas.width, canvas.height);
  c.strokeStyle = c.fillStyle = color;
  c.lineJoin = c.lineCap = 'round';
  for (const stroke of strokes) {
    if (!stroke.xy.length) continue;
    const w = canvas.width,
      h = canvas.height;
    c.lineWidth = Math.max(1, Math.min(w, h) * stroke.w);
    c.beginPath();
    if (stroke.xy.length === 1) {
      c.arc(stroke.xy[0][0] * w, stroke.xy[0][1] * h, c.lineWidth / 2, 0, Math.PI * 2);
      c.fill();
    } else {
      stroke.xy.forEach(([x, y], i) => (i ? c.lineTo(x * w, y * h) : c.moveTo(x * w, y * h)));
      c.stroke();
    }
  }
}
async function maskPng(src, points) {
  const im = new Image();
  im.src = src;
  await im.decode();
  const result = document.createElement('canvas');
  result.width = im.naturalWidth;
  result.height = im.naturalHeight;
  drawStrokes(result, points, 'white');
  const c = result.getContext('2d');
  c.globalCompositeOperation = 'destination-over';
  c.fillStyle = 'black';
  c.fillRect(0, 0, result.width, result.height);
  return result.toDataURL('image/png');
}

function mediaFacts(a) {
  const m = a.metrics || {},
    secs = (v) => Number(v).toFixed(1) + ' 秒';
  const pairs = [
    [a.width && a.height ? '画幅' : null, a.width + ' × ' + a.height],
    [a.duration ? '时长' : null, a.duration ? secs(a.duration) : ''],
    [Number.isFinite(m.elapsedSeconds) ? '执行耗时' : null, secs(m.elapsedSeconds)],
    [Number.isFinite(m.queueSeconds) ? '排队' : null, secs(m.queueSeconds)],
    [m.model ? '模型' : null, m.model],
  ];
  return (
    '<dl class="media-facts">' +
    pairs
      .filter(([label]) => label)
      .map(([l, v]) => '<div><dt>' + esc(l) + '</dt><dd>' + esc(v) + '</dd></div>')
      .join('') +
    '</dl>'
  );
}
