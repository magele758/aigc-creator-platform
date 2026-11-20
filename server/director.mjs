import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import { job, project, getAsset, mediaUrl, must, saveJob, str } from './store.mjs';
import { selectedFile } from './director-files.mjs';
import { localPath, upload } from './media.mjs';
import { runDirectorSession } from './model.mjs';
import {
  workspaceSchema,
  workspaceInstructions,
  executeWorkspace,
  isWorkspaceChild,
} from './workspace-tools.mjs';
import { studioOperationsSchema, studioOperationsGuide, runStudioOperations } from './command-actions.mjs';
import { retry } from './pipeline.mjs';

const exec = promisify(execFile);
const string = { type: 'string' };
const object = (properties, required = []) => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const pages = ['home', 'jobs', 'overview', 'outline', 'script', 'image', 'map', 'video', 'cut', 'assets'];
const themes = ['classic', 'field', 'cinema'];
// The older single-plan endpoint used model-written "inspect" text. Live direction
// has native workspace reads, so an edit can never pass prose off as an observation.
const liveEdits = structuredClone(studioOperationsSchema);
const allowedEdit = liveEdits.properties.actions.items.properties.op;
allowedEdit.enum = allowedEdit.enum.filter((op) => op !== 'inspect');

function makeView(args, current) {
  const { theme, page, projectId, chapter, shot, result, job: jobId } = args;
  must(theme || page, '需要主题或页面');
  must(!theme || themes.includes(theme), '无效主题');
  must(!page || pages.includes(page), '无效页面');
  const view = theme ? { theme } : {};
  if (!page) return view;
  view.page = page;
  if (!['home', 'jobs'].includes(page)) {
    const p = project(projectId || current);
    view.projectId = p.id;
    if (chapter) {
      must(
        p.chapters.some((c) => c.id === chapter),
        '该项目中没有此章节',
      );
      view.chapter = chapter;
    }
    if (shot) {
      must(
        p.chapters.some((c) => c.shots.some((s) => s.id === shot)),
        '该项目中没有此镜头',
      );
      view.shot = shot;
    }
    if (result) {
      getAsset(p, result);
      view.result = result;
    }
  } else if (page === 'jobs' && jobId) view.job = job(jobId).id;
  return view;
}

async function previewAsset(projectId, id, time) {
  const asset = getAsset(project(projectId), id);
  must(
    Number.isFinite(time) && time >= 0 && (asset.kind === 'video' ? time < asset.duration : time === 0),
    '抽帧时间超出素材范围',
  );
  const args = ['-nostdin', '-loglevel', 'error'];
  if (time) args.push('-ss', String(time));
  args.push(
    '-i',
    localPath(asset),
    '-map',
    '0:v:0',
    '-frames:v',
    '1',
    '-vf',
    "scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease",
    '-c:v',
    'mjpeg',
    '-f',
    'image2pipe',
    'pipe:1',
  );
  const { stdout } = await exec(process.env.FFMPEG || 'ffmpeg', args, {
    encoding: 'buffer',
    maxBuffer: 3 * 1024 * 1024,
    timeout: 30000,
  });
  must(stdout.length > 0, '无法解码预览画面');
  return 'data:image/jpeg;base64,' + stdout.toString('base64');
}

function mediaFacts(a) {
  const { id, title, kind, width, height, duration, frames, codec } = a;
  return { id, title, kind, width, height, duration, frames, codec };
}

// Check numeric clip-length claims against decoded metadata and the edit list.
// Timestamps inside a clip (e.g. “第 1 秒”) describe a position, not its duration.
function verifyVideoLength(summary, asset, p) {
  if (asset?.kind !== 'video') return;
  const seconds = [
    asset.duration,
    ...p.assets.map((a) => a.duration),
    ...p.sequence.flatMap((c) => [c.duration, c.trimIn, c.trimIn + c.duration]),
  ].filter(Number.isFinite);
  for (const m of summary.matchAll(
    /(?:时长|片长|全长|长度|裁为|裁成|保留|截取|约)\s*(?:为|是|约|共)?\s*(\d+(?:\.\d+)?)\s*(?:秒|s\b)|(\d+(?:\.\d+)?)\s*(?:秒|s\b)\s*(?:的)?(?:成片|短片|视频|镜头|片段)/gi,
  )) {
    const claim = m[1] || m[2];
    const tolerance = 0.5 / 10 ** Math.min(4, (claim.split('.')[1] || '').length) + 0.001;
    must(
      seconds.some((v) => Math.abs(v - Number(claim)) <= tolerance),
      '描述的时长与文件不符。当前交付文件实测 ' +
        asset.duration.toFixed(3) +
        ' 秒，请依据实际素材或剪辑记录修正。',
    );
  }
}

