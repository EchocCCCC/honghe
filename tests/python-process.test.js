import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import '../server/config.js';
import { python } from '../server/python-pdf.js';
import { runProcess } from '../server/process.js';

const scriptDirectory = fileURLToPath(new URL('../skills/specification-rule-parser/scripts/', import.meta.url));
const harness = [
  'import json, sys',
  'sys.path.insert(0, sys.argv[1])',
  'from process import run_process',
  'try:',
  '    result = run_process(sys.executable, ["-X", "utf8", "-c", sys.argv[2], *json.loads(sys.argv[3])], **json.loads(sys.argv[4]))',
  'except Exception as error:',
  '    print(json.dumps({"ok": False, "kind": type(error).__name__, "message": str(error)}, ensure_ascii=False))',
  'else:',
  '    print(json.dumps({"ok": True, "result": result}, ensure_ascii=False))',
].join('\n');
const environment = { ...process.env };
for (const key of ['DEEPSEEK_API_KEY', 'OPENAI_API_KEY', 'ANTHROPIC_API_KEY']) delete environment[key];

// Run the actual Python helper and real child processes. The outer Node helper
// only captures the harness protocol; resource limits under test belong to Python.
async function executeChild(source, args = [], options = {}) {
  const { stdout, stderr } = await runProcess(python(), [
    '-X', 'utf8', '-c', harness, scriptDirectory, source, JSON.stringify(args), JSON.stringify(options),
  ], { timeout: 15000, maxBytes: 1e6, env: environment });
  assert.equal(stderr, '', 'the Python process helper must not leave reader-thread errors');
  return JSON.parse(stdout);
}

test('Python process output preserves a UTF-8 character split across its read boundary', async () => {
  const expected = 'x'.repeat(65535) + '铸铝件±0.02';
  const source = [
    'import os, time',
    'data = ("x" * 65535 + "铸铝件±0.02").encode("utf-8")',
    'os.write(1, data[:65536])',
    'time.sleep(0.02)',
    'os.write(1, data[65536:])',
  ].join('\n');
  const response = await executeChild(source);
  assert.equal(response.ok, true);
  assert.equal(response.result.stdout, expected);
  assert.equal(response.result.stderr, '');
});

test('Python process arguments retain shell metacharacters and Unicode literally', async () => {
  const literal = '图纸 $(unused) & | ; " \u00b10.1 (1)\\path\nnext line';
  const response = await executeChild('import sys; sys.stdout.buffer.write(sys.argv[1].encode("utf-8"))', [literal]);
  assert.equal(response.ok, true);
  assert.equal(response.result.stdout, literal);
});

test('Python PDF subprocesses receive stdin EOF without waiting for input', async () => {
  const response = await executeChild('import sys; data = sys.stdin.buffer.read(); sys.stdout.write("EOF received" if data == b"" else "unexpected input")', [], { timeout: 1000 });
  assert.equal(response.ok, true);
  assert.equal(response.result.stdout, 'EOF received');
});

test('Python subprocess failure preserves the diagnostic and never publishes partial stdout as success', async () => {
  const response = await executeChild('import sys; sys.stdout.write("partial candidate"); sys.stderr.write("PDF无法读取"); sys.exit(3)');
  assert.equal(response.ok, false);
  assert.equal(response.kind, 'RuntimeError');
  assert.match(response.message, /运行失败 \(3\).*PDF无法读取/);
  assert.equal(Object.hasOwn(response, 'result'), false);
});

test('Python subprocess output and runtime limits reject instead of returning partial success', async () => {
  const oversized = await executeChild('import sys; sys.stdout.write("x" * 4096); sys.stdout.flush()', [], { max_bytes: 10 });
  assert.equal(oversized.ok, false);
  assert.match(oversized.message, /输出超过限制/);
  assert.equal(Object.hasOwn(oversized, 'result'), false);
  const stalled = await executeChild('import sys, time; sys.stdout.write("partial"); sys.stdout.flush(); time.sleep(5)', [], { timeout: 80 });
  assert.equal(stalled.ok, false);
  assert.match(stalled.message, /处理超时/);
  assert.equal(Object.hasOwn(stalled, 'result'), false);
});
