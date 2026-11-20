import { createHash } from 'node:crypto';
import {
  db,
  project,
  createProject,
  projectGrants,
  getAsset,
  assetList,
  share,
  revoke,
  job,
  transaction,
  mediaUrl,
  must,
  str,
} from './store.mjs';
import { enqueue, retry } from './pipeline.mjs';
import { listProviders } from '../providers/catalog.mjs';

const writes = new Set(['project_create', 'asset_share', 'share_revoke', 'job_start', 'job_retry']);
const operations = [
  'projects_list',
  'project_read',
  'project_create',
  'project_select',
  'outline_list',
  'outline_read',
  'chapters_list',
  'chapter_read',
  'shots_list',
  'shot_read',
  'assets_list',
  'asset_read',
  'shares_list',
  'asset_share',
  'share_revoke',
  'jobs_list',
  'job_read',
  'job_retry',
  'job_start',
  'timeline_list',
  'map_list',
  'providers_list',
];
const kinds = ['agent', 'outline', 'script', 'image', 'edit', 'video', 'export'];
const string = { type: 'string' };
const integer = { type: 'integer' };
const flag = { type: 'boolean' };
const choice = (values) => ({ type: 'string', enum: values });
export const workspaceSchema = {
  type: 'object',
  required: ['op'],
  additionalProperties: false,
  properties: {
    op: choice(operations),
    projectId: string,
    targetProjectId: string,
    chapterId: string,
    outlineId: string,
    shotId: string,
    assetId: string,
    grantId: string,
    jobId: string,
    name: string,
    brief: string,
    mode: choice(['reference', 'copy']),
    section: choice(['links', 'layout']),
    field: choice(['prompt', 'imagePrompt', 'videoPrompt', 'text']),
    offset: integer,
    limit: integer,
    length: integer,
    query: string,
    allProjects: flag,
    kind: choice(kinds),
    newProject: flag,
    prompt: string,
    title: string,
    provider: string,
    chapters: integer,
    mainAssetId: string,
    maskAssetId: string,
    continuityAssetId: string,
    referenceAssetIds: { type: 'array', maxItems: 6, items: string },
    allowReferenceComposition: flag,
    seed: integer,
    width: integer,
    height: integer,
    steps: integer,
    frames: integer,
    fps: { type: 'number' },
    videoProfile: choice(['standard', 'turbo']),
    exportWidth: integer,
    exportHeight: integer,
    exportFps: integer,
  },
};
export const workspaceInstructions = [
  '每次调用选择一个 op。需要 ID 时先查清单并使用返回的真实 ID；project_select 选定后续项目。projects_list 的 query 可按项目名筛选，assets_list 可按素材标题筛选。',
  '项目内操作可传 projectId，默认当前项目。project_create 传 name、可选 brief，返回新项目。project_read 返回简报。outline_list/chapters_list/shots_list/assets_list/shares_list/timeline_list 各自列出对象；shots_list 可选 chapterId。map_list 用 section=links 或 layout 读串联或显式节点位置。',
  '清单用 offset/limit 翻页，返回 items 与 nextOffset。完整文字用 offset/length，连续读取 text 直到 nextOffset 为空。chapter_read 传 chapterId 读完整正文；outline_read 传 outlineId；shot_read 传 shotId 并用 field=prompt/imagePrompt/videoPrompt；asset_read 传 assetId 读素材参数、授权地址和分页生成指令。',
  'asset_share 传（来源）projectId、assetId、targetProjectId、mode=reference 或 copy。share_revoke 传来源 projectId 和 shares_list 返回的 grantId，只撤销引用。仅按明确的目标项目与共享方式执行。',
  'jobs_list 默认为当前项目，可用 allProjects=true 查看整个工作室。job_read/job_retry 传 jobId，读取任务或重试失败、中断的制作和导演任务。不能重试当前任务、祖先或正在执行的任务，也不能派生新的自由导演任务。providers_list 返回真实配置状态。',
  'job_start 传 kind。agent 是从简报到成片，若要独立新建项目加 newProject=true、brief、可选 name/chapters；新建空工程再制作则直接指定其 projectId。outline 重写大纲；script 可用 chapterId 单独生成；image/edit/video 可传 title、prompt、mainAssetId、maskAssetId、referenceAssetIds、shotId；export 从当前时间线导出。默认用本地 4090，有明确要求可选择已配置的 provider。可选 seed/width/height/steps、视频 frames/fps/videoProfile、导出 exportWidth/exportHeight、完整制片 continuityAssetId。',
  'job_start/job_retry 返回 jobId 及提交时的状态，尚未完成的提交不能当成成片、素材或成功结果。读取真实任务状态和产物。返回的素材地址按项目授权。',
].join('\n');

