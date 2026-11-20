import { createHash } from 'node:crypto';
import { requestCommand } from './model.mjs';
import { generateMedia, exportSequence, chooseInputs } from './media.mjs';
import {
  addJob,
  job,
  jobs,
  saveJob,
  publicJob,
  createProject,
  patchProject,
  project,
  getAsset,
  mediaUrl,
  must,
  str,
  list,
  uid,
  now,
  transaction,
  afterCommit,
} from './store.mjs';

const S = { type: 'string' };
const obj = (props) => ({
  type: 'object',
  required: Object.keys(props),
  additionalProperties: false,
  properties: props,
});
const arr = (items) => ({ type: 'array', items });
const fingerprints = (x) => createHash('sha256').update(JSON.stringify(x)).digest('hex');
const validKinds = new Set(['command', 'agent', 'outline', 'script', 'image', 'edit', 'video', 'export']);
const active = new Set();
export function enqueue(body) {
  must(body && typeof body === 'object' && validKinds.has(body.kind), '无效任务类型');
  if (body.projectId != null) {
    str(body.projectId, 120, '项目标识');
    project(body.projectId);
  } else must(['agent', 'command'].includes(body.kind), '此任务需要一个项目');
  if (body.prompt !== undefined) str(body.prompt, 24000, '提示词', true);
  if (body.brief !== undefined) str(body.brief, 18000, '简报', true);
  if (body.name !== undefined) str(body.name, 120, '项目名', true);
  if (body.chapters != null)
    must(Number.isInteger(body.chapters) && body.chapters >= 1 && body.chapters <= 12, '单次可制作 1–12 章');
  if (body.kind === 'command') must(body.prompt?.trim(), '请填写导演委托内容');
  if (body.kind === 'agent' && !body.projectId)
    must(body.brief?.trim() || body.prompt?.trim(), '请填写创作委托');
  if (['image', 'edit', 'video'].includes(body.kind)) chooseInputs(project(body.projectId), body);
  const { j, created } = addJob(body);
  if (created) afterCommit(() => setImmediate(() => execute(j.id)));
  return publicJob(j);
}
export function recoverQueue() {
  for (const j of jobs()) {
    if (j.status === 'running') {
      j.status = 'interrupted';
      j.error = '服务重启。已生成的素材与提交的创作决策已保存，可从断点继续。';
      saveJob(j);
    }
    if (j.status === 'queued') setImmediate(() => execute(j.id));
  }
}
export function retry(id) {
  const j = job(id);
  must(['failed', 'interrupted'].includes(j.status), '只有失败或中断的任务可以重试。', 409);
  j.status = 'queued';
  delete j.error;
  saveJob(j);
  afterCommit(() => setImmediate(() => execute(id)));
  return publicJob(j);
}
function setup(j) {
  const emit = (stage, detail = {}) => {
    j.stage = stage;
    j.events.push({ at: now(), stage, ...detail });
    saveJob(j);
  };
  return {
    emit,
    async command(key, spec) {
      j.checkpointInputs ??= {};
      const inputHash = fingerprints(spec.task);
      if (j.checkpoints[key] && (spec.immutable || j.checkpointInputs[key] === inputHash))
        return j.checkpoints[key];
      emit(key + '.directing');
      const r = await requestCommand({
        ...spec,
        onEvent: (event) => {
          if (event.type === 'tool_resubmission')
            emit(key + '.resubmitted', { tool: event.tool, sessionId: event.sessionId });
          if (event.type === 'tool')
            emit(key + '.accepted', { tool: event.tool, sessionId: event.sessionId });
        },
      });
      j.metrics.director ??= [];
      j.metrics.director.push({
        stage: key,
        model: r.model,
        sdk: r.sdk,
        sessionId: r.sessionId,
        tool: r.tool,
        seconds: r.seconds,
      });
      j.checkpoints[key] = r.command;
      j.checkpointInputs[key] = inputHash;
      saveJob(j);
      return r.command;
    },
  };
}
function chapterCount(req, p) {
  if (req.chapters) return req.chapters;
  if (p?.outline?.length) return p.outline.length;
  const m = /([1-9]\d?|一|二|两|三|四|五|六|七|八|九|十)\s*(?:个)?章/.exec(
    [req.brief, req.prompt, p?.brief].filter(Boolean).join(' '),
  );
  const n = m
    ? Number(m[1]) || { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 }[m[1]]
    : 2;
  must(n <= 12, '单次制作上限为 12 章');
  return n;
}
async function outlineStage(j, ctl) {
  let p = j.projectId ? project(j.projectId) : null;
  const r = j.request,
    n = chapterCount(r, p);
  const brief = r.brief || r.prompt || p?.brief;
  must(brief?.trim(), '请填写创作简报');
  const expected = fingerprints(p?.outline || []);
  const spec = await ctl.command('outline', {
    name: 'write_project_outline',
    description: '创建项目提案并写入指定数量的章节大纲',
    schema: obj({ name: S, outline: arr(obj({ title: S, beat: S })) }),
    task:
      '为下列用户简报制定可拍摄的电影计划，以中文调用 write_project_outline。恰好 ' +
      n +
      ' 章，每章一句具体叙事节拍，场景适合同一角色或物体的相邻多个镜头；尊重用户已有项目名。\n项目名：' +
      (r.name || p?.name || '由导演命名') +
      '\n简报：' +
      brief,
    validate: (a) => {
      const outline = list(a.outline, 12, '大纲');
      must(outline.length === n, '请恰好写 ' + n + ' 章');
      return {
        name: str(a.name, 120, '项目名'),
        outline: outline.map((o) => ({ title: str(o.title, 180, '章名'), beat: str(o.beat, 4000, '节拍') })),
      };
    },
  });
  if (!p) {
    transaction(() => {
      p = createProject({ name: r.name || spec.name, brief });
      j.projectId = p.id;
      saveJob(j);
    });
    ctl.emit('project.created', { name: p.name });
  }
  const current = project(j.projectId);
  must(fingerprints(current.outline) === expected, '生成期间大纲已修改，请重新起草。', 409);
  const rows = spec.outline.map((o, i) => ({ ...o, id: current.outline[i]?.id || uid() }));
  patchProject(current.id, { outline: rows, expectedRevision: current.revision });
  ctl.emit('outline.saved', { chapters: rows.length });
}
async function scriptStage(j, ctl) {
  const p = project(j.projectId),
    r = j.request,
    selected = r.chapterId
      ? p.outline.filter(
          (c) => c.id === r.chapterId || p.chapters.some((k) => k.id === r.chapterId && k.outlineId === c.id),
        )
      : p.outline;
  must(selected.length, '请先写大纲。');
  const expected = fingerprints([p.outline, p.chapters]);
  const spec = await ctl.command('script', {
    name: 'write_chapter_scripts',
    description: '将每章大纲展开为可编辑中文剧本及主要镜头的美术和摄影指令',
    schema: obj({
      chapters: arr(obj({ outlineId: S, title: S, text: S, shotTitle: S, imagePrompt: S, videoPrompt: S })),
    }),
    task:
      '为每一条大纲写中文场次、动作与声音（有对白才写对白，2–4句），每章一个电影镜头。imagePrompt、videoPrompt 必须是适合扩散模型的英文画面与运动指令（每项不超过65个英文词），跨章节维持同一外形、光线与美术设定。精确复制对应 outlineId，调用 write_chapter_scripts。\n简报：' +
      (r.brief || p.brief) +
      '\n大纲：' +
      JSON.stringify(selected.map((x) => ({ outlineId: x.id, title: x.title, beat: x.beat }))) +
      (r.prompt ? '\n本次要求：' + r.prompt : ''),
    validate: (a) => {
      const chapters = list(a.chapters, 12, '章节');
      must(chapters.length === selected.length, '必须覆盖全部选定章节');
      return {
        chapters: selected.map((o) => {
          const c = chapters.find((c) => c.outlineId === o.id);
          must(c, '缺少指定的 outlineId');
          return {
            outlineId: o.id,
            title: str(c.title, 180, '标题'),
            text: str(c.text, 16000, '剧本'),
            shotTitle: str(c.shotTitle, 180, '镜头标题'),
            imagePrompt: str(c.imagePrompt, 3000, '画面指令'),
            videoPrompt: str(c.videoPrompt, 3000, '运动指令'),
          };
        }),
      };
    },
  });
  const live = project(p.id);
  must(
    fingerprints([live.outline, live.chapters]) === expected,
    '生成期间大纲或剧本已修改，请以新版本重新起草。',
    409,
  );
  const chapters = structuredClone(live.chapters);
  for (const c of spec.chapters) {
    const existing = chapters.find((x) => x.outlineId === c.outlineId);
    const first = {
      id: uid(),
      title: c.shotTitle,
      prompt: c.imagePrompt,
      imagePrompt: c.imagePrompt,
      videoPrompt: c.videoPrompt,
    };
    if (existing) {
      existing.title = c.title;
      existing.text = c.text;
      if (!existing.shots.length) existing.shots = [first];
    } else chapters.push({ id: uid(), outlineId: c.outlineId, title: c.title, text: c.text, shots: [first] });
  }
  patchProject(p.id, { chapters, expectedRevision: live.revision });
  ctl.emit('script.saved', { chapters: spec.chapters.length });
}
async function produce(j, ctl) {
  const r = j.request;
  if (!j.projectId || !project(j.projectId).outline.length) await outlineStage(j, ctl);
  let p = project(j.projectId);
  if (p.outline.some((o) => !p.chapters.some((c) => c.outlineId === o.id))) await scriptStage(j, ctl);
  p = project(j.projectId);
  const flat = p.chapters.flatMap((c) =>
    c.shots.map((s) => ({ chapterId: c.id, shotId: s.id, title: s.title })),
  );
  must(flat.length > 0 && flat.length <= 24, '单次 Agent 制作可处理 1–24 个镜头');
  const plan = await ctl.command('direction', {
    name: 'produce_shots_and_assemble',
    description: '从完整的剧本 Map 选择本片的镜头顺序，指挥补齐各镜头的插图和视频，按序剪辑导出',
    schema: obj({ orderedShotIds: arr(S) }),
    task:
      '根据用户委托和剧本 Map，用 produce_shots_and_assemble 让制作端为所有镜头补图、逐镜试拍并合成成片。请按叙事顺序使用全部 shotId 各一次，精确复制，不得改写 ID。\n委托：' +
      (r.prompt || r.brief || p.brief) +
      '\n章节 / 镜头：' +
      JSON.stringify(flat) +
      '\n导演明确指定的先后关系（必须遵守）：' +
      JSON.stringify(p.storyLinks || []),
    validate: (a) => {
      const ids = list(a.orderedShotIds, 24, '镜头顺序');
      must(
        ids.length === flat.length &&
          new Set(ids).size === ids.length &&
          ids.every((id) => flat.some((s) => s.shotId === id)),
        '请精确提交当前 Map 中的所有 shotId，各一次',
      );
      must(
        (p.storyLinks || []).every((edge) => ids.indexOf(edge.from) < ids.indexOf(edge.to)),
        '请遵守导演已在 Map 指定的先后关系',
      );
      return { orderedShotIds: ids };
    },
  });
  if (!j.checkpoints.mapReady) {
    const latest = project(p.id);
    if (!latest.storyLinks.length) {
      const links = plan.orderedShotIds.slice(1).map((to, i) => ({ from: plan.orderedShotIds[i], to }));
      patchProject(p.id, { storyLinks: links, expectedRevision: latest.revision });
    }
    j.checkpoints.mapReady = true;
    ctl.emit('map.ready', { chapters: p.chapters.length, shots: flat.length });
  }
  const options = {};
  for (const key of ['width', 'height', 'frames', 'steps', 'seed', 'fps', 'video_profile', 'videoProfile'])
    if (r[key] != null) options[key] = r[key];
  const currentShot = (id) => {
    const shot = project(p.id)
      .chapters.flatMap((c) => c.shots)
      .find((s) => s.id === id);
    must(shot, '制作过程中镜头已被移除', 409);
    return shot;
  };
  // Keep one model resident through each pass on the single GPU.
  for (const [index, id] of plan.orderedShotIds.entries()) {
    const shot = currentShot(id);
    if (shot.image) continue;
    ctl.emit('illustration.requested', { shotId: id, title: shot.title });
    const a = await generateMedia(
      j,
      {
        kind: 'image',
        shotId: id,
        prompt: shot.imagePrompt || shot.prompt,
        seed: options.seed,
        ...(r.continuityAssetId ? { referenceAssetIds: [r.continuityAssetId] } : {}),
        ...(options.width ? { width: options.width } : {}),
        ...(options.height ? { height: options.height } : {}),
      },
      'image-' + index,
      ctl.emit,
    );
    ctl.emit('illustration.saved', { shotId: id, assetId: a.id, seconds: a.metrics.elapsedSeconds });
  }
  for (const [index, id] of plan.orderedShotIds.entries()) {
    const shot = currentShot(id);
    if (shot.video) continue;
    ctl.emit('video.requested', { shotId: id, title: shot.title });
    const a = await generateMedia(
      j,
      {
        kind: 'video',
        shotId: id,
        prompt: shot.videoPrompt || shot.prompt,
        mainAssetId: shot.image,
        ...options,
      },
      'video-' + index,
      ctl.emit,
    );
    ctl.emit('video.saved', { shotId: id, assetId: a.id, seconds: a.metrics.elapsedSeconds });
  }
  if (!j.checkpoints.cutReady) {
    const latest = project(p.id),
      existing = latest.sequence;
    const sequence = [...existing];
    for (const id of plan.orderedShotIds) {
      const c = latest.chapters.find((c) => c.shots.some((s) => s.id === id));
      must(c, '镜头已移除', 409);
      const s = c.shots.find((s) => s.id === id),
        a = getAsset(latest, s.video);
      if (!sequence.some((x) => x.shotId === s.id && x.assetId === a.id))
        sequence.push({
          id: uid(),
          title: s.title,
          assetId: a.id,
          chapterId: c.id,
          shotId: s.id,
          trimIn: 0,
          duration: a.duration,
        });
    }
    patchProject(p.id, { sequence, expectedRevision: latest.revision });
    j.checkpoints.cutReady = true;
    ctl.emit('cut.saved', { clips: sequence.length });
  }
  const a = await exportSequence(j, ctl.emit);
  return { assetId: a.id, projectId: p.id, deliveryUrl: mediaUrl(p.id, a.id) };
}
async function execute(id) {
  if (active.has(id)) return;
  active.add(id);
  const j = job(id);
  const t = performance.now();
  j.status = 'running';
  j.startedAt = now();
  saveJob(j);
  const ctl = setup(j);
  try {
    let a;
    if (j.kind === 'agent') j.result = await produce(j, ctl);
    else if (j.kind === 'command') {
      if (j.checkpoints.workspace_command || j.checkpoints.commandRevision !== undefined) {
        // Resume a pre-upgrade command with its immutable plan and edit receipts.
        const { applyDirectorCommand } = await import('./command-actions.mjs');
        j.result = await applyDirectorCommand(j, ctl);
      } else {
        const { directWorkspace } = await import('./director.mjs');
        j.result = await directWorkspace(j, ctl);
      }
    } else if (j.kind === 'outline') await outlineStage(j, ctl);
    else if (j.kind === 'script') await scriptStage(j, ctl);
    else if (j.kind === 'export') a = await exportSequence(j, ctl.emit);
    else a = await generateMedia(j, j.request, 'independent', ctl.emit);
    j.result ??= {
      projectId: j.projectId,
      ...(a
        ? {
            assetId: a.id,
            assetUrl: mediaUrl(j.projectId, a.id),
            ...(a.role === 'delivery' ? { deliveryUrl: mediaUrl(j.projectId, a.id) } : {}),
          }
        : {}),
    };
    j.status = 'succeeded';
    ctl.emit('complete');
  } catch (e) {
    j.status = 'failed';
    j.error = String(e.message || e)
      .replace(/(?:sk-|Bearer )[A-Za-z0-9._-]+/gi, '[redacted]')
      .slice(-1200);
    ctl.emit('failed', { message: j.error });
  } finally {
    j.finishedAt = now();
    j.metrics.elapsedSeconds = +((j.metrics.elapsedSeconds || 0) + (performance.now() - t) / 1000).toFixed(3);
    saveJob(j);
    active.delete(id);
  }
}
