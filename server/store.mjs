import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
export const root = fileURLToPath(new URL('../', import.meta.url));
export const dataDir = resolve(process.env.STUDIO_DATA_DIR || resolve(root, '.studio-data'));
mkdirSync(dataDir, { recursive: true, mode: 0o700 });
export const db = new DatabaseSync(resolve(dataDir, 'studio.sqlite'));
db.exec(`
PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000;
CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, body TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, request_key TEXT, body TEXT NOT NULL, UNIQUE(scope,request_key));
CREATE TABLE IF NOT EXISTS grants(id TEXT PRIMARY KEY,owner TEXT NOT NULL,target TEXT NOT NULL,asset TEXT NOT NULL,body TEXT NOT NULL,UNIQUE(owner,target,asset));
CREATE INDEX IF NOT EXISTS grants_target_idx ON grants(target);
CREATE INDEX IF NOT EXISTS jobs_project_idx ON jobs(json_extract(body,'$.projectId'));
`);
// Keep the directory out of the large screenplay/asset JSON. Triggers update counts
// in the same transaction, including writes from an older process during an upgrade.
function directoryValues(row) {
  const body = row + '.body';
  return [
    row + '.id',
    ...['name', 'brief', 'revision', 'createdAt', 'updatedAt'].map((k) => `json_extract(${body},'$.${k}')`),
    `json_array_length(${body},'$.chapters')`,
    `(SELECT coalesce(sum(json_array_length(c.value,'$.shots')),0) FROM json_each(${body},'$.chapters') c)`,
    `json_array_length(${body},'$.assets')`,
    `(SELECT json_extract(a.value,'$.id') FROM json_each(${body},'$.assets') a WHERE json_extract(a.value,'$.kind')='image'
       AND coalesce(json_extract(a.value,'$.role'),'')!='mask' LIMIT 1)`,
  ].join(',');
}
db.exec(`
CREATE TABLE IF NOT EXISTS project_directory (
  id TEXT PRIMARY KEY,name TEXT,brief TEXT,revision INTEGER,createdAt TEXT,updatedAt TEXT,
  chapterCount INTEGER,shotCount INTEGER,ownedAssetCount INTEGER,coverAsset TEXT
);
CREATE INDEX IF NOT EXISTS directory_recent ON project_directory(updatedAt DESC);
CREATE TRIGGER IF NOT EXISTS directory_on_insert AFTER INSERT ON projects BEGIN
 INSERT OR REPLACE INTO project_directory SELECT ${directoryValues('new')};
END;
CREATE TRIGGER IF NOT EXISTS directory_on_update AFTER UPDATE OF body ON projects BEGIN
 INSERT OR REPLACE INTO project_directory SELECT ${directoryValues('new')};
END;
CREATE TRIGGER IF NOT EXISTS directory_on_delete AFTER DELETE ON projects BEGIN
 DELETE FROM project_directory WHERE id=old.id;
END;
INSERT OR IGNORE INTO project_directory SELECT ${directoryValues('p')} FROM projects p
WHERE NOT EXISTS(SELECT 1 FROM project_directory d WHERE d.id=p.id);
`);
export const uid = () => randomUUID();
export const now = () => new Date().toISOString();
export const failure = (message, status = 400) => Object.assign(new Error(message), { status });
export function must(test, msg, status) {
  if (!test) throw failure(msg, status);
}
export function str(x, max, field, empty = false) {
  must(typeof x === 'string' && x.length <= max && (empty || x.trim()), field + ' 格式或长度不正确');
  return x.trim();
}
export function list(x, max, field) {
  must(Array.isArray(x) && x.length <= max, field + ' 数量不正确');
  return x;
}
const commitCallbacks = [];
export function afterCommit(fn) {
  if (commitCallbacks.length) commitCallbacks.at(-1).push(fn);
  else fn();
}
export function transaction(fn) {
  const depth = commitCallbacks.length;
  const savepoint = depth ? `studio_nested_${depth}` : null;
  db.exec(savepoint ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
  const callbacks = [];
  commitCallbacks.push(callbacks);
  let value;
  try {
    value = fn();
    db.exec(savepoint ? `RELEASE ${savepoint}` : 'COMMIT');
  } catch (e) {
    if (savepoint) {
      db.exec(`ROLLBACK TO ${savepoint}`);
      db.exec(`RELEASE ${savepoint}`);
    } else db.exec('ROLLBACK');
    throw e;
  } finally {
    commitCallbacks.pop();
  }
  for (const callback of callbacks) afterCommit(callback);
  return value;
}
const rowJson = (row) => (row ? JSON.parse(row.body) : null);
export function project(id) {
  const p = rowJson(db.prepare('SELECT body FROM projects WHERE id=?').get(id));
  must(p, '项目不存在', 404);
  return p;
}
export function allProjects() {
  return db.prepare('SELECT body FROM projects ORDER BY rowid DESC').all().map(rowJson);
}
export function projectSummaries() {
  return db
    .prepare(
      `SELECT d.id,d.name,d.brief,d.revision,d.createdAt,d.updatedAt,d.chapterCount,d.shotCount,d.coverAsset,
    d.ownedAssetCount+(SELECT count(*) FROM grants g WHERE g.target=d.id) AS assetCount
    FROM project_directory d ORDER BY d.updatedAt DESC`,
    )
    .all()
    .map(({ coverAsset, ...p }) => ({ ...p, coverUrl: coverAsset ? mediaUrl(p.id, coverAsset) : null }));
}
export function createProject({ name, brief = '' }) {
  const p = {
    id: uid(),
    name: str(name, 120, '项目名'),
    brief: str(brief, 18000, '创作简报', true),
    revision: 1,
    createdAt: now(),
    updatedAt: now(),
    outline: [],
    chapters: [],
    assets: [],
    sequence: [],
    storyLinks: [],
    mapLayout: {},
    history: [],
  };
  db.prepare('INSERT INTO projects VALUES (?,?)').run(p.id, JSON.stringify(p));
  return p;
}
export function saveProject(p) {
  p.updatedAt = now();
  p.revision++;
  db.prepare('UPDATE projects SET body=? WHERE id=?').run(JSON.stringify(p), p.id);
  return p;
}
export function projectGrants(id) {
  return db.prepare('SELECT body FROM grants WHERE owner=? OR target=?').all(id, id).map(rowJson);
}
export function assetList(p) {
  return [
    ...p.assets,
    ...projectGrants(p.id)
      .filter((g) => g.targetProjectId === p.id)
      .flatMap((g) => {
        const a = project(g.sourceProjectId).assets.find((x) => x.id === g.assetId);
        return a ? [{ ...a, shared: true, grantId: g.id, sourceProjectId: g.sourceProjectId }] : [];
      }),
  ];
}
export function getAsset(p, id) {
  const a = assetList(p).find((a) => a.id === id);
  must(a, '素材不存在或该项目没有读取权限', 404);
  return a;
}
export function mediaUrl(p, id) {
  return '/api/projects/' + encodeURIComponent(p) + '/media/' + encodeURIComponent(id);
}
function visibleAsset(a, projectId) {
  const { file, ...x } = a;
  const url = mediaUrl(projectId, a.id);
  return { ...x, src: url, ...(a.kind === 'video' ? { playback: url } : {}) };
}
export function publicProject(p) {
  const { history, ...data } = p;
  return { ...data, assets: assetList(p).map((a) => visibleAsset(a, p.id)), grants: projectGrants(p.id) };
}
export function mutateProject(id, fn, expected, afterSave) {
  return transaction(() => {
    const p = project(id);
    if (expected !== undefined) must(expected === p.revision, '项目已有更新，请刷新并重新应用修改。', 409);
    fn(p);
    saveProject(p);
    afterSave?.(p);
    return p;
  });
}
function cleanId(value) {
  return str(value, 120, '标识');
}
function patchShots(shots) {
  return list(shots, 500, '镜头').map((s) => ({
    id: cleanId(s.id),
    title: str(s.title, 220, '镜头名'),
    prompt: str(s.prompt ?? '', 8000, '导演指令', true),
    ...(s.imagePrompt ? { imagePrompt: str(s.imagePrompt, 8000, '画面指令') } : {}),
    ...(s.videoPrompt ? { videoPrompt: str(s.videoPrompt, 8000, '运动指令') } : {}),
    ...(s.image ? { image: cleanId(s.image) } : {}),
    ...(s.video ? { video: cleanId(s.video) } : {}),
  }));
}
export function patchProject(id, patch, afterSave) {
  return mutateProject(
    id,
    (p) => {
      if (patch.name !== undefined) p.name = str(patch.name, 120, '项目名');
      if (patch.brief !== undefined) p.brief = str(patch.brief, 18000, '创作简报', true);
      if (patch.outline !== undefined || patch.chapters !== undefined) {
        p.history.push({ at: now(), outline: p.outline, chapters: p.chapters });
        p.history = p.history.slice(-12);
      }
      if (patch.outline !== undefined)
        p.outline = list(patch.outline, 120, '大纲').map((o) => ({
          id: cleanId(o.id),
          title: str(o.title, 220, '章节标题'),
          beat: str(o.beat, 8000, '节拍', true),
        }));
      const previousShots = new Map(p.chapters.flatMap((c) => c.shots).map((s) => [s.id, s]));
      if (patch.chapters !== undefined)
        p.chapters = list(patch.chapters, 120, '章节').map((c) => ({
          id: cleanId(c.id),
          outlineId: c.outlineId ? cleanId(c.outlineId) : null,
          title: str(c.title, 220, '章节名'),
          text: str(c.text ?? '', 100000, '剧本', true),
          shots: patchShots(c.shots || []),
        }));
      const shots = p.chapters.flatMap((c) => c.shots);
      if (patch.chapters !== undefined)
        for (const shot of shots) {
          const old = previousShots.get(shot.id);
          if (!old || old.prompt === shot.prompt) continue;
          // A user editing the common director instruction supersedes the old split prompts.
          if (!shot.imagePrompt || shot.imagePrompt === old.imagePrompt) shot.imagePrompt = shot.prompt;
          if (!shot.videoPrompt || shot.videoPrompt === old.videoPrompt) shot.videoPrompt = shot.prompt;
        }
      const ids = new Set(shots.map((s) => s.id));
      must(
        ids.size === shots.length &&
          new Set(p.chapters.map((c) => c.id)).size === p.chapters.length &&
          new Set(p.outline.map((o) => o.id)).size === p.outline.length,
        '章节或镜头标识重复',
      );
      if (patch.chapters !== undefined) {
        const assets = assetList(p);
        for (const s of shots)
          for (const k of ['image', 'video'])
            if (s[k] && previousShots.get(s.id)?.[k] !== s[k])
              must(
                assets.some((a) => a.id === s[k] && a.kind === k),
                '镜头引用了不可访问的' + k + '素材',
              );
      }
      if (patch.storyLinks !== undefined) {
        const links = list(patch.storyLinks, 500, '串联关系').map((e) => ({
          from: cleanId(e.from),
          to: cleanId(e.to),
        }));
        const next = new Map();
        for (const e of links) {
          must(ids.has(e.from) && ids.has(e.to) && !next.has(e.from), '镜头串联目标无效或有冲突');
          next.set(e.from, e.to);
        }
        for (const key of next.keys()) {
          const seen = new Set();
          let k = key;
          while (k) {
            must(!seen.has(k), '镜头串联不能形成循环');
            seen.add(k);
            k = next.get(k);
          }
        }
        p.storyLinks = links;
      }
      if (patch.mapLayout !== undefined) {
        must(
          patch.mapLayout &&
            typeof patch.mapLayout === 'object' &&
            !Array.isArray(patch.mapLayout) &&
            JSON.stringify(patch.mapLayout).length < 500000,
          '画布布局无效',
        );
        p.mapLayout = patch.mapLayout;
      }
      if (patch.sequence !== undefined) {
        const assets = assetList(p);
        p.sequence = list(patch.sequence, 500, '时间线').map((c) => {
          const a = assets.find((a) => a.id === c.assetId);
          must(a?.kind === 'video', '时间线引用了不可访问的视频');
          const trimIn = Number(c.trimIn || 0),
            duration = Number(c.duration ?? a.duration);
          must(
            Number.isFinite(trimIn) &&
              trimIn >= 0 &&
              Number.isFinite(duration) &&
              duration > 0 &&
              duration <= 86400 &&
              (!a.duration || trimIn + duration <= a.duration + 1 / 20),
            '裁切范围超过素材长度',
          );
          return {
            id: c.id ? cleanId(c.id) : uid(),
            chapterId: c.chapterId || null,
            shotId: c.shotId || null,
            assetId: a.id,
            title: str(c.title || a.title, 220, '片段名'),
            trimIn,
            duration,
          };
        });
      }
    },
    patch.expectedRevision,
    afterSave,
  );
}
export function share(owner, { assetId, targetProjectId, mode }) {
  return transaction(() => {
    must(owner !== targetProjectId, '请选择另一个目标项目');
    const from = project(owner),
      to = project(targetProjectId),
      a = from.assets.find((x) => x.id === assetId);
    must(a, '只能共享本项目拥有的素材', 404);
    if (mode === 'copy') {
      const id = uid(),
        copy = { ...a, id, origin: 'copy', createdAt: now(), copiedFrom: { projectId: owner, assetId } };
      to.assets.push(copy);
      saveProject(to);
      return { id, assetId: id, sourceProjectId: owner, targetProjectId, mode };
    }
    must(mode === 'reference', '无效共享方式');
    const old = rowJson(
      db
        .prepare('SELECT body FROM grants WHERE owner=? AND target=? AND asset=?')
        .get(owner, targetProjectId, assetId),
    );
    if (old) return old;
    const g = { id: uid(), sourceProjectId: owner, targetProjectId, assetId, mode, createdAt: now() };
    db.prepare('INSERT INTO grants VALUES (?,?,?,?,?)').run(
      g.id,
      owner,
      targetProjectId,
      assetId,
      JSON.stringify(g),
    );
    saveProject(from);
    saveProject(to);
    return g;
  });
}
export function revoke(owner, id) {
  return transaction(() => {
    const g = rowJson(db.prepare('SELECT body FROM grants WHERE id=? AND owner=?').get(id, owner));
    must(g, '授权不存在', 404);
    db.prepare('DELETE FROM grants WHERE id=?').run(id);
    saveProject(project(g.sourceProjectId));
    saveProject(project(g.targetProjectId));
    return g;
  });
}
export function job(id) {
  const j = rowJson(db.prepare('SELECT body FROM jobs WHERE id=?').get(id));
  must(j, '任务不存在', 404);
  return j;
}
export function jobs() {
  return db.prepare('SELECT body FROM jobs ORDER BY rowid DESC').all().map(rowJson);
}
export function jobSummaries(projectId, limit = 100) {
  const columns = [
    'kind',
    'projectId',
    'status',
    'stage',
    'createdAt',
    'updatedAt',
    'startedAt',
    'finishedAt',
    'error',
  ];
  const fields = columns.map((k) => `json_extract(body,'$.${k}') AS ${k}`).join(',');
  const query = `SELECT id,${fields},json_extract(body,'$.metrics.elapsedSeconds') AS elapsedSeconds,request_key AS requestId,
    json_array_length(body,'$.events') AS eventCount, json_extract(body,'$.result') AS resultJson FROM jobs ${projectId ? "WHERE json_extract(body,'$.projectId')=?" : ''} ORDER BY rowid DESC LIMIT ?`;
  return db
    .prepare(query)
    .all(...(projectId ? [projectId] : []), limit)
    .map(({ elapsedSeconds, resultJson, ...j }) => ({
      ...j,
      metrics: { elapsedSeconds },
      ...(resultJson ? { result: JSON.parse(resultJson) } : {}),
    }));
}
export function saveJob(j) {
  j.updatedAt = now();
  db.prepare('UPDATE jobs SET body=? WHERE id=?').run(JSON.stringify(j), j.id);
  return j;
}
export function publicJob(j) {
  const { request, checkpoints, checkpointInputs, ...rest } = j;
  return { ...rest, requestId: request.idempotencyKey || null };
}
function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, canonical(value[k])]),
    );
  return value;
}
export function addJob(request) {
  const scope = request.projectId || 'new',
    key = request.idempotencyKey || null;
  if (key) {
    str(key, 180, '幂等标识');
    const prev = rowJson(db.prepare('SELECT body FROM jobs WHERE scope=? AND request_key=?').get(scope, key));
    if (prev) {
      must(
        JSON.stringify(canonical(prev.request)) === JSON.stringify(canonical(request)),
        '同一幂等标识已对应不同请求',
        409,
      );
      return { j: prev, created: false };
    }
  }
  const j = {
    id: uid(),
    kind: request.kind,
    projectId: request.projectId || null,
    status: 'queued',
    stage: 'queued',
    createdAt: now(),
    updatedAt: now(),
    events: [],
    metrics: {},
    request,
    checkpoints: {},
  };
  db.prepare('INSERT INTO jobs VALUES (?,?,?,?)').run(j.id, scope, key, JSON.stringify(j));
  return { j, created: true };
}
