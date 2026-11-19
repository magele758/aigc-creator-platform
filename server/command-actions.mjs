import { createHash } from 'node:crypto';
import { project, patchProject, assetList, saveJob, getAsset, mediaUrl, must } from './store.mjs';
import { generateMedia, exportSequence } from './media.mjs';

const operations = [
  'inspect',
  'project_edit',
  'outline_add',
  'chapter_add',
  'shot_add',
  'adopt_asset',
  'map_move',
  'outline_edit',
  'chapter_edit',
  'shot_edit',
  'link_shots',
  'image',
  'edit',
  'video',
  'append_clip',
  'move_clip',
  'trim_clip',
  'remove_clip',
  'export',
];
const string = { type: 'string' };
const schema = {
  type: 'object',
  required: ['actions'],
  additionalProperties: false,
  properties: {
    actions: {
      type: 'array',
      minItems: 1,
      maxItems: 12,
      items: {
        type: 'object',
        required: ['op'],
        additionalProperties: false,
        properties: {
          op: { type: 'string', enum: operations },
          target: string,
          next: string,
          title: string,
          text: string,
          asset: string,
          mask: string,
          refs: { type: 'array', items: string },
          index: { type: 'integer' },
          start: { type: 'number' },
          duration: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
        },
      },
    },
  },
};
const fingerprint = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
function snapshot(p) {
  return {
    projectId: p.id,
    title: p.name,
    brief: p.brief,
    revision: p.revision,
    outline: p.outline,
    chapters: p.chapters.map((c) => ({
      id: c.id,
      title: c.title,
      excerpt: c.text.slice(0, 360),
      shots: c.shots.map((s) => ({
        id: s.id,
        title: s.title,
        prompt: s.prompt?.slice(0, 300),
        image: s.image,
        video: s.video,
      })),
    })),
    assets: assetList(p).map((a) => ({ id: a.id, kind: a.kind, title: a.title })),
    links: p.storyLinks,
    mapLayout: p.mapLayout,
    sequence: p.sequence.map(({ id, title, assetId, trimIn, duration }) => ({
      id,
      title,
      assetId,
      trimIn,
      duration,
    })),
  };
}
function lookup(items, id, label) {
  const item = items.find((x) => x.id === id);
  must(item, label + '不存在或不属于当前项目', 404);
  return item;
}
function fillText(obj, a, name) {
  must(a.title?.trim() || a.text?.trim(), '缺少修改后的文字');
  if (a.title?.trim()) obj.title = a.title.trim();
  if (a.text?.trim()) obj[name] = a.text.trim();
}
const newTypes = { outline_add: 'outline', chapter_add: 'chapter', shot_add: 'shot' };
const aliases = { outline: '$lastOutline', chapter: '$lastChapter', shot: '$lastShot' };
function newTargetId(job, index, op) {
  return job.id + '-' + newTypes[op] + '-' + index;
}
function insertAt(rows, row, index) {
  const target = index ?? rows.length + 1;
  must(
    Number.isInteger(target) && target >= 1 && target <= rows.length + 1,
    '插入位置从 1 开始，不能超过末尾',
  );
  rows.splice(target - 1, 0, row);
}
function resolveAction(a, last, targets) {
  const resolveTarget = (id) =>
    id?.startsWith('$')
      ? lookup(
          Object.entries(targets).map(([key, value]) => ({ id: key, value })),
          id,
          '引用的上一步对象',
        ).value
      : id;
  return {
    ...a,
    asset: recentAsset(a.asset, last),
    target: resolveTarget(a.target),
    next: resolveTarget(a.next),
  };
}
function planPatch(p, a, j, index) {
  const clip = () => lookup(p.sequence, a.target, '剪辑片段');
  const shots = p.chapters.flatMap((c) => c.shots);
  switch (a.op) {
    case 'project_edit': {
      const out = {};
      if (a.title?.trim()) out.name = a.title.trim();
      if (a.text?.trim()) out.brief = a.text.trim();
      must(Object.keys(out).length, '缺少项目名称或简报');
      return out;
    }
    case 'outline_add': {
      must(a.title?.trim() && a.text?.trim(), '大纲需要章名与节拍');
      insertAt(
        p.outline,
        { id: newTargetId(j, index, a.op), title: a.title.trim(), beat: a.text.trim() },
        a.index,
      );
      return { outline: p.outline };
    }
    case 'chapter_add': {
      const beat = a.target ? lookup(p.outline, a.target, '对应大纲') : null;
      must(!beat || !p.chapters.some((c) => c.outlineId === beat.id), '此大纲已有对应剧本章节');
      const title = a.title?.trim() || beat?.title;
      must(title, '新章节需要标题');
      insertAt(
        p.chapters,
        {
          id: newTargetId(j, index, a.op),
          title,
          text: a.text?.trim() || '',
          outlineId: beat?.id || null,
          shots: [],
        },
        a.index,
      );
      return { chapters: p.chapters };
    }
    case 'shot_add': {
      const chapter = lookup(p.chapters, a.target, '所选章节');
      must(a.title?.trim(), '新镜头需要标题');
      insertAt(
        chapter.shots,
        { id: newTargetId(j, index, a.op), title: a.title.trim(), prompt: a.text?.trim() || '' },
        a.index,
      );
      return { chapters: p.chapters };
    }
    case 'adopt_asset': {
      const shot = lookup(shots, a.target, '镜头'),
        asset = getAsset(p, a.asset);
      must(['image', 'video'].includes(asset.kind) && asset.role !== 'mask', '只可采用已有插图或视频素材');
      shot[asset.kind] = asset.id;
      return { chapters: p.chapters };
    }
    case 'map_move': {
      must(
        [p.id, ...p.chapters.map((c) => c.id), ...shots.map((s) => s.id)].includes(a.target),
        '画布节点不存在或不属于当前项目',
        404,
      );
      must(Number.isFinite(a.x) && Number.isFinite(a.y), '移动节点需要有限的目标坐标 x、y');
      return { mapLayout: { ...p.mapLayout, [a.target]: { x: a.x, y: a.y } } };
    }
    case 'outline_edit':
      fillText(lookup(p.outline, a.target, '大纲章节'), a, 'beat');
      return { outline: p.outline };
    case 'chapter_edit':
      fillText(lookup(p.chapters, a.target, '剧本章节'), a, 'text');
      return { chapters: p.chapters };
    case 'shot_edit': {
      const s = lookup(shots, a.target, '镜头');
      fillText(s, a, 'prompt');
      if (a.text?.trim()) {
        s.imagePrompt = a.text.trim();
        s.videoPrompt = a.text.trim();
      }
      return { chapters: p.chapters };
    }
    case 'link_shots':
      lookup(shots, a.target, '前镜');
      lookup(shots, a.next, '后镜');
      return {
        storyLinks: [...p.storyLinks.filter((l) => l.from !== a.target), { from: a.target, to: a.next }],
      };
    case 'append_clip': {
      const asset = getAsset(p, a.asset),
        id = j.id + '-clip-' + index;
      must(asset.kind === 'video' && asset.duration > 0, '入剪需要视频素材');
      const shot = a.target ? lookup(shots, a.target, '镜头') : null;
      const chapter = shot && p.chapters.find((c) => c.shots.some((s) => s.id === shot.id));
      return {
        sequence: [
          ...p.sequence,
          {
            id,
            assetId: asset.id,
            shotId: shot?.id,
            chapterId: chapter?.id,
            title: asset.title,
            trimIn: 0,
            duration: asset.duration,
          },
        ],
      };
    }
    case 'move_clip': {
      const c = clip();
      must(Number.isInteger(a.index) && a.index >= 1 && a.index <= p.sequence.length, '目标位置从 1 开始');
      const seq = p.sequence.filter((x) => x.id !== c.id);
      seq.splice(a.index - 1, 0, c);
      return { sequence: seq };
    }
    case 'trim_clip': {
      const c = clip();
      must(Number.isFinite(a.start) && Number.isFinite(a.duration), '裁切需要入点及长度');
      c.trimIn = a.start;
      c.duration = a.duration;
      return { sequence: p.sequence };
    }
    case 'remove_clip':
      clip();
      return { sequence: p.sequence.filter((x) => x.id !== a.target) };
    default:
      throw new Error('当前操作无法写入项目');
  }
}
function recentAsset(a, last) {
  return a === '$last' ? last : a;
}

