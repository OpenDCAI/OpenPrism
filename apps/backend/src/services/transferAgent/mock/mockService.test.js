import test from 'node:test';
import assert from 'node:assert/strict';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import {
  createEmptyMockKV,
  maskLatexContent,
  maskMarkdownContent,
  unmaskContent,
  validateTokenIntegrity,
  saveMockKV,
  loadMockKV,
  applyMockForRead,
  remockBeforeWrite,
  assertOnlyRegisteredMockTokens,
} from './mockService.js';

test('latex mask/unmask is reversible for frozen segments', () => {
  const tex = `\\documentclass{article}
\\begin{document}
\\begin{abstract}
This is abstract.
\\end{abstract}
\\section{Intro}
Main body text.
\\appendix
Appendix details.
\\bibliography{refs}
\\end{document}
`;
  const masked = maskLatexContent(tex, createEmptyMockKV());
  assert.match(masked.masked, /%%MOCK:abstract:[a-f0-9]{8}%%/);
  assert.match(masked.masked, /%%MOCK:main_body:[a-f0-9]{8}%%/);
  assert.match(masked.masked, /%%MOCK:appendix_body:[a-f0-9]{8}%%/);
  assert.match(masked.masked, /%%MOCK:bibliography_block:[a-f0-9]{8}%%/);
  const restored = unmaskContent(masked.masked, masked.kv);
  assert.equal(restored, tex);
});

test('latex bibliography_block stops before appendix when bib precedes appendix', () => {
  const tex = `\\documentclass{article}
\\begin{document}
\\section{Intro}
Main.
\\bibliographystyle{plain}
\\bibliography{refs}
% gap
\\appendix
\\section{Proof}
Extra.
\\end{document}
`;
  const masked = maskLatexContent(tex, createEmptyMockKV());
  const restored = unmaskContent(masked.masked, masked.kv);
  assert.equal(restored, tex);
  const bibSeg = Object.entries(masked.kv.segments).find(([, v]) => v.includes('\\bibliography{refs}'));
  assert.ok(bibSeg, 'expected bibliography segment');
  assert.doesNotMatch(bibSeg[1], /\\appendix/, 'bibliography_block must not include appendix');
  const apxSeg = Object.entries(masked.kv.segments).find(([, v]) => v.includes('Extra'));
  assert.ok(apxSeg, 'expected appendix segment');
  assert.match(apxSeg[1], /\\appendix/);
});

test('markdown mask/unmask is reversible', () => {
  const md = `# Abstract
Brief abstract.

# Introduction
Main body.

# References
[1] Ref
`;
  const masked = maskMarkdownContent(md, createEmptyMockKV());
  assert.match(masked.masked, /%%MOCK:abstract:[a-f0-9]{8}%%/);
  assert.match(masked.masked, /%%MOCK:main_body:[a-f0-9]{8}%%/);
  assert.match(masked.masked, /%%MOCK:bibliography_block:[a-f0-9]{8}%%/);
  const restored = unmaskContent(masked.masked, masked.kv);
  assert.equal(restored, md);
});

test('token integrity check detects missing placeholders', () => {
  const before = 'a %%MOCK:main_body:1234abcd%% b';
  const after = 'a b';
  const res = validateTokenIntegrity(before, after);
  assert.equal(res.ok, false);
  assert.equal(res.missingTokens.length, 1);
});

test('token integrity treats legacy v1 and v2 spellings as same slot', () => {
  const before = 'a %%MOCK::main_body::1234abcd%% b';
  const after = 'a %%MOCK:main_body:1234abcd%% b';
  const res = validateTokenIntegrity(before, after);
  assert.equal(res.ok, true);
});

test('assertOnlyRegisteredMockTokens rejects invented tokens', () => {
  const kv = createEmptyMockKV();
  kv.version = '2';
  kv.segments['%%MOCK:main_body:aaaaaaaa%%'] = 'x';
  assert.throws(
    () => assertOnlyRegisteredMockTokens('intro %%MOCK:related_body:aaaaaaaa%% out', kv),
    /unknown mock token/,
  );
  assert.doesNotThrow(() => assertOnlyRegisteredMockTokens('plain \\section{A}', kv));
});

test('unmaskContent strips legacy v1 spelling when kv uses v2 keys', () => {
  const kv = createEmptyMockKV();
  kv.version = '2';
  kv.segments['%%MOCK:main_body:deadbeef%%'] = 'REAL';
  const out = unmaskContent('x %%MOCK::main_body::deadbeef%% y', kv);
  assert.equal(out, 'x REAL y');
});

test('mock map persists and remock restores protected text', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'mock-service-'));
  const mapPath = path.join(tmpDir, 'mock_map.json');
  const src = '\\begin{document}\\section{X}Body\\end{document}';

  const mocked = await applyMockForRead({
    content: src,
    relPath: 'main.tex',
    mockMapPath: mapPath,
  });
  assert.match(mocked.content, /%%MOCK:main_body:[a-f0-9]{8}%%/);

  const loaded = await loadMockKV(mapPath);
  await saveMockKV(mapPath, loaded);

  const remocked = await remockBeforeWrite({
    relPath: 'main.tex',
    beforeContent: src,
    candidateContent: `${mocked.content}\n% small editable change`,
    mockMapPath: mapPath,
  });
  assert.match(remocked.content, /\\section\{X\}Body/);
  assert.doesNotMatch(remocked.content, /%%MOCK:/);
});
