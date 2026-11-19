import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Use the published SDK with a loopback wire fixture, without contacting a real provider in CI.
process.env.PPENG_AGENT_CORE_DIR = join(tmpdir(), 'no-agent-checkout-used-by-test');
const { requestCommand } = await import('./model.mjs');
test('真实 SDK 只接受已注册工具产生的受校验命令；聊天回复不能伪造完成', async (t) => {
  let requests = 0;
  let textOnly = false;
  let misplacedJson = false;
  let forcedCalls = 0;
  const server = createServer(async (req, res) => {
    const parts = [];
    for await (const p of req) parts.push(p);
    const body = JSON.parse(Buffer.concat(parts).toString());
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(body.model, 'studio-test');
    requests++;
    if (body.tool_choice?.type === 'function') {
      assert.equal(body.tool_choice.function.name, 'write_shot');
      forcedCalls++;
    }
    const afterTool = body.messages.some((m) => m.role === 'tool');
    const calls = [
      {
        id: 'call-' + requests,
        type: 'function',
        function: { name: 'write_shot', arguments: '{"title":"屋檐"}' },
      },
    ];
    const corrected = body.messages.some((m) => JSON.stringify(m.content).includes('工具通道'));
    const message =
      misplacedJson && !corrected
        ? { role: 'assistant', content: '{"title":"屋檐"}' }
        : afterTool || textOnly
          ? { role: 'assistant', content: '完成' }
          : { role: 'assistant', tool_calls: calls, content: null };
    if (body.stream) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const delta = message.tool_calls
        ? { role: 'assistant', tool_calls: calls.map((x) => ({ ...x, index: 0 })) }
        : { role: 'assistant', content: message.content };
      for (const choice of [
        { index: 0, delta, finish_reason: null },
        { index: 0, delta: {}, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' },
      ])
        res.write('data: ' + JSON.stringify({ choices: [choice] }) + '\n\n');
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(
      JSON.stringify({
        choices: [{ index: 0, message, finish_reason: message.tool_calls ? 'tool_calls' : 'stop' }],
      }),
    );
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  process.env.STUDIO_TEXT_BASE_URL = 'http://127.0.0.1:' + server.address().port + '/v1';
  process.env.STUDIO_TEXT_MODEL = 'studio-test';
  const task = {
    name: 'write_shot',
    description: 'write shot title',
    schema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    task: '请写镜名。',
    validate: (a) => {
      assert.equal(a.title, '屋檐');
      return a;
    },
  };
  const valid = await requestCommand(task);
  assert.equal(valid.command.title, '屋檐');
  assert.equal(valid.model, 'studio-test');
  assert.equal(valid.tool, 'write_shot');
  assert.ok(requests >= 1);
  misplacedJson = true;
  const events = [];
  const fixed = await requestCommand({ ...task, onEvent: (e) => events.push(e.type) });
  assert.equal(fixed.command.title, '屋檐');
  assert.equal(forcedCalls, 1);
  assert.deepEqual(
    events.filter((e) => e === 'tool_resubmission' || e === 'tool'),
    ['tool_resubmission', 'tool'],
  );
  misplacedJson = false;
  textOnly = true;
  await assert.rejects(() => requestCommand(task), /未成功调用/);
});
