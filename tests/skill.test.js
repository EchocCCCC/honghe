import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

// Use Pi's own installed YAML parser, including under isolated pnpm installs.
const piRequire = createRequire(import.meta.resolve('@earendil-works/pi-coding-agent'));
const { parse } = piRequire('yaml');
const skillsRoot = fileURLToPath(new URL('../skills/', import.meta.url));

for (const [name, collection] of [['specification-rule-parser', 'rules'], ['drawing-requirements-matcher', 'requirements']]) {
  test(`${name} has valid metadata and parseable JSON contracts`, async () => {
    const source = await fs.readFile(path.join(skillsRoot, name, 'SKILL.md'), 'utf8');
    const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
    assert.ok(frontmatter, 'SKILL.md must begin with YAML frontmatter');
    const metadata = parse(frontmatter[1]);
    assert.equal(metadata.name, name);
    assert.match(metadata.name, /^[a-z0-9]+(?:-[a-z0-9]+)*$/);
    assert.ok(metadata.name.length <= 64);
    assert.equal(typeof metadata.description, 'string');
    assert.ok(metadata.description.trim().length > 0 && metadata.description.length <= 1024);
    assert.doesNotMatch(metadata.description, /[<>]/);
    assert.doesNotMatch(source, /\b(?:TODO|TBD|FIXME|REPLACE_ME|YOUR_API_KEY)\b|\{\{\s*[A-Z_]+\s*\}\}/);
    const contracts = [...source.matchAll(/```json\s*([\s\S]*?)```/g)].map(match => JSON.parse(match[1]));
    const contract = contracts.find(value => Array.isArray(value[collection]) && value[collection].length);
    assert.ok(contract, 'The skill must provide its structured extraction contract');
    assert.ok(Array.isArray(contract.warnings));
    const item = contract[collection][0];
    for (const field of ['id', 'informationType', 'category', 'requirement', 'scope', 'parameters', 'sources', 'review_required', 'review_note']) {
      assert.ok(Object.hasOwn(item, field), `Missing requirement field: ${field}`);
    }
    assert.ok(item.sources.length > 0 && item.sources[0].page > 0);
  });
}
