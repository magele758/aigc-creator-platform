import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate as nextTurn } from 'node:timers/promises';

const dir = mkdtempSync(join(tmpdir(), 'studio-workspace-'));
process.env.STUDIO_DATA_DIR = dir;
const { executeWorkspace, isWorkspaceChild } = await import('./workspace-tools.mjs');
const { db, mutateProject, project, patchProject, transaction, job, addJob, saveJob } =
  await import('./store.mjs');
after(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});
const ctx = (actionKey, projectId) => ({ parentJobId: 'director-1', actionKey, projectId });
function create(name) {
  return executeWorkspace({ op: 'project_create', name }, ctx('create-' + name)).projectId;
}

test('工作室断点恢复复用新项目、授权、素材副本与撤销的原子回执', () => {
  const owner = create('来源'),
    dest = create('目标');
  assert.equal(create('来源'), owner);
  assert.throws(
    () => executeWorkspace({ op: 'project_create', name: '错误复用' }, ctx('create-来源')),
    /同一回执/,
  );
  mutateProject(owner, (p) =>
    p.assets.push({ id: 'img', kind: 'image', title: '红舟', file: 'private.png' }),
  );
  const grant = { op: 'asset_share', assetId: 'img', targetProjectId: dest, mode: 'reference' };
  const ref = executeWorkspace(grant, ctx('reference', owner));
  assert.deepEqual(executeWorkspace(grant, ctx('reference', owner)), ref);
  assert.equal(executeWorkspace({ op: 'shares_list', projectId: owner }).items[0].id, ref.grantId);
  const copy = { ...grant, mode: 'copy' };
  const copied = executeWorkspace(copy, ctx('copy', owner));
  assert.deepEqual(executeWorkspace(copy, ctx('copy', owner)), copied);
  const revocation = { op: 'share_revoke', grantId: ref.grantId };
  assert.equal(executeWorkspace(revocation, ctx('revoke', owner)).revoked, true);
  assert.equal(executeWorkspace(revocation, ctx('revoke', owner)).revoked, true);
  assert.equal(executeWorkspace({ op: 'assets_list', projectId: dest }).total, 1);
  assert.throws(() => executeWorkspace({ op: 'asset_read', projectId: dest, assetId: 'img' }), /权限/);
  assert.equal(
    executeWorkspace({ op: 'asset_read', projectId: dest, assetId: copied.assetId }).copiedFrom.assetId,
    'img',
  );

  db.exec(
    "CREATE TEMP TRIGGER reject_receipt BEFORE INSERT ON workspace_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
  );
  try {
    assert.throws(() => executeWorkspace(copy, ctx('failed-copy', owner)), /receipt failure/);
    assert.equal(project(dest).assets.length, 1);
  } finally {
    db.exec('DROP TRIGGER reject_receipt');
  }
});

test('嵌套写入失败只回滚内层；外层可继续，或连同子写入一起撤销', () => {
  const id = create('事务'),
    n = project(id).revision;
  transaction(() => {
    assert.throws(
      () =>
        transaction(() => {
          patchProject(id, { name: '回滚' });
          throw Error('oops');
        }),
      /oops/,
    );
    assert.equal(project(id).name, '事务');
    patchProject(id, { name: '提交' });
  });
  assert.equal(project(id).revision, n + 1);
  assert.throws(
    () =>
      transaction(() => {
        patchProject(id, { name: '取消外层' });
        throw Error('cancel');
      }),
    /cancel/,
  );
  assert.equal(project(id).name, '提交');
});

test('清单和长文本分页可完整回读，清单与素材详情不泄露运行文件路径', () => {
  const id = create('有长章节'),
    body = '夜色里的造船厂。'.repeat(3000);
  patchProject(id, {
    outline: [{ id: 'o', title: '开场', beat: '船坞场景' }],
    chapters: [
      {
        id: 'c',
        title: '夜',
        text: body,
        shots: [{ id: 's', title: '镜一', prompt: '巡航', imagePrompt: '晚霞', videoPrompt: '俯拍' }],
      },
    ],
  });
  assert.equal(executeWorkspace({ op: 'projects_list', query: '有长' }).items[0].id, id);
  assert.equal(executeWorkspace({ op: 'project_select', projectId: id }).projectId, id);
  assert.equal(executeWorkspace({ op: 'chapters_list', projectId: id }).items[0].shotCount, 1);
  let offset = 0,
    read = '';
  do {
    const r = executeWorkspace({ op: 'chapter_read', projectId: id, chapterId: 'c', offset, length: 4000 });
    read += r.text;
    offset = r.nextOffset;
  } while (offset !== null);
  assert.equal(read, body);
  assert.equal(
    executeWorkspace({ op: 'shot_read', projectId: id, shotId: 's', field: 'videoPrompt' }).text,
    '俯拍',
  );
  mutateProject(id, (p) =>
    p.assets.push({
      id: 'private',
      kind: 'image',
      title: '测试',
      file: '/secret.png',
      metrics: { token: 'secret' },
    }),
  );
  const asset = executeWorkspace({ op: 'asset_read', projectId: id, assetId: 'private' });
  assert.equal(asset.url, '/api/projects/' + id + '/media/private');
  assert.ok(!JSON.stringify(asset).includes('secret'));
  assert.throws(() => executeWorkspace({ op: 'assets_list', projectId: id, limit: 1000 }), /页大小/);
  assert.equal(executeWorkspace({ op: 'assets_list', projectId: id, query: '不存在' }).total, 0);
  assert.equal(executeWorkspace({ op: 'providers_list' }).providers[0].id, 'local');
});