export async function applyDirectorCommand(j, ctl) {
  const request = j.request;
  const initial = project(j.projectId);
  const cp = j.checkpoints;
  if (cp.commandRevision === undefined) {
    cp.commandRevision = initial.revision;
    saveJob(j);
  }
  const plan = await ctl.command('workspace_command', {
    immutable: true,
    name: 'apply_studio_operations',
    description: '在当前创作工程执行用户委托的编辑、独立绘图、拍摄及剪辑操作',
    schema,
    task:
      '根据用户指令只调用一次工具。只修改用户明确指定的对象。从项目清单精确复制标识。' +
      'image 为独立生图；edit 指定底图 asset 和可选 mask；video 可用 asset 作首帧。refs 为参考图 ID 数组。媒体操作 text 填写具体模型指令；未指定镜头时媒体只入库。' +
      'outline_add 的 title/text 是新章名和节拍；chapter_add 的 target 可指定对应大纲；shot_add 的 target 是所属章节，text 是导演指令。' +
      '三种新增操作可用 index 指定从1起的插入位置。依次添加时用 $lastOutline/$lastChapter/$lastShot 引用本次委托新增的最近同类对象。' +
      'adopt_asset 用 target 镜头ID与 asset 已有素材ID，只建立绑定。map_move 用 target 节点ID和画布 x/y 数值，只改变布局。' +
      'target 在文字操作时是相应的章节/镜头 ID，在移动、裁切时是剪辑片段 ID。link_shots 的 target/next 是起止镜头。' +
      'append_clip 使用 asset，或使用 $last 指上一步生成的素材。移动 index 从 1 开始；裁切 start/duration 以秒计。' +
      'export 只能是最后一步。仅查看或无法执行时使用 inspect，text 写对用户的简短说明。一次最多三次媒体推理。' +
      '\n工程：' +
      JSON.stringify(snapshot(initial)) +
      '\n已选中：' +
      JSON.stringify({
        main: request.mainAssetId,
        mask: request.maskAssetId,
        refs: request.referenceAssetIds,
        shot: request.shotId,
      }) +
      '\n委托：' +
      request.prompt,
    validate(v) {
      must(
        Array.isArray(v.actions) && v.actions.length >= 1 && v.actions.length <= 12,
        '操作数应在 1 至 12 之间',
      );
      for (const [i, a] of v.actions.entries()) {
        must(operations.includes(a.op), '未知操作');
        if (a.op === 'outline_add')
          must(
            a.title?.trim() && a.text?.trim(),
            'outline_add 必须同时提交 title 和实质叙事节拍 text，请补齐。',
          );
        if (a.op === 'chapter_add')
          must(a.title?.trim() || a.target, 'chapter_add 需要 title 或对应的大纲 target');
        if (a.op === 'shot_add')
          must(a.target && a.title?.trim(), 'shot_add 需要所属章节 target 和镜头 title');
        if (a.op === 'adopt_asset') must(a.target && a.asset, 'adopt_asset 需要 target 镜头和 asset 素材');
        if (a.op === 'map_move')
          must(a.target && Number.isFinite(a.x) && Number.isFinite(a.y), 'map_move 需要 target、x 和 y');
        if (a.op === 'export') must(i === v.actions.length - 1, '导出须为最后一步');
        if (a.refs) must(Array.isArray(a.refs) && a.refs.length <= 6, '参考图最多六张');
      }
      must(
        v.actions.filter((a) => ['image', 'edit', 'video'].includes(a.op)).length <= 3,
        '单次委托最多三次媒体推理',
      );
      return { actions: v.actions };
    },
  });
  cp.commandDone ??= [];
  cp.commandTargets ??= {};
  let last = cp.commandLast;
  let summary = cp.commandSummary || '';
  function record(i, revision, op) {
    cp.commandRevision = revision;
    cp.commandDone.push(i);
    cp.commandLast = last;
    cp.commandSummary = summary;
    if (newTypes[op]) cp.commandTargets[aliases[newTypes[op]]] = newTargetId(j, i, op);
    saveJob(j);
  }
  for (const [i, original] of plan.actions.entries()) {
    if (cp.commandDone.includes(i)) continue;
    const a = resolveAction(original, last, cp.commandTargets);
    const p = project(j.projectId),
      slot = 'command-' + i;
    const saved = cp[slot],
      cached = p.assets.find(
        (x) => x.jobId === j.id && (x.slot === slot || (a.op === 'export' && x.role === 'delivery')),
      );
    // Recover if the process ended between applying a deterministic edit and saving its receipt.
    const alreadyApplied =
      saved &&
      p.revision === saved.revision + 1 &&
      Object.entries(saved.hashes).every(([k, v]) => fingerprint(p[k]) === v);
    must(
      p.revision === cp.commandRevision || cached || alreadyApplied,
      '委托期间项目已更改，请以新的项目状态重新委托。',
      409,
    );
    ctl.emit('command.applying', { operation: a.op, step: i + 1 });
    if (['image', 'edit', 'video'].includes(a.op)) {
      const media =
        cached ||
        (await generateMedia(
          j,
          {
            kind: a.op,
            prompt: a.text || request.prompt,
            title: a.title,
            mainAssetId: a.asset || request.mainAssetId,
            maskAssetId: a.mask || request.maskAssetId,
            referenceAssetIds: a.refs || request.referenceAssetIds || [],
            shotId: a.target || request.shotId,
            allowReferenceComposition: request.allowReferenceComposition === true,
          },
          slot,
          ctl.emit,
        ));
      last = media.id;
    } else if (a.op === 'export') {
      last = (cached || (await exportSequence(j, ctl.emit))).id;
    } else if (a.op === 'inspect') {
      summary = a.text || p.name;
    } else if (!alreadyApplied) {
      const patch = planPatch(structuredClone(p), a, j, i);
      if (a.op === 'adopt_asset') last = a.asset;
      // A committed edit and its job checkpoint become visible together.
      patchProject(p.id, { ...patch, expectedRevision: p.revision }, (updated) =>
        record(i, updated.revision, a.op),
      );
      continue;
    }
    record(i, project(p.id).revision, a.op);
  }
  const final = project(j.projectId),
    asset = last && getAsset(final, last);
  return {
    projectId: final.id,
    operations: plan.actions.map((a) => a.op),
    summary,
    ...(asset ? { assetId: asset.id, assetUrl: mediaUrl(final.id, asset.id) } : {}),
    ...(asset?.role === 'delivery' ? { deliveryUrl: mediaUrl(final.id, asset.id) } : {}),
  };
}
