import { createHash, randomUUID } from 'node:crypto';
import { link, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir, must, str } from './store.mjs';

const directory = join(dataDir, 'director-inputs');
const mimePattern = /^data:(image\/(?:png|jpeg|webp)|video\/(?:mp4|webm));base64,([A-Za-z0-9+/]+={0,2})$/;

// Keep binary payloads out of model context, job status responses and SQLite checkpoints.
export async function prepareDirectorRequest(body) {
  must(!Object.hasOwn(body, 'directorFiles') && !Object.hasOwn(body, 'parentJobId'), '内部任务字段不可提交');
  if (!Object.hasOwn(body, 'commandFiles')) return body;
  const { commandFiles, ...request } = body;
  must(
    request.kind === 'command' && Array.isArray(commandFiles) && commandFiles.length <= 6,
    '导演最多可接收 6 个附件',
  );
  let total = 0;
  const files = commandFiles.map((f) => {
    const match = typeof f?.dataUrl === 'string' && mimePattern.exec(f.dataUrl);
    must(match, '附件支持 PNG/JPEG/WebP 和 MP4/WebM');
    const [, mime, encoded] = match;
    must(f.role == null || (f.role === 'mask' && mime === 'image/png'), '遮罩须为 PNG');
    const bytes = Buffer.from(encoded, 'base64');
    total += bytes.length;
    must(bytes.length && total <= 25 * 1024 * 1024, '附件合计上限为 25 MiB');
    const digest = createHash('sha256').update(bytes).digest('hex');
    return {
      bytes,
      descriptor: { title: str(f.title, 180, '附件名称'), mime, digest, ...(f.role ? { role: f.role } : {}) },
    };
  });
  await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const { descriptor, bytes } of files) {
    const temp = join(directory, randomUUID() + '.tmp');
    try {
      await writeFile(temp, bytes, { flag: 'wx', mode: 0o600 });
      try {
        await link(temp, join(directory, descriptor.digest));
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    } finally {
      await unlink(temp).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    }
  }
  return { ...request, directorFiles: files.map((f) => f.descriptor) };
}

export async function selectedFile(request, index) {
  const f = request.directorFiles?.[index - 1];
  must(
    Number.isInteger(index) && index >= 1 && f && /^[a-f0-9]{64}$/.test(f.digest),
    '附件编号不在本次提交中',
  );
  const bytes = await readFile(join(directory, f.digest));
  return { title: f.title, role: f.role, dataUrl: 'data:' + f.mime + ';base64,' + bytes.toString('base64') };
}
