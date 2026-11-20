import { createHash } from 'node:crypto';
import { project, patchProject, assetList, saveJob, getAsset, mediaUrl, must } from './store.mjs';
import { generateMedia, exportSequence, createSelection } from './media.mjs';
import { listProviders } from '../providers/catalog.mjs';

const operations = [
  'inspect',
  'project_edit',
  'outline_add',
  'outline_remove',
  'outline_move',
  'chapter_add',
  'chapter_move',
  'chapter_remove',
  'shot_add',
  'shot_move',
  'shot_remove',
  'adopt_asset',
  'map_move',
  'map_reset',
  'outline_edit',
  'chapter_edit',
  'shot_edit',
  'link_shots',
  'unlink_shots',
  'append_chain',
  'create_mask',
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
const integer = { type: 'integer' };
const normalized = { type: 'number', minimum: 0, maximum: 1 };
const tuple = (n) => ({ type: 'array', items: normalized, minItems: n, maxItems: n });
const renderOptions = {
  width: integer,
  height: integer,
  steps: integer,
  frames: integer,
  fps: integer,
  seed: integer,
  videoProfile: { type: 'string', enum: ['standard', 'turbo'] },
  allowReferenceComposition: { type: 'boolean' },
  provider: { type: 'string', enum: listProviders().map((p) => p.id) },
};
export const studioOperationsSchema = {
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
          imagePrompt: string,
          videoPrompt: string,
          asset: string,
          mask: string,
          refs: { type: 'array', items: string },
          index: { type: 'integer' },
          start: { type: 'number' },
          duration: { type: 'number' },
          x: { type: 'number' },
          y: { type: 'number' },
          ...renderOptions,
          rect: { ...tuple(4), description: 'Normalized [left,top,right,bottom] bounds on the source.' },
          strokes: {
            type: 'array',
            maxItems: 64,
            items: {
              type: 'object',
              required: ['w', 'xy'],
              additionalProperties: false,
              properties: {
                w: { ...normalized, description: 'Brush diameter as fraction of shorter side.' },
                xy: { type: 'array', minItems: 1, maxItems: 512, items: tuple(2) },
              },
            },
          },
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
    outline: p.outline.slice(0, 12).map(({ id, title }) => ({ id, title })),
    chapters: p.chapters.slice(0, 8).map((c) => ({
      id: c.id,
      title: c.title,
      excerpt: c.text.slice(0, 360),
      shots: c.shots.slice(0, 8).map((s) => ({
        id: s.id,
        title: s.title,
        prompt: s.prompt?.slice(0, 300),
        image: s.image,
        video: s.video,
      })),
    })),
    assets: assetList(p)
      .slice(-20)
      .map((a) => ({ id: a.id, kind: a.kind, title: a.title })),
    links: p.storyLinks.slice(0, 20),
    sequence: p.sequence.slice(0, 20).map(({ id, title, assetId, trimIn, duration }) => ({
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
    mask: a.mask === '$lastMask' ? resolveTarget(a.mask) : recentAsset(a.mask, last),
    refs: a.refs?.map((id) => recentAsset(id, last)),
    target: resolveTarget(a.target),
    next: resolveTarget(a.next),
  };
}
function reorder(rows, id, index, label) {
  const row = lookup(rows, id, label);
  must(Number.isInteger(index) && index >= 1 && index <= rows.length, '目标位置从 1 开始');
  rows.splice(rows.indexOf(row), 1);
  rows.splice(index - 1, 0, row);
}
function setSplitPrompts(shot, action) {
  for (const key of ['imagePrompt', 'videoPrompt'])
    if (action[key] !== undefined) shot[key] = action[key]?.trim();
}
function planPatch(p, a, j, index) {
  const clip = () => lookup(p.sequence, a.target, '剪辑片段');
  const shots = p.chapters.flatMap((c) => c.shots);
  switch (a.op) {
    case 'project_edit': {
      const out = {};
      if (a.title?.trim()) out.name = a.title.trim();
      if (typeof a.text === 'string') out.brief = a.text.trim();
      must(Object.keys(out).length, '缺少项目名称或简报');
      return out;
    }
    case 'outline_remove':
      lookup(p.outline, a.target, '大纲节拍');
      return { outline: p.outline.filter((row) => row.id !== a.target) };
    case 'outline_move':
      reorder(p.outline, a.target, a.index, '大纲节拍');
      return { outline: p.outline };
    case 'chapter_move':
      reorder(p.chapters, a.target, a.index, '章节');
      return { chapters: p.chapters };
    case 'shot_move': {
      const shot = lookup(shots, a.target, '镜头');
      const chapter = p.chapters.find((c) => c.shots.includes(shot));
      if (a.next && a.next !== chapter.id) {
        const destination = lookup(p.chapters, a.next, '目标章节');
        chapter.shots.splice(chapter.shots.indexOf(shot), 1);
        insertAt(destination.shots, shot, a.index);
        for (const clip of p.sequence) if (clip.shotId === shot.id) clip.chapterId = destination.id;
        return { chapters: p.chapters, sequence: p.sequence };
      }
      reorder(chapter.shots, shot.id, a.index, '镜头');
      return { chapters: p.chapters };
    }
    case 'chapter_remove':
    case 'shot_remove': {
      const removed = new Set();
      let chapterId;
      if (a.op === 'chapter_remove') {
        const chapter = lookup(p.chapters, a.target, '章节');
        chapterId = chapter.id;
        chapter.shots.forEach((shot) => removed.add(shot.id));
        p.chapters = p.chapters.filter((c) => c !== chapter);
        delete p.mapLayout[chapter.id];
      } else {
        const shot = lookup(shots, a.target, '镜头');
        const chapter = p.chapters.find((c) => c.shots.includes(shot));
        removed.add(shot.id);
        chapter.shots = chapter.shots.filter((s) => s !== shot);
      }
      for (const id of removed) delete p.mapLayout[id];
      for (const clip of p.sequence) {
        if (removed.has(clip.shotId)) clip.shotId = null;
        if (chapterId && clip.chapterId === chapterId) clip.chapterId = null;
      }
      return {
        chapters: p.chapters,
        mapLayout: p.mapLayout,
        sequence: p.sequence,
        storyLinks: p.storyLinks.filter((link) => !removed.has(link.from) && !removed.has(link.to)),
      };
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
      const shot = { id: newTargetId(j, index, a.op), title: a.title.trim(), prompt: a.text?.trim() || '' };
      setSplitPrompts(shot, a);
      insertAt(chapter.shots, shot, a.index);
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
    case 'map_reset':
      return { mapLayout: {} };
    case 'outline_edit':
      fillText(lookup(p.outline, a.target, '大纲章节'), a, 'beat');
      return { outline: p.outline };
    case 'chapter_edit':
      fillText(lookup(p.chapters, a.target, '剧本章节'), a, 'text');
      return { chapters: p.chapters };
    case 'shot_edit': {
      const s = lookup(shots, a.target, '镜头');
      must(
        a.title?.trim() || [a.text, a.imagePrompt, a.videoPrompt].some((v) => typeof v === 'string'),
        '缺少修改后的文字',
      );
      if (a.title?.trim()) s.title = a.title.trim();
      if (typeof a.text === 'string') {
        s.prompt = a.text.trim();
        s.imagePrompt = s.prompt;
        s.videoPrompt = s.prompt;
      }
      setSplitPrompts(s, a);
      return { chapters: p.chapters };
    }
    case 'unlink_shots':
      lookup(shots, a.target, '前镜');
      return { storyLinks: p.storyLinks.filter((link) => link.from !== a.target) };
    case 'link_shots':
      lookup(shots, a.target, '前镜');
      lookup(shots, a.next, '后镜');
      return {
        storyLinks: [...p.storyLinks.filter((l) => l.from !== a.target), { from: a.target, to: a.next }],
      };
    case 'append_chain': {
      const links = new Map(p.storyLinks.map((l) => [l.from, l.to]));
      const seen = new Set();
      let shotId = lookup(shots, a.target, '起始镜头').id;
      while (shotId) {
        must(!seen.has(shotId), '镜头串联不能形成循环');
        seen.add(shotId);
        const shot = lookup(shots, shotId, '镜头');
        const chapter = p.chapters.find((c) => c.shots.includes(shot));
        must(shot.video, '镜头「' + shot.title + '」没有已绑定视频');
        const asset = getAsset(p, shot.video);
        must(asset.kind === 'video' && asset.duration > 0, '镜头缺少可剪辑视频');
        p.sequence.push({
          id: j.id + '-chain-' + index + '-' + seen.size,
          assetId: asset.id,
          shotId,
          chapterId: chapter.id,
          title: shot.title,
          trimIn: 0,
          duration: asset.duration,
        });
        shotId = links.get(shotId);
      }
      return { sequence: p.sequence };
    }
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

export const studioOperationsGuide =
  '在指定项目实际执行操作。target/next/asset 均使用查询返回的精确标识。index 是从1起的位置。' +
  'outline_add(title,text), chapter_add(title,text,target=大纲), shot_add(target=章,title,text)。' +
  '后续动作可用 $lastOutline/$lastChapter/$lastShot 指同一批内新建的对象。' +
  'outline_remove/chapter_remove/shot_remove 按 target 删除对应结构，保留媒体和已入剪的片段。' +
  'outline_move、chapter_move、shot_move 按 index 移动对象，shot_move 用 next 可移至其他章节。' +
  'outline_edit/chapter_edit/shot_edit 支持 title/text，shot_add/shot_edit 的 imagePrompt、videoPrompt 可独立设置。' +
  'map_move(target,x,y)，map_reset 恢复所有节点的自动布局；link_shots(target,next)、unlink_shots(target)。' +
  'adopt_asset(target=镜头,asset=已有图片或视频)；append_chain(target=起始镜头) 将串联镜头一次入剪。' +
  'image/edit/video 的 text 是媒体提示词，target 是可选镜头。asset 是主图或视频首帧，refs 是参考图标识。' +
  '在 create_mask 指定 asset 及 rect=[左,上,右,下] 或 strokes=[{w,xy:[[x,y],…]}]，坐标以左上为原点并归一化。' +
  '局部修图 edit 的 asset 是原图，mask 是选区素材 ID 或同批次的 $lastMask。$last 是上一步素材。' +
  'provider 支持 local、openai、google、aliyun、jimeng、selfhost，默认 local；视频使用 local。' +
  '支持 width/height、整数 seed/steps、视频 frames/fps/videoProfile(standard/turbo)。参考图构图用 allowReferenceComposition。' +
  'append_clip(asset,target=可选镜头)、move_clip(target=剪辑片段,index)、trim_clip(target,start,duration 秒)、remove_clip(target)。' +
  'export 须在批次末尾，可指定 width/height/fps。批次上限12动作和3次媒体推理。';

function validatePlan(v) {
  must(
    Array.isArray(v?.actions) && v.actions.length >= 1 && v.actions.length <= 12,
    '操作数应在 1 至 12 之间',
  );
  for (const [i, a] of v.actions.entries()) {
    must(a && operations.includes(a.op), '未知操作');
    for (const key of Object.keys(a))
      must(
        Object.hasOwn(studioOperationsSchema.properties.actions.items.properties, key),
        '未知动作参数 ' + key,
      );
    if (a.op === 'outline_add')
      must(a.title?.trim() && a.text?.trim(), 'outline_add 必须同时提交 title 和实质叙事节拍 text，请补齐。');
    if (a.op === 'chapter_add')
      must(a.title?.trim() || a.target, 'chapter_add 需要 title 或对应的大纲 target');
    if (a.op === 'shot_add') must(a.target && a.title?.trim(), 'shot_add 需要所属章节 target 和镜头 title');
    if (a.op === 'adopt_asset') must(a.target && a.asset, 'adopt_asset 需要 target 镜头和 asset 素材');
    if (a.op === 'map_move')
      must(a.target && Number.isFinite(a.x) && Number.isFinite(a.y), 'map_move 需要 target、x 和 y');
    if (a.op === 'export') must(i === v.actions.length - 1, '导出须为最后一步');
    if (a.refs) must(Array.isArray(a.refs) && a.refs.length <= 6, '参考图最多六张');
    if (a.op === 'create_mask') must(a.rect || a.strokes?.length, '绘制选区需要矩形或笔画');
    if (a.provider) {
      const provider = listProviders().find((p) => p.id === a.provider);
      must(provider?.kinds.includes(a.op), '所选执行端不支持此操作');
      must(provider.configured, '所选执行端未配置');
    }
  }
  must(
    v.actions.filter((a) => ['image', 'edit', 'video'].includes(a.op)).length <= 3,
    '单次委托最多三次媒体推理',
  );
  return { actions: v.actions };
}

export async function applyDirectorCommand(j, ctl) {
  const p = project(j.projectId);
  const request = j.request;
  const cp = j.checkpoints;
  if (cp.commandRevision === undefined) {
    cp.commandRevision = p.revision;
    saveJob(j);
  }
  const plan = await ctl.command('workspace_command', {
    immutable: true,
    name: 'apply_studio_operations',
    description: '在当前创作工程执行用户委托的编辑、独立绘图、拍摄及剪辑操作',
    schema: studioOperationsSchema,
    validate: validatePlan,
    task:
      studioOperationsGuide +
      '\n工程摘要：' +
      JSON.stringify(snapshot(p)) +
      '\n已选中：' +
      JSON.stringify({
        main: request.mainAssetId,
        mask: request.maskAssetId,
        refs: request.referenceAssetIds,
        shot: request.shotId,
      }) +
      '\n委托：' +
      request.prompt,
  });
  return executeBatch(j, p.id, plan.actions, ctl.emit, cp);
}

// Each actual tool call has its own receipts, including when the director returns to an
// earlier project. A retry of the same call reuses committed objects and generated media.
export async function runStudioOperations(
  j,
  { projectId, callId, actions, emit = () => {}, expectedRevision },
) {
  const p = project(projectId);
  must(typeof callId === 'string' && callId.length > 0 && callId.length <= 256, '缺少可重试的导演调用标识');
  const key = fingerprint(callId).slice(0, 24);
  const input = fingerprint([projectId, actions]);
  const calls = (j.checkpoints.studioCalls ??= {});
  if (calls[key]) {
    must(calls[key].input === input, '同一导演步骤已对应不同操作', 409);
    if (calls[key].result) return calls[key].result;
  } else {
    validatePlan({ actions });
    must(
      expectedRevision === undefined || expectedRevision === p.revision,
      '项目已有更新，请重新读取。',
      409,
    );
    calls[key] = { input, commandRevision: p.revision };
    saveJob(j);
  }
  const cp = calls[key];
  try {
    cp.result = await executeBatch(j, projectId, actions, emit, cp, key);
  } catch (e) {
    if (cp.commandDone?.length)
      e.studioProgress = {
        projectId,
        completed: cp.commandDone.map((i) => actions[i].op),
        created: cp.created,
      };
    throw e;
  }
  saveJob(j);
  return cp.result;
}

async function executeBatch(j, projectId, actions, emit, cp, batchKey) {
  const mediaJob = { id: j.id, projectId, request: j.request };
  const entityJob = { id: batchKey ? j.id + '-' + batchKey : j.id };
  const request = j.request.projectId === projectId ? j.request : {};
  cp.commandDone ??= [];
  cp.commandTargets ??= {};
  cp.created ??= [];
  let last = cp.commandLast;
  let summary = cp.commandSummary || '';
  function record(i, revision, a, asset) {
    cp.commandRevision = revision;
    cp.commandDone.push(i);
    cp.commandLast = last;
    cp.commandSummary = summary;
    if (newTypes[a.op]) {
      const id = newTargetId(entityJob, i, a.op);
      cp.commandTargets[aliases[newTypes[a.op]]] = id;
      cp.created.push({ kind: newTypes[a.op], id });
    }
    if (asset) {
      cp.created.push({ kind: asset.role || asset.kind, id: asset.id, title: asset.title });
      if (a.op === 'create_mask') cp.commandTargets.$lastMask = asset.id;
    }
    if (a.op === 'append_clip') cp.created.push({ kind: 'clip', id: entityJob.id + '-clip-' + i });
    saveJob(j);
  }
  for (const [i, original] of actions.entries()) {
    if (cp.commandDone.includes(i)) continue;
    const a = resolveAction(original, last, cp.commandTargets);
    const p = project(projectId);
    const slot = batchKey ? 'studio-' + batchKey + '-' + i : 'command-' + i;
    const exportSlot = batchKey ? slot : undefined;
    const saved = cp[slot];
    const cached = p.assets.find(
      (x) =>
        x.jobId === j.id &&
        (x.slot === slot || (a.op === 'export' && x.role === 'delivery' && x.slot === exportSlot)),
    );
    // Existing older job checkpoints could persist the edit separately from its receipt.
    const alreadyApplied =
      saved &&
      p.revision === saved.revision + 1 &&
      Object.entries(saved.hashes).every(([k, v]) => fingerprint(p[k]) === v);
    must(
      p.revision === cp.commandRevision || cached || alreadyApplied,
      '委托期间项目已更改，请以新的项目状态重新委托。',
      409,
    );
    emit('command.applying', { operation: a.op, step: i + 1, projectId });
    let asset;
    if (['image', 'edit', 'video'].includes(a.op)) {
      const mainAssetId = a.asset ?? request.mainAssetId;
      const selectedMask =
        a.op !== 'video' && mainAssetId === request.mainAssetId ? request.maskAssetId : undefined;
      const options = Object.fromEntries(
        Object.keys(renderOptions)
          .filter((k) => a[k] !== undefined)
          .map((k) => [k, a[k]]),
      );
      asset = await generateMedia(
        mediaJob,
        {
          allowReferenceComposition: request.allowReferenceComposition === true,
          ...options,
          kind: a.op,
          prompt: a.text ?? '',
          title: a.title,
          mainAssetId,
          maskAssetId: a.mask ?? selectedMask,
          referenceAssetIds: a.refs ?? request.referenceAssetIds ?? [],
          shotId: a.target ?? request.shotId,
        },
        slot,
        emit,
      );
      last = asset.id;
    } else if (a.op === 'create_mask') {
      asset =
        cached ||
        (await createSelection(
          mediaJob,
          a.asset || request.mainAssetId,
          { rect: a.rect, strokes: a.strokes },
          slot,
          a.title,
        ));
      last = asset.id;
    } else if (a.op === 'export') {
      asset =
        cached ||
        (await exportSequence(
          {
            ...mediaJob,
            request: {
              ...mediaJob.request,
              exportWidth: a.width ?? mediaJob.request.exportWidth,
              exportHeight: a.height ?? mediaJob.request.exportHeight,
              exportFps: a.fps ?? mediaJob.request.exportFps,
            },
          },
          emit,
          exportSlot,
        ));
      last = asset.id;
    } else if (a.op === 'inspect') {
      summary = a.text || p.name;
    } else if (!alreadyApplied) {
      const patch = planPatch(structuredClone(p), a, entityJob, i);
      if (a.op === 'adopt_asset') last = a.asset;
      patchProject(p.id, { ...patch, expectedRevision: p.revision }, (updated) =>
        record(i, updated.revision, a),
      );
      continue;
    }
    record(i, project(projectId).revision, a, asset);
  }
  const final = project(projectId);
  const asset = last && getAsset(final, last);
  return {
    projectId,
    revision: final.revision,
    created: cp.created,
    operations: actions.map((a) => a.op),
    summary,
    ...(asset ? { assetId: asset.id, assetUrl: mediaUrl(final.id, asset.id) } : {}),
    ...(asset?.role === 'delivery' ? { deliveryUrl: mediaUrl(final.id, asset.id) } : {}),
  };
}
