import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { SKILL } from '../server/pi.js';

// Use Pi's own installed YAML parser, including under isolated pnpm installs.
const piRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { parse } = piRequire('yaml');

test('the portable skill has valid YAML metadata and no unfinished template markers', async () => {
  const source = await fs.readFile(path.join(SKILL, 'SKILL.md'), 'utf8');
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  assert.ok(frontmatter, 'SKILL.md must begin with YAML frontmatter');
  const metadata = parse(frontmatter[1]);
  assert.equal(metadata.name, path.basename(SKILL));
  assert.match(metadata.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
  assert.ok(metadata.name.length <= 64);
  assert.equal(typeof metadata.description, 'string');
  assert.ok(metadata.description.trim().length > 0 && metadata.description.length <= 1024);
  assert.doesNotMatch(metadata.description, /[<>]/);
  assert.doesNotMatch(source, /\b(?:TODO|TBD|FIXME|REPLACE_ME|YOUR_API_KEY)\b|\{\{\s*[A-Z_]+\s*\}\}/);
  const example = source.match(/```json\s*([\s\S]*?)```/);
  assert.ok(example, 'The skill must provide a parseable JSON contract example');
  const contract = JSON.parse(example[1]);
  assert.ok(Array.isArray(contract.requirements) && contract.requirements.length > 0);
  assert.ok(Array.isArray(contract.warnings));
  const item = contract.requirements[0];
  for (const field of ['id', 'category', 'requirement', 'scope', 'parameters', 'sources', 'review_required', 'review_note']) {
    assert.ok(Object.hasOwn(item, field), `Missing requirement field: ${field}`);
  }
  assert.ok(item.sources.length > 0 && item.sources[0].page > 0);
});
