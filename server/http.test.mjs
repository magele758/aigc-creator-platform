import { createServer } from 'node:net';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import assert from 'node:assert/strict';
import test from 'node:test';

test('HTTP 项目、上传、分段读取、授权撤销和同源限制', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'studio-http-'));
  const portLock = createServer().listen(0, '127.0.0.1');
  await once(portLock, 'listening');
  const port = portLock.address().port;
  await new Promise((r) => portLock.close(r));
  const proc = spawn(process.execPath, ['server/index.mjs'], {
    env: { ...process.env, STUDIO_DATA_DIR: dir, STUDIO_PORT: String(port), PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(async () => {
    if (proc.exitCode === null) {
      const end = once(proc, 'exit');
      proc.kill();
      await end;
    }
    await rm(dir, { recursive: true, force: true });
  });
  const endpoint = 'http://127.0.0.1:' + port;
  await Promise.race([
    once(proc.stdout, 'data'),
    once(proc, 'exit').then(() => {
      throw Error('启动失败');
    }),
  ]);
  const api = (url, method = 'GET', data, headers = {}) =>
    fetch(endpoint + url, {
      method,
      headers: { ...(data ? { 'content-type': 'application/json' } : {}), ...headers },
      ...(data ? { body: JSON.stringify(data) } : {}),
    });
  const a = (await (await api('/api/projects', 'POST', { name: 'A' })).json()).project,
    b = (await (await api('/api/projects', 'POST', { name: 'B' })).json()).project;
  assert.equal(
    (await api('/api/projects/' + a.id, 'PATCH', { name: '坏更新', expectedRevision: 99999 })).status,
    409,
  );
  assert.equal(
    (await api('/api/projects', 'POST', { name: '横站' }, { Origin: 'https://third-party.invalid' })).status,
    403,
  );
  assert.equal(
    (
      await api('/api/projects/' + a.id + '/assets', 'POST', {
        title: '不可解码',
        dataUrl: 'data:image/png;base64,YQ==',
      })
    ).status,
    400,
  );
  const png =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  const added = await api('/api/projects/' + a.id + '/assets', 'POST', { title: '原图', dataUrl: png });
  assert.equal(added.status, 201);
  const { asset } = await added.json();
  assert.equal(asset.kind, 'image');
  assert.equal('file' in asset, false);
  const foreign = '/api/projects/' + b.id + '/media/' + asset.id;
  assert.equal((await api(foreign)).status, 404);
  const granted = (
    await (
      await api('/api/projects/' + a.id + '/share', 'POST', {
        assetId: asset.id,
        targetProjectId: b.id,
        mode: 'reference',
      })
    ).json()
  ).grant;
  const chunk = await api(foreign, 'GET', undefined, { range: 'bytes=0-7' });
  assert.equal(chunk.status, 206);
  assert.deepEqual([...new Uint8Array(await chunk.arrayBuffer())], [137, 80, 78, 71, 13, 10, 26, 10]);
  assert.equal((await api(foreign, 'GET', undefined, { range: 'bytes=999999-' })).status, 416);
  assert.equal((await api('/api/projects/' + a.id + '/share/' + granted.id, 'DELETE')).status, 200);
  assert.equal((await api(foreign)).status, 404);
  assert.equal(
    (
      await api('/api/jobs', 'POST', {
        projectId: b.id,
        kind: 'edit',
        mainAssetId: asset.id,
        prompt: '不可用图',
      })
    ).status,
    404,
  );
});
