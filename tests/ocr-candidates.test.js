import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const project = fileURLToPath(new URL('../', import.meta.url));
try { process.loadEnvFile(path.join(project, '.env')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
const python = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
const script = path.join(project, 'skills/drawing-requirements-matcher/scripts/ocr_candidates.py');
const execute = promisify(execFile);
const options = { windowsHide: true, timeout: 20000, env: { ...process.env, PYTHONIOENCODING: 'utf-8' } };
const load = String.raw`import importlib.util,json,sys
spec=importlib.util.spec_from_file_location('ocr_candidates',sys.argv[1])
m=importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)
`;

test('OCR rotation maps ninety-degree pixel boxes back to the original tile, without treating pixels as dimensions', async () => {
  const code = load + String.raw`
box=[[10,80],[10,70],[20,70],[20,80]]
print(json.dumps(m.inverse_rotation(box,(100,60),(60,100),90)))`;
  const { stdout } = await execute(python, ['-c', code, script], options);
  assert.deepEqual(JSON.parse(stdout), [[20, 10], [30, 10], [30, 20], [20, 20]]);
});

test('OCR compaction combines only identical text at the same original-image position, preserving conflicting and nearby readings', async () => {
  const code = load + String.raw`
def candidate(identifier,text,score,box):
 return {'id':identifier,'text':text,'score':score,'approxOriginalBox':box}
box=[[10,10],[30,10],[30,30],[10,30]]
near=[[11,10],[31,10],[31,30],[11,30]]
other=[[50,10],[70,10],[70,30],[50,30]]
images=[{'image':'same.png','page':1,'imageSha256':'hash','rotation':0,'candidates':[candidate('a','TEXT',.2,box)]},
{'image':'same.png','page':1,'imageSha256':'hash','rotation':90,'candidates':[candidate('b','TEXT',.9,near),candidate('c','DIFFERENT',.99,box),candidate('d','TEXT',.8,other)]},
{'image':'another.png','page':1,'imageSha256':'hash','rotation':0,'candidates':[candidate('e','TEXT',.9,box)]}]
print(json.dumps(m.compact_candidates(images)))`;
  const { stdout } = await execute(python, ['-c', code, script], options);
  const groups = JSON.parse(stdout);
  assert.equal(groups.length, 4);
  assert.deepEqual(groups[0].observations, [{ candidateId: 'a', rotation: 0, score: .2 }, { candidateId: 'b', rotation: 90, score: .9 }]);
  assert.deepEqual(groups.map(g => g.text), ['TEXT', 'DIFFERENT', 'TEXT', 'TEXT']);
  assert.equal(groups[0].approxOriginalBox[0][0], 10); // Retains the first observation rather than choosing the higher score.
});

test('OCR label hints follow vertical coordinates in the same column, retaining alternative readings rather than guessing field values', async () => {
  const code = load + String.raw`
def group(text,x,y,score=.5):
 return {'image':'same.png','page':1,'imageSha256':'hash','text':text,'approxOriginalBox':[[x,y],[x+50,y],[x+50,y+20],[x,y+20]],'observations':[{'candidateId':text,'rotation':0,'score':score}]}
label=group('物资编码',100,100)
groups=[group('zebra',100,140),group('other-column',300,75),label,group('banana',100,60,.1),group('alternative',100,60,.99)]
print(json.dumps({'neighbors':m.label_neighbors(groups,label),'text':m.format_compact(groups)},ensure_ascii=False))`;
  const { stdout } = await execute(python, ['-c', code, script], options);
  const result = JSON.parse(stdout);
  assert.deepEqual(result.neighbors.above.map(n => n.text), ['banana', 'alternative']);
  assert.deepEqual(result.neighbors.below.map(n => n.text), ['zebra']);
  assert.deepEqual(result.neighbors.above[0].approxOriginalBBox, [100, 60, 150, 80]);
  assert.match(result.text, /非字段值断言/);
  assert.match(result.text, /other-column/); // All original candidates remain, including ones that are not neighbors.
});

async function fixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'ocr-candidates-'));
  const image = path.join(directory, 'doc-1-page-1-tile-1.png');
  await execute(python, ['-c', 'from PIL import Image;import sys;Image.new("RGB",(100,60),"white").save(sys.argv[1])', image], options);
  const prepared = path.join(directory, 'prepared.json'), source = path.join(directory, 'source.txt');
  await fs.writeFile(prepared, JSON.stringify({ pages: [{ docId: 'doc-1', file: 'part.pdf', page: 1, imagePaths: [image] }] }));
  await fs.writeFile(source, 'Original PDF text remains unchanged.');
  await fs.writeFile(path.join(directory, 'rapidocr.py'), String.raw`
import os
from pathlib import Path
from types import SimpleNamespace
class EngineType:
 ONNXRUNTIME='onnxruntime'
class RapidOCR:
 def __init__(self,params):
  print('mock library initialization log')
  self.cfg={'Global':{'max_side_len':params['Global.max_side_len'],'model_root_dir':Path(__file__).parent/'models'},'Det':{'limit_side_len':params['Det.limit_side_len'],'limit_type':params['Det.limit_type']},'Rec':{},'EngineConfig':{'onnxruntime':{'intra_op_num_threads':params['EngineConfig.onnxruntime.intra_op_num_threads']}}}
 def __call__(self,image):
  if os.environ.get('OCR_MOCK_FAIL'): raise RuntimeError('mock inference failed')
  print('mock library inference log')
  return SimpleNamespace(boxes=[[[10,10],[30,10],[30,30],[10,30]]],txts=['UNMODIFIED'],scores=[.321])
`);
  await fs.writeFile(path.join(directory, 'cv2.py'), 'def setNumThreads(value):\n pass\n');
  await fs.writeFile(path.join(directory, 'omegaconf.py'), 'class OmegaConf:\n @staticmethod\n def to_container(value,**kwargs): return value\n');
  for (const [name, version] of [['rapidocr', '3.10.0'], ['onnxruntime', '1.31.1']]) {
    const info = path.join(directory, `${name}-${version}.dist-info`);
    await fs.mkdir(info); await fs.writeFile(path.join(info, 'METADATA'), `Name: ${name}\nVersion: ${version}\n`);
  }
  const outputDirectory = path.join(directory, 'output'), output = path.join(outputDirectory, 'ocr-candidates.json');
  const originals = await Promise.all([image, prepared, source].map(file => fs.readFile(file)));
  const run = (extraEnv = {}) => execute(python, [script, '--prepared', prepared, '--output', output], { ...options, env: { ...options.env, PYTHONPATH: directory, ...extraEnv } });
  return { directory, image, prepared, source, originals, outputDirectory, output, run,
    close: async () => {
      assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()));
      assert.ok(path.basename(directory).startsWith('ocr-candidates-'));
      await fs.rm(directory, { recursive: true, force: true });
    } };
}

