import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runProcess } from '../server/process.js';

test('process output preserves characters emitted across separate UTF-8 writes', async () => {
  const script = 'const b=Buffer.from("铸铝件±0.02"); for (const x of b) { process.stdout.write(Buffer.from([x])); await new Promise(r=>setTimeout(r,4)); }';
  const { stdout } = await runProcess(process.execPath, ['--input-type=module', '-e', script]);
  assert.equal(stdout, '铸铝件±0.02');
});

test('process arguments containing shell syntax are passed as literal data', async () => {
  const literal = '图纸 $(unused) & | ; " ±0.1';
  const { stdout } = await runProcess(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', literal]);
  assert.equal(stdout, literal);
});

test('noninteractive child receives stdin EOF before it begins work', async () => {
  // This mirrors Pi print mode, which consumes piped stdin before its prompt.
  const script = 'process.stdin.resume(); process.stdin.on("end",()=>process.stdout.write("EOF received"));';
  const { stdout } = await runProcess(process.execPath, ['-e', script], { timeout: 3000 });
  assert.equal(stdout, 'EOF received');
});

test('process failures preserve diagnostic context', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stderr.write("PDF无法读取");process.exit(3)']), /运行失败 \(3\).*PDF无法读取/);
});

test('process output and runtime limits reject instead of returning partial success', async () => {
  await assert.rejects(runProcess(process.execPath, ['-e', 'process.stdout.write("x".repeat(100))'], { maxBytes: 10 }), /输出超过限制/);
  await assert.rejects(runProcess(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { timeout: 80 }), /处理超时/);
});

test('missing executables remain identifiable as ENOENT', async () => {
  await assert.rejects(runProcess(path.join(process.cwd(), '__missing_executable_for_test__'), []), { code: 'ENOENT' });
});
