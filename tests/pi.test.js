import test from 'node:test';
import assert from 'node:assert/strict';
import { createJsonlDecoder, parseAssistantEvents } from '../server/pi.js';

const answer = (text = '{"requirements":[]}', stopReason = 'stop') => ({
  type: 'message_end',
  message: { role: 'assistant', stopReason, model: 'deepseek-flash', usage: { input: 23, output: 7 }, content: [{ type: 'text', text }] },
});

test('the authoritative final assistant message is parsed, excluding thinking and user content', () => {
  const final = answer('{"requirements":["禁止钻穿"]}');
  final.message.content.unshift({ type: 'thinking', thinking: 'not part of result' });
  const result = parseAssistantEvents([answer('{"old":true}'), { type: 'message_end', message: { role: 'user', content: 'ignored' } }, final]);
  assert.deepEqual(result.result, { requirements: ['禁止钻穿'] });
  assert.equal(result.model, 'deepseek-flash');
  assert.equal(result.usage.output, 7);
});

test('complete fenced JSON is accepted without repairing its contents', () => {
  assert.deepEqual(parseAssistantEvents([answer('```json\n{"requirements":[]}\n```')]).result, { requirements: [] });
  assert.throws(() => parseAssistantEvents([answer('{"requirements":[')]), /完整 JSON/);
});

test('missing, empty, and malformed assistant messages fail explicitly', () => {
  assert.throws(() => parseAssistantEvents([]), /最终 assistant/);
  assert.throws(() => parseAssistantEvents([answer('   ')]), /空结果/);
  const malformed = answer();
  malformed.message.content = 'unexpected string';
  assert.throws(() => parseAssistantEvents([malformed]), /内容格式无效/);
});

test('truncation, provider errors, aborts, and uncompleted tool turns cannot become successful results', () => {
  for (const status of ['length', 'error', 'aborted', 'toolUse', undefined]) {
    const event = answer();
    event.message.stopReason = status;
    assert.throws(() => parseAssistantEvents([answer('{"old":true}'), event]), /模型未完成/);
  }
});

test('JSONL preserves Chinese and Unicode line separators at every UTF-8 chunk boundary', () => {
  const expected = [
    { type: 'message_update', text: '铸铝件\u2028技术要求\u2029±0.02 μm' },
    answer('{"requirement":"不允许钻穿"}'),
  ];
  const bytes = Buffer.from(expected.map(e => JSON.stringify(e)).join('\r\n') + '\r\n');
  const actual = [], stream = createJsonlDecoder(e => actual.push(e));
  for (let i = 0; i < bytes.length; i++) stream.push(bytes.subarray(i, i + 1));
  stream.end();
  assert.deepEqual(actual, expected);
});

test('JSONL accepts blank lines and a complete final record without LF', () => {
  const actual = [], stream = createJsonlDecoder(e => actual.push(e));
  stream.push(Buffer.from('\n\r\n{"type":"agent_settled","aborted":false}'));
  stream.end();
  assert.deepEqual(actual, [{ type: 'agent_settled', aborted: false }]);
});

test('corrupt and truncated JSONL records fail instead of being silently skipped', () => {
  const stream = createJsonlDecoder(() => {});
  assert.throws(() => stream.push(Buffer.from('not-json\n')), /第1行不是完整 JSON/);
  const truncated = createJsonlDecoder(() => {});
  truncated.push(Buffer.from('{"type":"message_end"'));
  assert.throws(() => truncated.end(), /完整 JSON/);
});

test('JSONL requires typed event objects', () => {
  for (const line of ['null', '[]', '"string"', '{"message":"oops"}']) {
    const stream = createJsonlDecoder(() => {});
    assert.throws(() => stream.push(Buffer.from(line + '\n')), /缺少事件类型/);
  }
});
