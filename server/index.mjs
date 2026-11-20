import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { stat, realpath } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import {
  root,
  project,
  publicProject,
  allProjects,
  projectSummaries,
  jobSummaries,
  createProject,
  patchProject,
  share,
  revoke,
  getAsset,
  jobs,
  job,
  publicJob,
  now,
  must,
  failure,
} from './store.mjs';
import { enqueue, retry, recoverQueue } from './pipeline.mjs';
import { localPath, upload } from './media.mjs';
import { prepareDirectorRequest } from './director-files.mjs';
import { modelHealth } from './model.mjs';
import { listProviders } from '../providers/catalog.mjs';

const port = Number(process.env.PORT || process.env.STUDIO_PORT || 4327),
  host = '127.0.0.1',
  web = resolve(root, 'web');
const types = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};
function json(res, code, value) {
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(value));
}
async function body(req) {
  must(req.headers['content-type']?.split(';')[0] === 'application/json', '只接受 JSON 请求。', 415);
  let length = 0;
  const chunks = [];
  for await (const chunk of req) {
    length += chunk.length;
    must(length <= 35 * 1024 * 1024, '请求超过大小上限', 413);
    chunks.push(chunk);
  }
  let result;
  try {
    result = JSON.parse(Buffer.concat(chunks).toString());
  } catch {
    throw failure('JSON 格式错误');
  }
  must(result !== null && typeof result === 'object' && !Array.isArray(result), '请求格式错误');
  return result;
}
async function serve(req, res, path, type, privateMedia = false) {
  let s;
  try {
    s = await stat(path);
  } catch {
    throw failure('文件不存在', 404);
  }
  must(s.isFile(), '文件不存在', 404);
  const h = {
    'content-type': type || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'accept-ranges': 'bytes',
    'cache-control': privateMedia ? 'private, no-store' : 'no-cache',
  };
  let from = 0,
    to = s.size - 1,
    status = 200;
  const range = req.headers.range;
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (!m || (!m[1] && !m[2])) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + s.size });
      return res.end();
    }
    if (!m[1]) {
      from = Math.max(0, s.size - Number(m[2]));
    } else {
      from = Number(m[1]);
      to = m[2] ? Math.min(Number(m[2]), to) : to;
    }
    if (from > to || from >= s.size) {
      res.writeHead(416, { 'Content-Range': 'bytes */' + s.size });
      return res.end();
    }
    status = 206;
    h['content-range'] = 'bytes ' + from + '-' + to + '/' + s.size;
  }
  h['content-length'] = Math.max(0, to - from + 1);
  res.writeHead(status, h);
  if (req.method === 'HEAD' || s.size === 0) return res.end();
  const file = createReadStream(path, { start: from, end: to });
  file.on('error', () => res.destroy());
  res.on('close', () => file.destroy());
  file.pipe(res);
}
async function route(req, res) {
  const allowed = new Set(['127.0.0.1:' + port, 'localhost:' + port, '[::1]:' + port]);
  must(allowed.has(req.headers.host), '不接受此主机名。', 403);
  if (req.headers.origin)
    must(
      ['http://' + req.headers.host, 'http://localhost:' + port, 'http://127.0.0.1:' + port].includes(
        req.headers.origin,
      ),
      '不同来源的请求被拒绝。',
      403,
    );
  const url = new URL(req.url, 'http://localhost'),
    path = decodeURIComponent(url.pathname),
    parts = path.split('/').filter(Boolean),
    [api, type, id, sub, x] = parts,
    method = req.method;
  if (api !== 'api') {
    must(['GET', 'HEAD'].includes(method), '方法无效', 405);
    const rel = path === '/' ? 'index.html' : path.slice(1);
    const file = resolve(web, rel);
    must(file.startsWith(web + sep), '无效路径', 403);
    let resolved;
    try {
      resolved = await realpath(file);
    } catch {
      throw failure('页面不存在', 404);
    }
    must(resolved.startsWith(web + sep), '无效静态路径', 403);
    return serve(req, res, resolved, types[extname(file)]);
  }
  if (type === 'health' && method === 'GET')
    return json(res, 200, {
      ok: true,
      status: 'ok',
      time: now(),
      agent: await modelHealth(),
      media: 'local',
      providers: listProviders(),
    });
  if (type === 'providers' && method === 'GET') return json(res, 200, { providers: listProviders() });
  if (type === 'projects') {
    if (!id) {
      if (method === 'GET')
        return json(res, 200, {
          projects:
            url.searchParams.get('summary') === '1' ? projectSummaries() : allProjects().map(publicProject),
        });
      if (method === 'POST')
        return json(res, 201, { project: publicProject(createProject(await body(req))) });
    }
    if (!sub && id) {
      if (method === 'GET') return json(res, 200, { project: publicProject(project(id)) });
      if (method === 'PATCH')
        return json(res, 200, { project: publicProject(patchProject(id, await body(req))) });
    }
    if (sub === 'assets' && method === 'POST') {
      const a = await upload(id, await body(req)),
        p = publicProject(project(id));
      return json(res, 201, { asset: p.assets.find((x) => x.id === a.id), project: p });
    }
    if (sub === 'share' && method === 'POST') return json(res, 201, { grant: share(id, await body(req)) });
    if (sub === 'share' && method === 'DELETE' && x) return json(res, 200, { grant: revoke(id, x) });
    if (sub === 'media' && x && ['GET', 'HEAD'].includes(method)) {
      const a = getAsset(project(id), x);
      if (url.searchParams.has('download'))
        res.setHeader(
          'content-disposition',
          "attachment; filename*=UTF-8''" + encodeURIComponent(a.title + extname(a.file)),
        );
      return serve(req, res, localPath(a), a.mime, true);
    }
  }
  if (type === 'jobs') {
    if (!id && method === 'POST') return json(res, 202, { job: enqueue(await prepareDirectorRequest(await body(req))) });
    if (!id && method === 'GET') {
      const pid = url.searchParams.get('projectId');
      if (url.searchParams.get('summary') === '1') {
        const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') || 100)));
        must(Number.isInteger(limit), '无效的数量');
        return json(res, 200, { jobs: jobSummaries(pid, limit) });
      }
      return json(res, 200, {
        jobs: jobs()
          .filter((j) => !pid || j.projectId === pid)
          .map(publicJob),
      });
    }
    if (id && !sub && method === 'GET') return json(res, 200, { job: publicJob(job(id)) });
    if (id && sub === 'retry' && method === 'POST') return json(res, 202, { job: retry(id) });
  }
  throw failure('接口不存在', 404);
}
const server = createServer((req, res) => {
  route(req, res).catch((e) => {
    if (res.headersSent) return res.destroy();
    const code = e.status || 500;
    json(res, code, { error: e.message || '服务处理失败' });
  });
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? '端口已占用，请选择其他 STUDIO_PORT。' : e.message);
  process.exit(1);
});
server.listen(port, host, () => {
  recoverQueue();
  console.log('叠映工作台 http://' + host + ':' + port);
});
