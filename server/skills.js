import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ROOT } from './config.js';

const modes = {
  'specification-rule-parser': ['extract', 'audit', 'classify'],
  'drawing-requirements-matcher': ['match', 'audit'],
};
const paths = ['SKILL.md', 'references/protocol.md'];
const hash = text => createHash('sha256').update(text).digest('hex');
const bundleHash = (name, files) => hash(JSON.stringify({ name, files }));

function sections(protocol) {
  const result = new Map();
  const headings = [...protocol.matchAll(/^## ([a-z]+)\s*$/gm)];
  for (const [index, heading] of headings.entries()) {
    if (result.has(heading[1])) throw new Error('Skill协议章节重复：' + heading[1]);
    result.set(heading[1], protocol.slice(heading.index + heading[0].length, headings[index + 1]?.index).trim());
  }
  return result;
}

function checkedBundle(bundle) {
  if (!bundle || !Object.hasOwn(modes, bundle.name) || !Array.isArray(bundle.files) || bundle.files.length !== paths.length) throw new Error('未知或无效的Skill资料包');
  const files = paths.map(file => {
    const found = bundle.files.filter(item => item?.path === file);
    if (found.length !== 1 || typeof found[0].content !== 'string' || !found[0].content.trim()) throw new Error('Skill资料包缺少或重复文件：' + file);
    return { path: file, content: found[0].content };
  });
  const sha256 = bundleHash(bundle.name, files);
  if (bundle.sha256 && bundle.sha256 !== sha256) throw new Error('Skill资料包哈希不一致');
  const protocol = sections(files[1].content);
  for (const section of ['common', ...modes[bundle.name]]) {
    if (!protocol.get(section)) throw new Error('Skill协议缺少章节：' + section);
  }
  return { name: bundle.name, files, sha256 };
}

// Only the two installed Skills, or their complete validated JSON snapshots.
export async function loadSkillBundle(skill) {
  if (typeof skill !== 'string' || !skill.trim()) throw new Error('必须指定Skill目录或完整资料快照');
  if (skill.split(/[\\/]/).includes('..')) throw new Error('Skill路径不能包含上级目录');
  if (path.extname(skill).toLowerCase() === '.json') return checkedBundle(JSON.parse(await fs.readFile(skill, 'utf8')));
  let directory = path.resolve(skill);
  if (path.basename(directory) === 'SKILL.md') directory = path.dirname(directory);
  const name = path.basename(directory);
  if (!Object.hasOwn(modes, name) || directory !== path.join(ROOT, 'skills', name)) throw new Error('不允许加载未知Skill或目录');
  const files = await Promise.all(paths.map(async file => ({ path: file, content: await fs.readFile(path.join(directory, file), 'utf8') })));
  return checkedBundle({ name, files });
}

export function compileSkill(rawBundle, mode) {
  const bundle = checkedBundle(rawBundle);
  if (!modes[bundle.name].includes(mode)) throw new Error('该Skill不支持任务模式：' + String(mode));
  const selected = mode === 'classify' ? ['classify'] : ['common', mode];
  const protocol = sections(bundle.files[1].content);
  const text = bundle.files[0].content.trimEnd() +
    '\n\n本次任务模式：' + mode + '。本次所需协议已在下方加载，只执行此模式。\n\n' +
    selected.map(section => '## ' + section + '\n\n' + protocol.get(section)).join('\n\n') + '\n';
  return {
    name: bundle.name, mode, text, sha256: hash(text), bundleSha256: bundle.sha256,
    files: bundle.files.map(file => ({ path: file.path, sha256: hash(file.content), sections: file.path === 'SKILL.md' ? [] : selected })),
  };
}

async function immutableFile(file, content) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  try { await fs.writeFile(file, content, { flag: 'wx' }); }
  catch (error) {
    if (error.code !== 'EEXIST') throw error;
    if (await fs.readFile(file, 'utf8') !== content) throw new Error('已有Skill快照不可覆盖，请使用新的运行目录');
  }
}

export async function freezeSkillBundle(rawBundle, file) {
  const bundle = checkedBundle(rawBundle);
  await immutableFile(file, JSON.stringify(bundle, null, 2));
  return file;
}

export async function freezeSkillPrompt(bundle, mode, directory, filename = 'skill-prompt.md') {
  if (!/^[a-z0-9][a-z0-9._-]*\.md$/i.test(filename)) throw new Error('Skill快照文件名必须是当前目录中的Markdown文件名');
  const compiled = compileSkill(bundle, mode);
  const skill = path.join(directory, filename);
  await immutableFile(skill, compiled.text);
  return { skill, skillProvenance: { name: compiled.name, mode, bundleSha256: compiled.bundleSha256, promptSha256: compiled.sha256, files: compiled.files } };
}

export function verifySkillProvenance(content, provenance) {
  if (!provenance) return null;
  if (!Object.hasOwn(modes, provenance.name) || !modes[provenance.name].includes(provenance.mode) ||
      !/^[a-f0-9]{64}$/.test(provenance.bundleSha256 || '') || hash(content) !== provenance.promptSha256) throw new Error('Skill提示快照与加载记录不一致');
  const selected = provenance.mode === 'classify' ? ['classify'] : ['common', provenance.mode];
  if (!Array.isArray(provenance.files) || provenance.files.length !== paths.length ||
      provenance.files.some((file, index) => file.path !== paths[index] || !/^[a-f0-9]{64}$/.test(file.sha256 || '') ||
        JSON.stringify(file.sections) !== JSON.stringify(index === 0 ? [] : selected))) throw new Error('Skill加载来源记录不完整');
  return provenance;
}