// The receipt is committed in the same SQLite transaction as its effects, even
// if the director process stops before it can save the next model observation.
db.exec(`CREATE TABLE IF NOT EXISTS workspace_receipts (
  action_key TEXT PRIMARY KEY, signature TEXT NOT NULL, result TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workspace_retry_parents (child TEXT PRIMARY KEY, parent TEXT NOT NULL);`);

function jobParents(id) {
  const creation = db
    .prepare("SELECT json_extract(body,'$.request.parentJobId') AS parent FROM jobs WHERE id=?")
    .get(id);
  const resumed = db.prepare('SELECT parent FROM workspace_retry_parents WHERE child=?').get(id);
  return [creation?.parent, resumed?.parent].filter(Boolean);
}
export function isWorkspaceChild(childId, parentId) {
  return jobParents(childId).includes(parentId);
}
function checkRetryLineage(source, target) {
  let level = [source];
  const seen = new Set();
  for (let depth = 0; level.length; depth++) {
    must(depth < 12 && seen.size <= 128, '导演重试链过长，无法继续委托');
    const parents = new Set();
    for (const id of level) {
      must(id !== target, '不能重试自己或正在等待自己的祖先任务');
      if (seen.has(id)) continue;
      seen.add(id);
      for (const parent of jobParents(id)) parents.add(parent);
    }
    level = [...parents];
  }
}