async function waitForJob(id, parent, recovery) {
  let child = job(id);
  if (recovery && child.status === 'interrupted' && isWorkspaceChild(id, parent)) retry(id);
  while (['running', 'queued'].includes((child = job(id)).status)) await delay(600);
  must(child.status === 'succeeded', '子任务 ' + id + ' ' + child.status + '：' + (child.error || '未完成'));
  const product = child.result?.assetId && getAsset(project(child.projectId), child.result.assetId);
  return {
    jobId: id,
    status: child.status,
    projectId: child.projectId,
    ...child.result,
    ...(product && { media: mediaFacts(product) }),
  };
}

export async function directWorkspace(j, { emit }, runner = runDirectorSession) {
  const state = (j.checkpoints.direction ??= { current: j.projectId, receipts: [], view: {} });
  const previews = new Map();
  const selected = j.request;
  const revisions = (state.revisions ??= {});
  const projectReads = new Set([
    'project_read',
    'project_select',
    'outline_list',
    'outline_read',
    'chapters_list',
    'chapter_read',
    'shots_list',
    'shot_read',
    'assets_list',
    'asset_read',
    'map_list',
    'timeline_list',
    'shares_list',
  ]);
  function select(id) {
    state.current = id;
    j.projectId = id;
  }
  function output() {
    if (state.finish.status === 'blocked') throw new Error(state.finish.summary);
    const projectId = state.current;
    let asset;
    if (projectId && state.product?.projectId === projectId) {
      try {
        asset = getAsset(project(projectId), state.product.assetId);
      } catch (e) {
        if (e.status !== 404) throw e;
      }
    }
    const url = asset && mediaUrl(projectId, asset.id);
    return {
      projectId,
      summary: state.finish.summary,
      operations: state.receipts.filter((r) => r.ok).flatMap((r) => r.ops),
      ...(url && {
        assetId: asset.id,
        media: mediaFacts(asset),
        assetUrl: url,
        ...(asset.role === 'delivery' && { deliveryUrl: url }),
      }),
      ...(Object.keys(state.view).length && { view: state.view }),
    };
  }
  if (state.finish?.status === 'complete') return output();
  // A retry after a blocked response can repair the cause using the earlier receipts.
  delete state.finish;
  const specs = {};
  function register(name, description, inputSchema, run) {
    specs[name] = { description, inputSchema, run };
  }
  register('workspace', workspaceInstructions, workspaceSchema, async (a, k, recovering) => {
    const result = await executeWorkspace(a, { projectId: state.current, parentJobId: j.id, actionKey: k });
    if (['project_select', 'project_create'].includes(a.op)) select(result.projectId);
    if (['job_start', 'job_retry'].includes(a.op)) {
      const child = await waitForJob(result.jobId, j.id, recovering);
      if (child.projectId) {
        select(child.projectId);
        revisions[child.projectId] = project(child.projectId).revision;
      }
      return child;
    }
    const observed = a.projectId || result.projectId || state.current;
    if (observed && (projectReads.has(a.op) || a.op === 'project_create'))
      revisions[observed] = project(observed).revision;
    if (a.op === 'asset_share' || a.op === 'share_revoke') {
      for (const id of [result.sourceProjectId, result.targetProjectId].filter(Boolean))
        revisions[id] = project(id).revision;
    }
    return result;
  });
  register(
    'edit_project',
    studioOperationsGuide + '。观察或查询请调用 workspace。',
    liveEdits,
    async (a, k) => {
      must(state.current, '请先选择或新建项目');
      must(!a.actions?.some((item) => item.op === 'inspect'), '读取项目请调用 workspace 并查阅实际结果');
      const result = await runStudioOperations(j, {
        projectId: state.current,
        callId: k,
        actions: a.actions,
        expectedRevision: revisions[state.current],
        emit,
      });
      revisions[state.current] = result.revision;
      return result;
    },
  );
  register(
    'import_attachment',
    '把本次委托所附的第 index 个文件（从1开始）导入当前项目。返回真实素材 ID。',
    object({ index: { type: 'integer' } }, ['index']),
    async (a) => {
      must(state.current, '请先选择或新建附件的目标项目');
      const asset = await upload(state.current, await selectedFile(j.request, a.index), {
        jobId: j.id,
        slot: 'attachment-' + a.index,
      });
      revisions[state.current] = project(state.current).revision;
      return { projectId: state.current, assetId: asset.id, title: asset.title, kind: asset.kind };
    },
  );
  register(
    'inspect_media',
    '实际查看当前项目图片或视频某一帧。assetId 必填；time 为视频时间（秒）。返回画面供视觉判断。',
    object({ assetId: string, time: { type: 'number' } }, ['assetId']),
    async (a, k) => {
      const time = a.time ?? 0;
      const image = await previewAsset(state.current, a.assetId, time);
      // Keep session-local previews in memory, never write them into job receipts.
      previews.set(k, image);
      return { inspectedAssetId: a.assetId, time, frame: k };
    },
  );
  register(
    'set_view',
    '按要求打开页面或设置浏览器主题。field 为 Higgsfield 荧光、cinema 为红黑、classic 为经典。',
    object({
      page: { type: 'string', enum: pages },
      theme: { type: 'string', enum: themes },
      projectId: string,
      chapter: string,
      shot: string,
      result: string,
      job: string,
    }),
    async (a) => {
      const next = makeView(a, state.current);
      if (next.page) state.view = { ...(state.view.theme && { theme: state.view.theme }), ...next };
      else Object.assign(state.view, next);
      return { view: state.view };
    },
  );
  register(
    'finish_direction',
    '提交简明中文回执，用作品名称指代对象。status 为 complete 或 blocked。采用文件回执里的时长及尺寸；交付当前项目中指定的已有素材（包括供用户下载）请传 assetId。',
    object({ status: { type: 'string', enum: ['complete', 'blocked'] }, summary: string, assetId: string }, [
      'status',
      'summary',
    ]),
    async (a) => {
      must(['complete', 'blocked'].includes(a.status), '需要明确任务状态');
      const summary = str(a.summary, 8000, '回复');
      if (a.status === 'complete')
        must(
          state.receipts.filter((r) => r.ops[0] !== 'finish_direction').at(-1)?.ok,
          '尚无成功的操作回执，或最后一步仍然失败',
        );
      // Reject identifiers invented in prose; links and delivery IDs always come from storage.
      const observed = JSON.stringify([state.current, state.receipts, selected.projectId]);
      for (const uuid of summary.match(/[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}/gi) || [])
        must(observed.includes(uuid), '回复含未观察到的标识，请改用作品名称。');
      if (
        a.status === 'complete' &&
        (a.assetId || (state.product && state.product.projectId === state.current))
      ) {
        const p = project(state.current);
        let product;
        try {
          product = getAsset(p, a.assetId || state.product.assetId);
        } catch (e) {
          if (a.assetId || e.status !== 404) throw e;
        }
        verifyVideoLength(summary, product, p);
        state.product = product ? { projectId: p.id, assetId: product.id } : null;
      }
      state.finish = { status: a.status, summary };
      return { status: a.status };
    },
  );

  async function runStep(pending, recovering = false) {
    const { name, args, key } = pending;
    const ops =
      name === 'workspace'
        ? [args.op]
        : name === 'edit_project'
          ? (args.actions || []).map((a) => a.op)
          : [name];
    emit('director.tool', { tool: name, operation: ops.join(', ') });
    let value,
      ok = true;
    try {
      value = await specs[name].run(args, key, recovering);
      if (value?.projectId && value.assetId && !value.media)
        value.media = mediaFacts(getAsset(project(value.projectId), value.assetId));
      if (value?.assetId && value.projectId)
        state.product = { projectId: value.projectId, assetId: value.assetId };
    } catch (e) {
      ok = false;
      value = {
        error: String(e.message).slice(0, 2000),
        ...(e.studioProgress && {
          applied: e.studioProgress,
          instruction: '已记录的前序更改已生效，只补做其余步骤。',
        }),
      };
    }
    state.receipts.push({ ok, ops, value });
    delete state.pending;
    saveJob(j);
    emit('director.receipt', {
      tool: name,
      operation: ops.join(', '),
      ok,
      ...(ok ? {} : { message: value.error }),
    });
    const images =
      ok && name === 'inspect_media'
        ? [{ type: 'image', assetId: key, mimeType: 'image/jpeg', alt: '项目素材抽帧' }]
        : undefined;
    return { ok, content: JSON.stringify(value), ...(images && { images }) };
  }
  if (state.pending) await runStep(state.pending, true);
  if (state.finish) return output();
  const tools = Object.entries(specs).map(([name, { description, inputSchema }]) => ({
    name,
    description,
    inputSchema,
    approvalMode: 'never',
    sideEffectLevel: 'workspace',
    async execute(_ctx, args) {
      if (state.finish) return { ok: false, content: '本次委托已结束。' };
      if (state.receipts.length >= 160 && name !== 'finish_direction')
        return { ok: false, content: '委托已到操作上限，请如实交付进度。' };
      const pending = { name, args, key: j.id + '-' + state.receipts.length };
      state.pending = pending;
      saveJob(j);
      return runStep(pending);
    },
  }));
  const context = {
    activeProject: state.current,
    originalProject: j.request.projectId || null,
    directorJob: j.id,
    selected: {
      shot: selected.shotId,
      image: selected.mainAssetId,
      mask: selected.maskAssetId,
      refs: selected.referenceAssetIds,
    },
    attachments: (selected.directorFiles || []).map(({ title, mime, role }, i) => ({
      index: i + 1,
      title,
      mime,
      role,
    })),
    previousReceipts: state.receipts
      .slice(-24)
      .map(({ ok, ops, value }) => ({ ok, ops, result: JSON.stringify(value).slice(0, 1400) })),
  };
  await runner({
    tools,
    task: '当前工作区及已实际完成的动作：' + JSON.stringify(context) + '\n用户委托：' + selected.prompt,
    isFinished: () => !!state.finish,
    resolveImageDataUrl: async (id) => previews.get(id),
    onStart(metadata) {
      j.metrics.director ??= [];
      j.metrics.director.push(metadata);
      saveJob(j);
    },
  });
  must(state.finish, '导演未提交最终回执');
  return output();
}
