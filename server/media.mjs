import { spawn } from 'node:child_process';
import { mkdir, rename, rm, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { dataDir, root, uid, must, now, getAsset, project, mutateProject, failure } from './store.mjs';

function child(cmd, args, timeoutMs, onLine) {
  return new Promise((ok, no) => {
    const cp = spawn(cmd, args, { cwd: root, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '',
      err = '',
      last = '';
    const timer = setTimeout(() => {
      cp.kill('SIGTERM');
    }, timeoutMs);
    timer.unref();
    cp.stdout.on('data', (b) => {
      const text = b.toString();
      out = (out + text).slice(-500000);
      last += text;
      const lines = last.split('\n');
      last = lines.pop();
      for (const line of lines) onLine?.(line);
    });
    cp.stderr.on('data', (b) => {
      err = (err + b.toString()).slice(-2000);
    });
    cp.once('error', (e) => {
      clearTimeout(timer);
      no(e);
    });
    cp.once('close', (code, signal) => {
      clearTimeout(timer);
      if (code === 0) ok(out);
      else
        no(
          new Error(
            (signal ? '任务已终止 ' + signal : '执行端返回 ' + code) + ' · ' + (err || out).slice(-1000),
          ),
        );
    });
  });
}
function lastJson(s) {
  for (const line of s.trim().split('\n').reverse())
    try {
      return JSON.parse(line);
    } catch {}
  return {};
}
let gpu = Promise.resolve();
function useGpu(f) {
  const previous = gpu;
  let release;
  gpu = new Promise((r) => (release = r));
  return previous.then(f).finally(release);
}
async function inspect(path) {
  const stdout = await child(
    process.env.FFPROBE || 'ffprobe',
    [
      '-v',
      'error',
      '-show_entries',
      'format=format_name,duration:stream=codec_name,codec_type,width,height,r_frame_rate,nb_frames',
      '-of',
      'json',
      path,
    ],
    30000,
  );
  const result = JSON.parse(stdout),
    video = result.streams?.find((s) => s.codec_type === 'video');
  must(video?.width && video.height, '媒体文件不可解码');
  return {
    width: video.width,
    height: video.height,
    codec: video.codec_name,
    frames: Number(video.nb_frames) || undefined,
    duration: Number(result.format?.duration) || undefined,
    format: result.format?.format_name,
  };
}
async function hashFile(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
const objects = join(dataDir, 'objects');
export function localPath(a) {
  must(
    typeof a.file === 'string' && /^[a-z0-9-]+\.(?:png|jpe?g|webp|mp4|webm)$/i.test(a.file),
    '素材文件引用无效',
    500,
  );
  return join(objects, a.file);
}
export async function upload(pId, { title, dataUrl, role }) {
  const p = project(pId);
  must(typeof dataUrl === 'string', '请上传图片文件');
  const match = /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/=]+)$/.exec(
    dataUrl,
  );
  must(match, '支持 PNG/JPEG/WebP 和 MP4/WebM 素材');
  if (role !== undefined) must(role === 'mask' && match[1] === 'image/png', '遮罩请使用 PNG 格式。');
  const bytes = Buffer.from(match[2], 'base64');
  must(bytes.length > 0 && bytes.length <= 25 * 1024 * 1024, '素材上限为 25 MiB');
  const ext = match[1].split('/')[1].replace('jpeg', 'jpg'),
    id = uid();
  await mkdir(objects, { recursive: true });
  const file = id + '.' + ext;
  const a = {
    id,
    file,
    title: typeof title === 'string' && title.trim() ? title.trim().slice(0, 180) : '上传素材',
    origin: 'upload',
    ...(role ? { role } : {}),
    createdAt: now(),
    kind: match[1].startsWith('image/') ? 'image' : 'video',
    mime: match[1],
    version: 1,
  };
  try {
    await writeFile(localPath(a), bytes);
    let m;
    try {
      m = await inspect(localPath(a));
    } catch {
      throw failure('上传文件无法解码。');
    }
    must(m.width * m.height <= 64000000, '媒体像素超出范围');
    if (a.kind === 'image') {
      const codec = { png: 'png', jpg: 'mjpeg', webp: 'webp' }[ext];
      must(m.codec === codec, '实际文件编码与图片类型不符');
    } else {
      must(m.duration > 0, '视频时长无效');
      must(ext === 'mp4' ? m.format?.includes('mp4') : m.format?.includes('webm'), '实际封装与视频类型不符');
    }
    try {
      await child(
        process.env.FFMPEG || 'ffmpeg',
        [
          '-nostdin',
          '-xerror',
          '-v',
          'error',
          '-i',
          localPath(a),
          '-map',
          '0:v:0',
          '-frames:v',
          '1',
          '-f',
          'null',
          '-',
        ],
        30000,
      );
    } catch {
      throw failure('上传文件的首帧无法解码。');
    }
    Object.assign(a, m);
    a.sha256 = createHash('sha256').update(bytes).digest('hex');
    mutateProject(p.id, (x) => x.assets.push(a));
    return a;
  } catch (e) {
    await rm(localPath(a), { force: true });
    throw e;
  }
}
export function chooseInputs(p, req) {
  const main = req.mainAssetId ? getAsset(p, req.mainAssetId) : null,
    mask = req.maskAssetId ? getAsset(p, req.maskAssetId) : null;
  const ids = req.referenceAssetIds || [];
  must(Array.isArray(ids) && ids.length <= 6, '参考图最多 6 张');
  const refs = ids.map((id) => getAsset(p, id));
  for (const a of [main, mask, ...refs].filter(Boolean))
    must(a.kind === 'image', '主图、参考图及遮罩必须是图片');
  must(!mask || main, '遮罩须与主图一起使用');
  must(!mask || req.kind === 'edit' || (req.kind === 'image' && main), '此工序不支持局部遮罩');
  must(req.kind !== 'edit' || main, '局部修图需要主图');
  must(req.prompt?.trim() || main || refs.length, '至少提供文字、主图或参考图');
  return { main, mask, refs };
}
async function jobFolder(id) {
  const folder = join(dataDir, 'jobs', id);
  await mkdir(folder, { recursive: true });
  return folder;
}
const safeNum = (v, min, max, key) => {
  must(typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max, key + ' 超出范围');
  return v;
};
export async function generateMedia(j, req, slot, emit) {
  let p = project(j.projectId);
  const cached = p.assets.find((a) => a.jobId === j.id && a.slot === slot);
  if (cached) return cached;
  const { main, mask, refs } = chooseInputs(p, req),
    shots = p.chapters.flatMap((c) => c.shots);
  const shot = req.shotId ? shots.find((s) => s.id === req.shotId) : null;
  must(!req.shotId || shot, '镜头不存在', 404);
  const kind = req.kind === 'image' && main ? 'edit' : req.kind;
  const ext = kind === 'video' ? 'mp4' : 'png';
  const request = {
    kind,
    prompt: req.prompt?.trim() || '',
    ...(main ? { image: localPath(main) } : {}),
    ...(mask ? { mask: localPath(mask) } : {}),
    references: refs.map(localPath),
  };
  for (const [k, low, high] of [
    ['width', 32, 8192],
    ['height', 32, 8192],
    ['steps', 1, 200],
    ['frames', 1, 480],
    ['seed', 0, 2147483647],
  ])
    if (req[k] != null) request[k] = safeNum(req[k], low, high, k);
  if (req.allowReferenceComposition === true || req.allow_reference_composition === true)
    request.allow_reference_composition = true;
  if (req.fps !== undefined) request.fps = safeNum(req.fps, 4, 30, 'fps');
  if (req.video_profile !== undefined || req.videoProfile !== undefined) {
    const profile = req.video_profile ?? req.videoProfile;
    must(kind === 'video' && ['standard', 'turbo'].includes(profile), '视频质量档位无效');
    request.video_profile = profile;
  }
  const cloud = req.provider && req.provider !== 'local';
  if (cloud) {
    must(kind !== 'video', '当前云连接只支持图片');
    request.provider = req.provider;
  }
  const folder = await jobFolder(j.id),
    file = uid() + '.' + ext,
    path = join(objects, file),
    requestFile = join(folder, slot + '.request.json'),
    tmp = join(folder, slot + '.' + ext);
  await mkdir(objects, { recursive: true });
  await writeFile(requestFile, JSON.stringify(request), { mode: 0o600 });
  const queued = performance.now();
  const run = async () => {
    const start = performance.now();
    emit('media.running', {
      kind,
      shotId: shot?.id,
      slot,
      queuedSeconds: +((start - queued) / 1000).toFixed(3),
    });
    const stdout = await child(
      process.env.STUDIO_PYTHON || 'python3',
      [cloud ? 'providers/run.py' : 'workers/render.py', '--request', requestFile, '--output', tmp],
      Number(process.env.STUDIO_MEDIA_TIMEOUT_MS || 7200000),
      (line) => {
        try {
          const e = JSON.parse(line);
          if (e.stage && !e.output) emit('worker.progress', { slot, detail: String(e.stage).slice(0, 150) });
        } catch {}
      },
    );
    const result = lastJson(stdout),
      meta = await inspect(tmp);
    must((await stat(tmp)).size > 0, '模型未生成可读取的素材');
    const digest = await hashFile(tmp);
    await rename(tmp, path);
    const a = {
      id: uid(),
      file,
      title: (shot?.title || req.title || req.prompt || '独立创作').slice(0, 100),
      kind: kind === 'video' ? 'video' : 'image',
      origin: 'generation',
      provider: cloud ? req.provider : 'local',
      jobId: j.id,
      slot,
      shotId: shot?.id || null,
      createdAt: now(),
      version: 1,
      mime: kind === 'video' ? 'video/mp4' : 'image/png',
      ...meta,
      sha256: digest,
      inputRefs: {
        main: main?.id || null,
        mask: mask?.id || null,
        refs: refs.map((a) => a.id),
        text: req.prompt || '',
      },
      metrics: {
        ...result,
        elapsedSeconds: +((performance.now() - start) / 1000).toFixed(3),
        queueSeconds: +((start - queued) / 1000).toFixed(3),
      },
    };
    // Request-file and filesystem paths are private worker details.
    for (const key of ['file', 'output', 'output_path', 'path', 'request', 'command']) delete a.metrics[key];
    try {
      mutateProject(p.id, (latest) => {
        for (const input of [main, mask, ...refs].filter(Boolean)) getAsset(latest, input.id);
        if (shot) {
          const live = latest.chapters.flatMap((c) => c.shots).find((s) => s.id === shot.id);
          if (live && live.prompt === shot.prompt && live[a.kind] === shot[a.kind]) live[a.kind] = a.id;
          else a.adoptionConflict = true;
        }
        latest.assets.push(a);
      });
    } catch (e) {
      await rm(path, { force: true });
      throw e;
    }
    if (a.adoptionConflict) throw failure('镜头已修改。本次生成的候选已独立保留在项目素材库。', 409);
    return a;
  };
  return cloud ? run() : useGpu(run);
}
export async function exportSequence(j, emit) {
  const p = project(j.projectId),
    existing = p.assets.find((a) => a.jobId === j.id && a.role === 'delivery');
  if (existing) return existing;
  must(p.sequence.length, '时间线还没有视频');
  const frozen = structuredClone(p.sequence);
  const clips = frozen.map((c) => {
    const a = getAsset(p, c.assetId);
    return {
      path: localPath(a),
      assetId: a.id,
      shotId: c.shotId,
      title: c.title,
      trimIn: c.trimIn || 0,
      duration: c.duration || a.duration,
    };
  });
  const folder = await jobFolder(j.id),
    requestFile = join(folder, 'export.request.json'),
    id = uid(),
    file = id + '.mp4',
    out = join(objects, file);
  const width = j.request.exportWidth || 960,
    height = j.request.exportHeight || 540;
  safeNum(width, 32, 4096, '导出宽度');
  safeNum(height, 32, 4096, '导出高度');
  await mkdir(objects, { recursive: true });
  await writeFile(requestFile, JSON.stringify({ clips, width, height, fps: 24 }), { mode: 0o600 });
  emit('export.running', { clips: clips.length });
  const start = performance.now();
  await child(
    process.env.STUDIO_PYTHON || 'python3',
    ['media/export.py', '--request', requestFile, '--output', out],
    1800000,
  );
  const meta = await inspect(out);
  const a = {
    id,
    file,
    kind: 'video',
    role: 'delivery',
    title: p.name + ' · 成片',
    version: 1,
    origin: 'editor',
    createdAt: now(),
    jobId: j.id,
    mime: 'video/mp4',
    sequenceRevision: p.revision,
    sequence: frozen,
    ...meta,
    metrics: { elapsedSeconds: +((performance.now() - start) / 1000).toFixed(3) },
  };
  try {
    mutateProject(p.id, (latest) => {
      for (const clip of clips) getAsset(latest, clip.assetId);
      latest.assets.push(a);
    });
  } catch (e) {
    await Promise.all([rm(out, { force: true }), rm(out + '.json', { force: true })]);
    throw e;
  }
  return a;
}
