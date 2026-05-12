import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'os';
import path from 'path';
import { promises as fs } from 'fs';
import { maskSourceProjectFiles, unmaskContent } from './index.js';

test('maskSourceProjectFiles masks tables and inline/display math and restores them', async () => {
  const tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'openprism-mask-'));
  try {
    await fs.writeFile(
      path.join(tmpRoot, 'main.tex'),
      [
        '\\section{Intro}',
        'Inline math $E=mc^2$ should be masked.',
        '\\begin{equation}',
        'a^2+b^2=c^2',
        '\\end{equation}',
        '\\begin{table}',
        '\\centering',
        '\\begin{tabular}{cc}',
        'a & b\\\\',
        '\\end{tabular}',
        '\\end{table}',
        'Escaped dollar \\$100 should stay.',
        '% $commented$ math should stay untouched',
        '\\input{refs}',
        '',
      ].join('\n'),
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'refs.tex'),
      'Display math: \\[x+y\\] and inline \\(z\\).\n',
      'utf8',
    );
    await fs.writeFile(
      path.join(tmpRoot, 'refs.bib'),
      '@article{key,\n  title={Energy $E=mc^2$}\n}\n',
      'utf8',
    );

    const masked = await maskSourceProjectFiles(tmpRoot);

    assert.equal(masked.warnings.length, 0);
    assert.ok(masked.maskedFiles.includes('main.tex'));
    assert.ok(masked.maskedFiles.includes('refs.tex'));
    assert.ok(masked.maskedFiles.includes('refs.bib'));
    assert.ok(masked.manifest.length >= 5);

    const maskedMain = masked.maskedContents['main.tex'];
    assert.match(maskedMain, /__OP_MASK_EQ_\d{4}__/);
    assert.match(maskedMain, /__OP_MASK_TBL_\d{4}__/);
    assert.match(masked.maskedContents['refs.tex'], /__OP_MASK_EQ_\d{4}__/);
    assert.match(masked.maskedContents['refs.bib'], /__OP_MASK_EQ_\d{4}__/);
    assert.match(maskedMain, /\\\$100/);
    assert.match(maskedMain, /% \$commented\$ math should stay untouched/);

    const restored = unmaskContent(maskedMain, masked.manifest);
    assert.equal(restored.remaining, 0);
    assert.match(restored.content, /Inline math \$E=mc\^2\$/);
    assert.match(restored.content, /\\begin\{equation\}/);
    assert.match(restored.content, /\\begin\{table\}/);
  } finally {
    await fs.rm(tmpRoot, { recursive: true, force: true });
  }
});