function validate(a) {
  must(a && typeof a === 'object' && operations.includes(a.op), '未知工作室操作');
  for (const [key, value] of Object.entries(a)) {
    const rule = workspaceSchema.properties[key];
    must(rule, '未知参数 ' + key);
    if (rule.enum) must(rule.enum.includes(value), key + ' 参数无效');
    else if (rule.type === 'integer') must(Number.isSafeInteger(value), key + ' 应为整数');
    else if (rule.type === 'array')
      must(
        Array.isArray(value) && value.length <= 6 && value.every((v) => typeof v === 'string'),
        '参考图列表无效',
      );
    else must(typeof value === rule.type, key + ' 参数类型无效');
  }
}
function int(n, fallback, min, max, label) {
  const value = n ?? fallback;
  must(Number.isSafeInteger(value) && value >= min && value <= max, label + ' 超出范围');
  return value;
}
function pager(a) {
  return {
    offset: int(a.offset, 0, 0, Number.MAX_SAFE_INTEGER, '起始位置'),
    limit: int(a.limit, 12, 1, 50, '页大小'),
  };
}
function resultPage(items, total, offset) {
  return { items, total, nextOffset: offset + items.length < total ? offset + items.length : null };
}
function page(rows, a, format = (x) => x) {
  const { offset, limit } = pager(a);
  return resultPage(rows.slice(offset, offset + limit).map(format), rows.length, offset);
}
function textPage(text, a) {
  const offset = int(a.offset, 0, 0, Number.MAX_SAFE_INTEGER, '文字起点');
  const length = int(a.length, 3500, 1, 8000, '文字页长');
  const value = text || '';
  return {
    text: value.slice(offset, offset + length),
    totalChars: value.length,
    nextOffset: offset + length < value.length ? offset + length : null,
  };
}
function select(rows, id, label) {
  const entry = rows.find((v) => v.id === id);
  must(entry, label + '不存在或不属于该项目', 404);
  return entry;
}
function compactAsset(a) {
  return {
    id: a.id,
    title: a.title,
    kind: a.kind,
    role: a.role,
    origin: a.origin,
    shared: !!a.shared,
    sourceProjectId: a.sourceProjectId,
  };
}
function jobInfo(j) {
  return {
    jobId: j.id,
    kind: j.kind,
    projectId: j.projectId,
    status: j.status,
    stage: j.stage,
    parentJobId: j.request?.parentJobId,
    error: j.error || undefined,
    finished: ['succeeded', 'failed', 'interrupted'].includes(j.status),
    succeeded: j.status === 'succeeded',
  };
}
function readProjects(a) {
  const { offset, limit } = pager(a);
  const query = a.query?.trim() || '';
  const where = 'WHERE instr(lower(name), lower(?)) > 0';
  const total = db.prepare('SELECT count(*) AS n FROM project_directory ' + where).get(query).n;
  const rows = db
    .prepare(
      `SELECT id,name,revision,chapterCount,shotCount,updatedAt FROM project_directory
    ${where} ORDER BY updatedAt DESC, id LIMIT ? OFFSET ?`,
    )
    .all(query, limit, offset);
  return resultPage(rows, total, offset);
}
function readJobs(a, projectId) {
  const { offset, limit } = pager(a);
  const filter = !a.allProjects && projectId ? "WHERE json_extract(body,'$.projectId')=?" : '';
  const bindings = filter ? [projectId] : [];
  const total = db.prepare('SELECT count(*) AS n FROM jobs ' + filter).get(...bindings).n;
  const rows = db
    .prepare(
      `SELECT id AS jobId, json_extract(body,'$.kind') AS kind,
    json_extract(body,'$.projectId') AS projectId, json_extract(body,'$.status') AS status,
    json_extract(body,'$.stage') AS stage, json_extract(body,'$.createdAt') AS createdAt
    FROM jobs ${filter} ORDER BY rowid DESC LIMIT ? OFFSET ?`,
    )
    .all(...bindings, limit, offset);
  return resultPage(rows, total, offset);
}
function jobResult(j) {
  if (!j.result) return undefined;
  const { assetId, projectId, assetUrl, deliveryUrl, summary } = j.result;
  return { assetId, projectId, assetUrl, deliveryUrl, summary: summary?.slice(0, 4000) };
}
function readWorkspace(a, projectId) {
  if (a.op === 'projects_list') return readProjects(a);
  if (a.op === 'jobs_list') return readJobs(a, projectId);
  if (a.op === 'providers_list') return { providers: listProviders() };
  if (a.op === 'job_read') {
    const j = job(str(a.jobId, 120, '任务 ID'));
    must(!a.projectId || a.projectId === j.projectId, '任务不属于指定项目', 404);
    return {
      ...jobInfo(j),
      result: jobResult(j),
      elapsedSeconds: j.metrics?.elapsedSeconds,
      events: page(j.events, a, ({ at, stage, detail, operation, message }) => ({
        at,
        stage,
        detail,
        operation,
        message,
      })),
    };
  }
  must(projectId, '请先选择项目');
  const p = project(projectId);
  switch (a.op) {
    case 'project_read':
    case 'project_select':
      return {
        projectId: p.id,
        name: p.name,
        revision: p.revision,
        chapterCount: p.chapters.length,
        shotCount: p.chapters.reduce((sum, c) => sum + c.shots.length, 0),
        clipCount: p.sequence.length,
        ...textPage(p.brief, a),
      };
    case 'outline_list':
      return page(p.outline, a, ({ id, title, beat }) => ({ id, title, excerpt: beat.slice(0, 160) }));
    case 'outline_read': {
      const o = select(p.outline, a.outlineId, '大纲章节');
      return { id: o.id, title: o.title, ...textPage(o.beat, a) };
    }
    case 'chapters_list':
      return page(p.chapters, a, (c) => ({
        id: c.id,
        title: c.title,
        outlineId: c.outlineId,
        shotCount: c.shots.length,
      }));
    case 'chapter_read': {
      const c = select(p.chapters, a.chapterId, '剧本章节');
      return {
        id: c.id,
        title: c.title,
        outlineId: c.outlineId,
        shotCount: c.shots.length,
        ...textPage(c.text, a),
      };
    }
    case 'shots_list': {
      const chapters = a.chapterId ? [select(p.chapters, a.chapterId, '剧本章节')] : p.chapters;
      return page(
        chapters.flatMap((c) =>
          c.shots.map((s) => ({ id: s.id, chapterId: c.id, title: s.title, image: s.image, video: s.video })),
        ),
        a,
      );
    }
    case 'shot_read': {
      const c = p.chapters.find((chapter) => chapter.shots.some((s) => s.id === a.shotId));
      must(c, '镜头不存在或不属于该项目', 404);
      const s = c.shots.find((shot) => shot.id === a.shotId);
      const field = a.field || 'prompt';
      must(['prompt', 'imagePrompt', 'videoPrompt'].includes(field), '请选择镜头指令字段');
      return {
        id: s.id,
        title: s.title,
        chapterId: c.id,
        image: s.image,
        video: s.video,
        field,
        ...textPage(s[field], a),
      };
    }
    case 'assets_list': {
      const needle = a.query?.trim().toLowerCase();
      const assets = assetList(p);
      return page(
        needle ? assets.filter((m) => m.title?.toLowerCase().includes(needle)) : assets,
        a,
        compactAsset,
      );
    }
    case 'asset_read': {
      const m = getAsset(p, str(a.assetId, 120, '素材 ID'));
      const { width, height, duration, frames, sha256, provider, shotId, jobId, copiedFrom, inputRefs } = m;
      return {
        ...compactAsset(m),
        width,
        height,
        duration,
        frames,
        sha256,
        provider,
        shotId,
        jobId,
        copiedFrom,
        url: mediaUrl(p.id, m.id),
        mainAssetId: inputRefs?.main,
        maskAssetId: inputRefs?.mask,
        referenceAssetIds: inputRefs?.refs,
        ...textPage(inputRefs?.text, a),
      };
    }
    case 'shares_list':
      return page(projectGrants(p.id), a);
    case 'timeline_list':
      return page(p.sequence, a);
    case 'map_list':
      return page(
        a.section === 'layout'
          ? Object.entries(p.mapLayout).map(([id, pos]) => ({ id, ...pos }))
          : p.storyLinks,
        a,
      );
    default:
      throw Error('未知读取操作');
  }
}
const jobFields = [
  'kind',
  'name',
  'brief',
  'prompt',
  'title',
  'chapters',
  'chapterId',
  'shotId',
  'continuityAssetId',
  'mainAssetId',
  'maskAssetId',
  'referenceAssetIds',
  'provider',
  'allowReferenceComposition',
  'seed',
  'width',
  'height',
  'steps',
  'frames',
  'fps',
  'videoProfile',
  'exportWidth',
  'exportHeight',
  'exportFps',
];
function writeWorkspace(a, projectId, ctx) {
  if (a.op === 'project_create') {
    const p = createProject({ name: a.name, brief: a.brief });
    return { projectId: p.id, name: p.name, revision: p.revision };
  }
  if (a.op === 'job_start') {
    must(kinds.includes(a.kind), '不支持此子任务类型');
    must(!a.newProject || a.kind === 'agent', '只有完整制片支持在子任务内创建项目');
    const dest = a.newProject ? null : projectId;
    must(dest || a.kind === 'agent', '此任务需要先选择项目');
    if (a.provider) {
      const kind = a.kind === 'image' && a.mainAssetId ? 'edit' : a.kind;
      const provider = listProviders().find((p) => p.id === a.provider);
      must(
        provider?.configured &&
          ((a.provider === 'local' && a.kind === 'agent') || provider.kinds.includes(kind)),
        '供应商未配置或不支持该任务类型',
      );
    }
    const request = Object.fromEntries(jobFields.filter((k) => a[k] !== undefined).map((k) => [k, a[k]]));
    const key = createHash('sha256')
      .update(JSON.stringify([ctx.parentJobId, ctx.actionKey]))
      .digest('hex');
    const submitted = enqueue({
      ...request,
      ...(dest ? { projectId: dest } : {}),
      parentJobId: ctx.parentJobId,
      idempotencyKey: 'director-' + key,
    });
    return { ...jobInfo(job(submitted.id)), submitted: true };
  }
  if (a.op === 'job_retry') {
    const j = job(str(a.jobId, 120, '任务 ID'));
    must(!a.projectId || a.projectId === j.projectId, '任务不属于指定项目', 404);
    checkRetryLineage(ctx.parentJobId, j.id);
    retry(j.id);
    db.prepare(
      'INSERT INTO workspace_retry_parents(child,parent) VALUES (?,?) ON CONFLICT(child) DO UPDATE SET parent=excluded.parent',
    ).run(j.id, ctx.parentJobId);
    return { ...jobInfo(job(j.id)), submitted: true };
  }
  must(projectId, '请指定素材所属项目');
  if (a.op === 'asset_share') {
    const grant = share(projectId, {
      assetId: str(a.assetId, 120, '素材 ID'),
      targetProjectId: str(a.targetProjectId, 120, '目标项目 ID'),
      mode: a.mode,
    });
    return { ...grant, grantId: grant.mode === 'reference' ? grant.id : undefined };
  }
  if (a.op === 'share_revoke') {
    const g = revoke(projectId, str(a.grantId, 120, '授权 ID'));
    return {
      grantId: g.id,
      assetId: g.assetId,
      sourceProjectId: g.sourceProjectId,
      targetProjectId: g.targetProjectId,
      revoked: true,
    };
  }
  throw Error('未知写入操作');
}
export function executeWorkspace(input, ctx = {}) {
  validate(input);
  const projectId = input.projectId || ctx.projectId || null;
  if (!writes.has(input.op)) return readWorkspace(input, projectId);
  str(ctx.actionKey, 180, '操作回执标识');
  str(ctx.parentJobId, 120, '导演任务标识');
  // Scope to the invoking director even if clients accidentally reuse a step key.
  const key = JSON.stringify([ctx.parentJobId, ctx.actionKey]);
  const signature = createHash('sha256')
    .update(
      JSON.stringify([
        ['project_create', 'job_retry'].includes(input.op) || input.newProject ? null : projectId,
        Object.entries(input).sort(([l], [r]) => l.localeCompare(r)),
      ]),
    )
    .digest('hex');
  return transaction(() => {
    const old = db.prepare('SELECT signature,result FROM workspace_receipts WHERE action_key=?').get(key);
    if (old) {
      must(old.signature === signature, '同一回执标识已对应另一操作', 409);
      return JSON.parse(old.result);
    }
    const result = JSON.stringify(writeWorkspace(input, projectId, ctx));
    db.prepare('INSERT INTO workspace_receipts VALUES (?,?,?)').run(key, signature, result);
    return JSON.parse(result);
  });
}