test('OCR CLI emits one summary JSON, retains raw candidates and approximate boxes, and never changes prepared/source images', async () => {
  const f = await fixture();
  try {
    const { stdout, stderr } = await f.run();
    const summary = JSON.parse(stdout);
    assert.equal(stdout.trim().split('\n').length, 1);
    assert.equal(summary.complete, true); assert.equal(summary.outputPath, f.output);
    assert.equal(summary.textPath, path.join(f.outputDirectory, 'ocr-candidates.txt'));
    assert.equal(summary.imageCount, 1); assert.equal(summary.passCount, 4); assert.equal(summary.candidateCount, 4);
    assert.equal(summary.engine.rapidocr, '3.10.0'); assert.equal(summary.engine.onnxruntime, '1.31.1');
    assert.match(stderr, /mock library inference log/);
    const report = JSON.parse(await fs.readFile(f.output, 'utf8'));
    assert.equal(report.engine.configuration.Global.model_root_dir, path.join(f.directory, 'models'));
    assert.deepEqual(report.images.map(i => i.rotation), [0, 45, 90, 135]);
    for (const image of report.images) {
      assert.equal(image.page, 1); assert.ok(image.imageSha256);
      assert.equal(image.candidates[0].text, 'UNMODIFIED'); assert.equal(image.candidates[0].score, .321);
      assert.equal(image.candidates[0].rotatedBox.length, 4); assert.equal(image.candidates[0].approxOriginalBox.length, 4);
    }
    const text = await fs.readFile(summary.textPath, 'utf8');
    assert.match(text, /OCR候选，不是事实/); assert.match(text, /score是引擎分数，不代表准确率/); assert.match(text, /像素位置，不是工艺尺寸/);
    for (const [index, file] of [f.image, f.prepared, f.source].entries()) assert.deepEqual(await fs.readFile(file), f.originals[index]);
    assert.ok(!(await fs.readdir(f.outputDirectory)).some(name => name.startsWith('ocr-rotation-')));
  } finally { await f.close(); }
});

test('OCR inference failure exits nonzero with an explicit failed summary and no fake complete artifact', async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.run({ OCR_MOCK_FAIL: '1' }), error => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).complete, false);
      assert.match(error.stderr, /mock inference failed/);
      return true;
    });
    assert.equal(JSON.parse(await fs.readFile(f.output, 'utf8')).complete, false);
    await assert.rejects(fs.access(path.join(f.outputDirectory, 'ocr-candidates.txt')), { code: 'ENOENT' });
    assert.ok(!(await fs.readdir(f.outputDirectory)).some(name => name.startsWith('ocr-rotation-')));
    assert.deepEqual(await fs.readFile(f.image), f.originals[0]);
  } finally { await f.close(); }
});

test('OCR rejects Python below the runtime minimum before loading its inference dependencies', async () => {
  const code = load + String.raw`
m.sys.version_info=(3,10,0)
try:
 m.create_engine()
except RuntimeError as error:
 print(json.dumps({'error':str(error)}))
else:
 raise AssertionError('Expected Python version rejection')`;
  const { stdout } = await execute(python, ['-c', code, script], options);
  assert.match(JSON.parse(stdout).error, /Python 3\.11/);
});

test('OCR reports missing inference dependencies with the installation location and an explicit failed summary', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.directory, 'rapidocr.py'), "raise ModuleNotFoundError('No module named rapidocr')\n");
    await assert.rejects(f.run(), error => {
      assert.equal(error.code, 1);
      const summary = JSON.parse(error.stdout);
      assert.equal(summary.complete, false);
      assert.match(summary.error, /Python 3\.11/); assert.match(summary.error, /requirements\.txt/); assert.match(summary.error, /PYTHONPATH/);
      return true;
    });
  } finally { await f.close(); }
});

test('OCR cannot mark its JSON complete if writing the companion candidate text fails', async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.outputDirectory, 'ocr-candidates.txt'), { recursive: true });
    await assert.rejects(f.run(), error => {
      assert.equal(error.code, 1);
      assert.equal(JSON.parse(error.stdout).complete, false);
      return true;
    });
    assert.equal(JSON.parse(await fs.readFile(f.output, 'utf8')).complete, false);
  } finally { await f.close(); }
});