test('子任务复用原任务号；明确排队、失败和重试，不复递导演命令', async () => {
  const id = create('验收队列');
  const req = { op: 'job_start', kind: 'export' };
  const queued = executeWorkspace(req, ctx('export', id));
  assert.equal(queued.submitted, true);
  assert.equal(queued.finished, false);
  assert.equal(queued.parentJobId, 'director-1');
  assert.deepEqual(executeWorkspace(req, ctx('export', id)), queued);
  assert.equal(job(queued.jobId).request.parentJobId, 'director-1');
  await nextTurn();
  const stopped = executeWorkspace({ op: 'job_read', jobId: queued.jobId });
  assert.equal(stopped.status, 'failed');
  assert.equal(stopped.succeeded, false);
  assert.equal(stopped.finished, true);
  assert.equal(stopped.request, undefined);
  assert.throws(
    () => executeWorkspace({ op: 'job_retry', projectId: 'other', jobId: queued.jobId }, ctx('wrong', id)),
    /不属于/,
  );
  const retried = executeWorkspace({ op: 'job_retry', jobId: queued.jobId }, ctx('retry', id));
  assert.equal(retried.jobId, queued.jobId);
  assert.equal(retried.status, 'queued');
  assert.deepEqual(executeWorkspace({ op: 'job_retry', jobId: queued.jobId }, ctx('retry', id)), retried);
  await nextTurn();
  assert.equal(executeWorkspace({ op: 'jobs_list', projectId: id }).total, 1);
  assert.throws(
    () => executeWorkspace({ op: 'job_start', kind: 'command' }, ctx('new-director', id)),
    /参数无效/,
  );
  assert.throws(
    () => executeWorkspace({ op: 'job_start', kind: 'video', newProject: true }, ctx('accidental', id)),
    /完整制片/,
  );
});

test('可以代理恢复独立导演任务，创建链和断点重试链都拒绝环', async () => {
  const projectId = create('导演任务恢复');
  const make = (parentJobId) => {
    const j = addJob({ kind: 'command', projectId, prompt: '查看已保存的进度', parentJobId }).j;
    j.status = 'failed';
    j.checkpoints.workspace_command = { actions: [{ op: 'inspect', text: '已恢复' }] };
    saveJob(j);
    return j.id;
  };
  const owner = make(),
    ancestor = make(),
    nested = make(ancestor),
    other = make();
  const resume = (parentJobId, jobId) =>
    executeWorkspace({ op: 'job_retry', jobId }, { parentJobId, actionKey: jobId });
  assert.throws(() => resume(owner, owner), /自己/);
  assert.throws(() => resume(nested, ancestor), /祖先/);
  const started = resume(owner, other);
  assert.equal(started.jobId, other);
  assert.equal(started.status, 'queued');
  assert.equal(isWorkspaceChild(other, owner), true);
  assert.throws(() => resume(other, owner), /祖先/);
  assert.throws(() => resume(nested, other), /只有失败/);
  const timeout = Date.now() + 3000;
  while (['queued', 'running'].includes(job(other).status) && Date.now() < timeout) await nextTurn();
  assert.equal(job(other).status, 'succeeded');
});

test('回执写入中断不调度已回滚的子任务，持久化完成后仍能重新提交', async () => {
  const id = create('子任务事务');
  const req = { op: 'job_start', kind: 'export' },
    context = ctx('before-commit', id);
  db.exec(
    "CREATE TEMP TRIGGER reject_job_receipt BEFORE INSERT ON workspace_receipts BEGIN SELECT RAISE(ABORT,'receipt failure'); END",
  );
  try {
    assert.throws(() => executeWorkspace(req, context), /receipt failure/);
    await nextTurn();
    assert.equal(executeWorkspace({ op: 'jobs_list', projectId: id }).total, 0);
  } finally {
    db.exec('DROP TRIGGER reject_job_receipt');
  }
  const a = executeWorkspace(req, context);
  const b = executeWorkspace(req, { ...context, parentJobId: 'different-director' });
  assert.notEqual(a.jobId, b.jobId);
  await nextTurn();
  assert.equal(executeWorkspace({ op: 'jobs_list', projectId: id }).total, 2);
});
