import { promises as fs } from 'fs';
import path from 'path';
import { getTemplateConfig } from './templateConfigs.js';
function reEscape(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function subn(text, regex, replacement) {
    let count = 0;
    const out = text.replace(regex, (...args) => {
        count += 1;
        if (typeof replacement === 'function') {
            return replacement(...args);
        }
        return replacement;
    });
    return { text: out, count };
}
async function rglob(rootDir) {
    const results = [];
    async function walk(dir) {
        let entries;
        try {
            entries = await fs.readdir(dir, { withFileTypes: true });
        }
        catch {
            return;
        }
        for (const entry of entries) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) {
                results.push({ path: full, isDir: true, isFile: false });
                await walk(full);
            }
            else if (entry.isFile()) {
                results.push({ path: full, isDir: false, isFile: true });
            }
        }
    }
    await walk(rootDir);
    return results;
}
const DOCUMENT_REGEX = /(?<prefix>[\s\S]*?)(?<begin>\\begin\{document\})(?<document>[\s\S]*?)(?<end>\\end\{document\})/;
const LAYOUT_LENGTH_NAMES = [
    'pdfpagewidth',
    'pdfpageheight',
    'paperwidth',
    'paperheight',
    'textwidth',
    'textheight',
    'columnsep',
    'oddsidemargin',
    'evensidemargin',
    'topmargin',
    'headheight',
    'headsep',
    'footskip',
    'parindent',
    'parskip',
    'floatsep',
    'textfloatsep',
    'intextsep',
];
export async function discoverMainTex(rootDir, preferredNames = []) {
    for (const preferred of preferredNames) {
        const matches = [];
        for (const entry of await rglob(rootDir)) {
            if (entry.isFile && path.basename(entry.path) === preferred) {
                matches.push(entry.path);
            }
        }
        matches.sort();
        if (matches.length > 0)
            return matches[0];
    }
    const texFiles = [];
    for (const entry of await rglob(rootDir)) {
        if (entry.isFile && entry.path.toLowerCase().endsWith('.tex')) {
            texFiles.push(entry.path);
        }
    }
    texFiles.sort();
    if (texFiles.length === 0) {
        throw new Error(`No .tex files found under ${rootDir}`);
    }
    let bestFile = null;
    let bestScore = null;
    for (const candidate of texFiles) {
        const text = await loadText(candidate);
        if (!text.includes('\\documentclass') || !text.includes('\\begin{document}')) {
            continue;
        }
        let score = 0;
        if (text.includes('\\title'))
            score += 50;
        if (text.includes('\\begin{abstract}'))
            score += 30;
        if (text.includes('\\bibliography') || text.includes('\\printbibliography'))
            score += 20;
        score += Math.min(Math.floor(text.length / 500), 100);
        if (bestScore === null || score > bestScore) {
            bestScore = score;
            bestFile = candidate;
        }
    }
    if (!bestFile) {
        throw new Error(`Unable to identify main LaTeX file under ${rootDir}`);
    }
    return bestFile;
}
export async function loadText(filePath) {
    return fs.readFile(filePath, 'utf8');
}
export function maskComments(text) {
    const out = [];
    const lines = text.split(/(\r\n|\n|\r)/);
    for (let i = 0; i < lines.length; i += 2) {
        const content = lines[i];
        const sep = lines[i + 1] || '';
        if (content === undefined)
            continue;
        const chars = content.split('');
        let escaped = false;
        for (let j = 0; j < chars.length; j += 1) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (chars[j] === '\\') {
                escaped = true;
                continue;
            }
            if (chars[j] === '%') {
                for (let k = j; k < chars.length; k += 1) {
                    if (chars[k] !== '\n' && chars[k] !== '\r')
                        chars[k] = ' ';
                }
                break;
            }
        }
        out.push(chars.join(''));
        out.push(sep);
    }
    return out.join('');
}
export function extractDocumentclass(text) {
    const match = text.match(/^\s*\\documentclass(?:\[[^\]]*\])?\{[^}]+\}/m);
    if (!match) {
        throw new Error('Missing \\documentclass in target template');
    }
    return match[0].trim();
}
export async function detectProjectKindFromText(text, rootDir = null) {
    const masked = maskComments(text);
    const packageMarkers = [
        ['acl', /\\usepackage(?:\[[^\]]*\])?\{acl\}/],
        ['neurips', /\\usepackage(?:\[[^\]]*\])?\{neurips(?:_[0-9]{4})?\}/],
        ['icml', /\\usepackage(?:\[[^\]]*\])?\{icml2026\}/],
        ['iclr', /\\usepackage(?:\[[^\]]*\])?\{iclr2026_conference\}/],
        ['cvpr', /\\usepackage(?:\[[^\]]*\])?\{cvpr\}/],
        ['aaai', /\\usepackage(?:\[[^\]]*\])?\{aaai2026\}/],
    ];
    for (const [kind, pattern] of packageMarkers) {
        if (pattern.test(masked))
            return kind;
    }
    return rootDir !== null ? detectTargetKind(rootDir) : 'generic';
}
export function stripDocumentclass(preamble) {
    return preamble.replace(/^\s*\\documentclass(?:\[[^\]]*\])?\{[^}]+\}\s*/m, '').trim();
}
export function stripTitleAuthorBlocks(preamble) {
    let cleaned = stripDocumentclass(preamble);
    for (const macro of getTemplateConfig('generic').stripMacros) {
        for (;;) {
            const block = extractMacroBlock(cleaned, macro);
            if (!block)
                break;
            cleaned = cleaned.replace(block, '');
        }
    }
    return cleaned.trim();
}
export function stripTemplateMacros(preamble, targetKind) {
    let cleaned = stripDocumentclass(preamble);
    const macroNames = getTemplateConfig(targetKind).stripMacros;
    for (const macro of macroNames) {
        for (;;) {
            const block = extractMacroBlock(cleaned, macro);
            if (!block)
                break;
            cleaned = cleaned.replace(block, '');
        }
    }
    return cleaned.trim();
}
export function splitDocument(text) {
    const match = text.match(DOCUMENT_REGEX);
    if (!match) {
        throw new Error('Invalid LaTeX file: missing document environment');
    }
    return [match.groups.prefix, match.groups.document];
}
export function extractMacroBlock(text, macroName) {
    const masked = maskComments(text);
    const pattern = new RegExp(`\\\\${reEscape(macroName)}(?:\\s*\\[[^\\]]*\\])?\\s*\\{`, 'gm');
    const match = pattern.exec(masked);
    if (!match)
        return null;
    const openBrace = masked.indexOf('{', match.index);
    if (openBrace === -1)
        return null;
    const endIndex = findMatchingBrace(masked, openBrace);
    return text.slice(match.index, endIndex + 1);
}
export function extractEnvironment(text, envName) {
    const masked = maskComments(text);
    const beginRe = new RegExp(`\\\\begin\\{${reEscape(envName)}\\}`);
    const beginMatch = masked.match(beginRe);
    if (!beginMatch)
        return null;
    const beginStart = beginMatch.index;
    const beginEnd = beginStart + beginMatch[0].length;
    const endRe = new RegExp(`\\\\end\\{${reEscape(envName)}\\}`);
    const tail = masked.slice(beginEnd);
    const endMatch = tail.match(endRe);
    if (!endMatch)
        return null;
    const blockEnd = beginEnd + endMatch.index + endMatch[0].length;
    const block = text.slice(beginStart, blockEnd);
    const inner = text.slice(beginEnd, beginEnd + endMatch.index).trim();
    return [block, inner];
}
export function findMatchingBrace(text, openBrace) {
    let depth = 0;
    let escaped = false;
    for (let i = openBrace; i < text.length; i += 1) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '{')
            depth += 1;
        else if (ch === '}') {
            depth -= 1;
            if (depth === 0)
                return i;
        }
    }
    throw new Error('Unbalanced braces in LaTeX content');
}
export function findMatchingBracket(text, openBracket) {
    let depth = 0;
    let escaped = false;
    for (let i = openBracket; i < text.length; i += 1) {
        const ch = text[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (ch === '\\') {
            escaped = true;
            continue;
        }
        if (ch === '[')
            depth += 1;
        else if (ch === ']') {
            depth -= 1;
            if (depth === 0)
                return i;
        }
    }
    throw new Error('Unbalanced brackets in LaTeX content');
}
export function parseUsepackageLines(preamble) {
    const packages = [];
    const remainingLines = [];
    const packageRe = /^\s*\\usepackage(?:\[([^\]]*)\])?\{([^}]*)\}/;
    for (const line of preamble.split('\n')) {
        const match = line.match(packageRe);
        if (!match) {
            remainingLines.push(line);
            continue;
        }
        const options = (match[1] || '')
            .split(',')
            .map((p) => p.trim())
            .filter((p) => p.length > 0);
        const names = match[2]
            .split(',')
            .map((n) => n.trim())
            .filter((n) => n.length > 0);
        for (const name of names) {
            packages.push({ name, options, raw: line.replace(/\s+$/, '') });
        }
    }
    return { packages, remaining: remainingLines.join('\n').trim() };
}
export function mergePreambles(targetPreamble, sourcePreamble, targetKind = 'generic') {
    const sourcePreambleNoComments = maskComments(sourcePreamble);
    const cleanedSource = stripTitleAuthorBlocks(sourcePreambleNoComments);
    const { packages: sourcePackages, remaining: sourceOther } = parseUsepackageLines(cleanedSource);
    const { packages: targetPackages } = parseUsepackageLines(stripTemplateMacros(targetPreamble, targetKind));
    const skipPackages = new Set([
        'acl',
        'neurips_2026',
        'icml2026',
        'iclr2026_conference',
        'cvpr',
        'aaai2026',
    ]);
    for (const p of getTemplateConfig(targetKind).skipPackages)
        skipPackages.add(p);
    const targetPackageOptions = new Map();
    for (const pkg of targetPackages) {
        targetPackageOptions.set(pkg.name, new Set(pkg.options));
    }
    const passOptions = {};
    const addedPackages = [];
    const addedSeen = new Set();
    for (const pkg of sourcePackages) {
        if (skipPackages.has(pkg.name))
            continue;
        if (targetKind === 'neurips' && isNeuripsStylePackage(pkg.name))
            continue;
        if (targetPackageOptions.has(pkg.name)) {
            const already = targetPackageOptions.get(pkg.name);
            const missing = pkg.options.filter((opt) => !already.has(opt));
            if (missing.length > 0) {
                if (!passOptions[pkg.name])
                    passOptions[pkg.name] = new Set();
                for (const opt of missing)
                    passOptions[pkg.name].add(opt);
            }
            continue;
        }
        if (addedSeen.has(pkg.name))
            continue;
        const optionsPrefix = pkg.options.length ? `[${pkg.options.join(',')}]` : '';
        addedPackages.push(`\\usepackage${optionsPrefix}{${pkg.name}}`);
        addedSeen.add(pkg.name);
    }
    const additions = [];
    if (addedPackages.length) {
        additions.push('% Added from the source project to preserve paper content');
        additions.push(...addedPackages);
    }
    const keepTemplateLineNumbers = templateWantsLineNumbers(targetPreamble, targetKind);
    const normalizedSourceOther = keepTemplateLineNumbers
        ? stripSourceLineNumberDisablers(sourceOther)
        : sourceOther;
    if (normalizedSourceOther.trim()) {
        additions.push('% Source project macros and local configuration');
        additions.push(normalizedSourceOther.trim());
    }
    let merged = targetPreamble.trim();
    if (additions.length) {
        merged = `${merged}\n\n${additions.join('\n').trim()}`;
    }
    return [merged.trim(), passOptions];
}
export function splitAppendix(documentBody) {
    const masked = maskComments(documentBody);
    const marker = masked.match(/(^|\n)\s*\\appendix\b/);
    if (!marker)
        return [documentBody.trim(), ''];
    const start = marker.index;
    return [documentBody.slice(0, start).trim(), documentBody.slice(start).trim()];
}
export function splitBibliography(documentBody) {
    const masked = maskComments(documentBody);
    const patterns = [
        /\\bibliographystyle(?:\s*\[[^\]]*\])?\s*\{/,
        /\\bibliography(?:\s*\[[^\]]*\])?\s*\{/,
        /\\printbibliography\b/,
        /\\begin\{thebibliography\}/,
    ];
    const locations = [];
    for (const p of patterns) {
        const m = masked.match(p);
        if (m)
            locations.push(m.index);
    }
    if (locations.length === 0)
        return [documentBody.trim(), ''];
    const start = Math.min(...locations);
    let prefix = documentBody.slice(0, start);
    let bibliographyBody = documentBody.slice(start).trim();
    const groupMatch = prefix.match(/\{\s*\\small\s*$/s);
    if (groupMatch) {
        prefix = prefix.slice(0, groupMatch.index);
        if (bibliographyBody.endsWith('}')) {
            bibliographyBody = bibliographyBody.slice(0, -1).trim();
        }
    }
    return [prefix.replace(/\s+$/, ''), bibliographyBody];
}
export function extractBibliographyStyle(text) {
    const block = extractMacroBlock(text, 'bibliographystyle');
    if (!block)
        return [text.trim(), ''];
    return [text.replace(block, '').trim(), block.trim()];
}
export async function stripFrontmatter(documentBody, sourceKind, mainTex) {
    let body = documentBody;
    let abstractText = '';
    if (sourceKind === 'icml')
        body = stripIcmlFrontmatter(body);
    if (sourceKind === 'neurips')
        body = stripNeuripsArtifacts(body);
    if (sourceKind === 'cvpr')
        body = stripCvprFrontmatter(body);
    const abstractEnv = extractEnvironment(body, 'abstract');
    if (abstractEnv) {
        const [block, inner] = abstractEnv;
        abstractText = inner;
        body = body.replace(block, '');
    }
    else if (sourceKind === 'cvpr') {
        const [extracted, newBody] = await extractCvprAbstractFromInputs(body, mainTex);
        abstractText = extracted;
        body = newBody;
    }
    body = body.replace(/^\s*\\maketitle\s*/, '');
    body = body.trim();
    return [abstractText.trim(), body];
}
export function stripIcmlFrontmatter(body) {
    const masked = maskComments(body);
    const start = masked.indexOf('\\twocolumn[');
    let out = body;
    if (start !== -1) {
        const openBracket = masked.indexOf('[', start);
        if (openBracket !== -1) {
            const closeBracket = findMatchingBracket(masked, openBracket);
            out = body.slice(0, start) + body.slice(closeBracket + 1);
        }
    }
    out = out.replace(/^\s*\\printAffiliationsAndNotice\s*\{[\s\S]*?\}\s*/m, '');
    return out;
}
export function stripNeuripsArtifacts(body) {
    let out = body.replace(/^\s*\\newpage\s*\n\s*\\input\{checklist\.tex\}\s*$/gm, '');
    out = out.replace(/^\s*\\input\{checklist\.tex\}\s*$/gm, '');
    return out;
}
export function stripCvprFrontmatter(body) {
    let out = unwrapCvprTeaserBlock(body);
    out = out.replace(/^\s*\\maketitle\s*$/gm, '');
    out = out.replace(/^\s*\\renewcommand\\twocolumn\[1\]\[\]\{#1\}\s*%?\s*$/gm, '');
    for (;;) {
        const footnoteBlock = extractMacroBlock(out, 'blfootnote');
        if (!footnoteBlock)
            break;
        out = out.replace(footnoteBlock, '');
    }
    return out.trim();
}
export function unwrapCvprTeaserBlock(body) {
    const masked = maskComments(body);
    const start = masked.indexOf('\\twocolumn[');
    if (start === -1)
        return body;
    const openBracket = masked.indexOf('[', start);
    if (openBracket === -1)
        return body;
    const closeBracket = findMatchingBracket(masked, openBracket);
    let inner = body.slice(openBracket + 1, closeBracket);
    inner = inner.replace(/^\s*\{?%\s*/, '');
    inner = inner.replace(/^\s*\\renewcommand\\twocolumn\[1\]\[\]\{#1\}\s*/, '');
    inner = inner.replace(/^\s*\\maketitle\s*/, '');
    inner = inner.trim().replace(/\}\s*$/, '');
    inner = inner.trim();
    const rebuilt = `${inner}\n\n${body.slice(closeBracket + 1)}`;
    return rebuilt.trim();
}
export async function extractCvprAbstractFromInputs(body, mainTex) {
    const masked = maskComments(body);
    const patterns = [
        /^\s*\\input\{(?<path>[^}]*abstract[^}]*)\}\s*$/m,
        /^\s*\\input\{(?<path>sec\/0_abstract)\}\s*$/m,
    ];
    for (const pattern of patterns) {
        const match = masked.match(pattern);
        if (!match)
            continue;
        const inputPath = await resolveTexInputPath(path.dirname(mainTex), match.groups.path);
        let abstractText = '';
        if (inputPath) {
            abstractText = (await loadText(inputPath)).trim();
            const abstractEnv = extractEnvironment(abstractText, 'abstract');
            if (abstractEnv) {
                abstractText = abstractEnv[1];
            }
        }
        const newBody = body.slice(0, match.index) + body.slice(match.index + match[0].length);
        return [abstractText.trim(), newBody];
    }
    return ['', body];
}
export async function extractCvprAppendixFromInputs(body, mainTex) {
    const masked = maskComments(body);
    const patterns = [
        /^\s*\\input\{(?<path>[^}]*suppl[^}]*)\}\s*$/m,
        /^\s*\\input\{(?<path>[^}]*appendix[^}]*)\}\s*$/m,
        /^\s*\\input\{(?<path>sec\/X_suppl)\}\s*$/m,
    ];
    for (const pattern of patterns) {
        const match = masked.match(pattern);
        if (!match)
            continue;
        const inputPath = await resolveTexInputPath(path.dirname(mainTex), match.groups.path);
        let appendixText = '';
        if (inputPath) {
            appendixText = (await loadText(inputPath)).trim();
        }
        appendixText = stripCvprAppendixFrontmatter(appendixText);
        const newBody = body.slice(0, match.index) + body.slice(match.index + match[0].length);
        return [appendixText, newBody];
    }
    return ['', body];
}
export function stripCvprAppendixFrontmatter(text) {
    let cleaned = text.trim();
    cleaned = cleaned.replace(/^\s*\\clearpage\s*/gm, '');
    cleaned = cleaned.replace(/^\s*\\setcounter\{page\}\{[^}]*\}\s*/gm, '');
    cleaned = cleaned.replace(/^\s*\\maketitlesupplementary\s*/gm, '');
    return cleaned.trim();
}
export async function resolveTexInputPath(baseDir, relativePath) {
    const candidates = [path.join(baseDir, relativePath)];
    if (!relativePath.endsWith('.tex')) {
        candidates.push(path.join(baseDir, `${relativePath}.tex`));
    }
    for (const candidate of candidates) {
        try {
            await fs.access(candidate);
            return candidate;
        }
        catch { }
    }
    return null;
}
export async function buildSourceRepresentation(rootDir) {
    const mainTex = await discoverMainTex(rootDir, ['resubmitted.tex', 'main.tex']);
    const text = await loadText(mainTex);
    const [preamble, documentBody] = splitDocument(text);
    const sourceKind = await detectProjectKindFromText(preamble, rootDir);
    let sourcePreamble = extractPreservedSourcePreamble(maskComments(preamble));
    sourcePreamble = stripAlgorithmCompatibilityLines(stripTemplateMacros(sourcePreamble, sourceKind));
    sourcePreamble = stripSourceTemplatePackages(sourcePreamble, sourceKind);
    sourcePreamble = stripSourceTemplateCommands(sourcePreamble, sourceKind);
    sourcePreamble = stripAutoresubmitInjectedBlocks(sourcePreamble);
    const [sourcePreambleCleaned, layoutWarnings] = stripLayoutModifyingCommands(sourcePreamble);
    sourcePreamble = sourcePreambleCleaned;
    const warnings = [...layoutWarnings];
    const titleBlock = extractMacroBlock(preamble, 'title') || '\\title{Untitled Submission}';
    const authorBlock = extractMacroBlock(preamble, 'author') || '\\author{}';
    const dateBlock = extractMacroBlock(preamble, 'date') || '\\date{}';
    if (authorBlock === '\\author{}') {
        warnings.push('Source paper does not define \\author; generated output keeps authors blank.');
    }
    const [abstract, bodyWithoutFrontmatter] = await stripFrontmatter(documentBody, sourceKind, mainTex);
    if (!abstract) {
        warnings.push('Source paper does not contain an abstract environment.');
    }
    let mainPlusBib;
    let appendix;
    [mainPlusBib, appendix] = splitAppendix(bodyWithoutFrontmatter);
    if (sourceKind === 'cvpr' && !appendix) {
        const [cvprAppendix, newMainPlusBib] = await extractCvprAppendixFromInputs(mainPlusBib, mainTex);
        appendix = cvprAppendix;
        mainPlusBib = newMainPlusBib;
    }
    let [mainBody, bibliographyBlock] = splitBibliography(mainPlusBib);
    const [bibliographyBlockCleaned, bibliographyStyle] = extractBibliographyStyle(bibliographyBlock);
    bibliographyBlock = bibliographyBlockCleaned;
    const combinedText = [abstract, mainBody, appendix].filter((s) => s.trim()).join('\n');
    sourcePreamble = addInferredSourcePackages(sourcePreamble, combinedText);
    return {
        mainTex,
        sourcePreamble: sourcePreamble.trim(),
        titleBlock: titleBlock.trim(),
        authorBlock: authorBlock.trim(),
        dateBlock: dateBlock.trim(),
        abstract: abstract.trim(),
        mainBody: mainBody.trim(),
        bibliographyStyle: bibliographyStyle.trim(),
        bibliographyBlock: bibliographyBlock.trim(),
        appendixBody: appendix.trim(),
        warnings,
    };
}
export async function buildTargetRepresentation(rootDir) {
    const targetKind = await detectTargetKind(rootDir);
    const preferredNames = getTemplateConfig(targetKind).preferredMainNames;
    const mainTex = await discoverMainTex(rootDir, preferredNames);
    const text = await loadText(mainTex);
    const [preamble] = splitDocument(text);
    const documentclass = extractDocumentclass(text);
    const normalizedPreamble = normalizeTargetSubmissionMode(stripTemplateMacros(preamble, targetKind), targetKind);
    return { mainTex, documentclass, targetPreamble: normalizedPreamble, targetKind };
}
export function renderMergedTex(project, includeChecklist) {
    if (project.targetKind === 'icml')
        return renderIcmlMergedTex(project);
    if (project.targetKind === 'aaai')
        return renderAaaiMergedTex(project);
    const passOptionLines = [];
    for (const packageName of Object.keys(project.passOptions).sort()) {
        const options = [...project.passOptions[packageName]].sort().join(',');
        passOptionLines.push(`\\PassOptionsToPackage{${options}}{${packageName}}`);
    }
    const parts = [project.documentclass];
    if (passOptionLines.length)
        parts.push(passOptionLines.join('\n'));
    parts.push(project.targetPreamble.trim());
    const submissionSafeguards = renderSubmissionSafeguards(project);
    if (submissionSafeguards)
        parts.push(submissionSafeguards);
    parts.push(project.titleBlock.trim());
    parts.push(project.authorBlock.trim());
    if (project.dateBlock.trim())
        parts.push(project.dateBlock.trim());
    parts.push('\\begin{document}');
    parts.push('\\maketitle');
    const postMaketitleHook = renderPostMaketitleSubmissionSafeguards(project);
    if (postMaketitleHook)
        parts.push(postMaketitleHook);
    if (project.abstract) {
        parts.push(`\\begin{abstract}\n${project.abstract.trim()}\n\\end{abstract}`);
    }
    if (project.mainBody)
        parts.push(project.mainBody.trim());
    let bibliographyStyle = project.bibliographyStyle.trim();
    const bibliographyBlock = project.bibliographyBlock.trim();
    if (bibliographyBlock) {
        if (!bibliographyStyle)
            bibliographyStyle = defaultBibliographystyle(project.targetKind);
        if (bibliographyStyle)
            parts.push(bibliographyStyle);
        parts.push(bibliographyBlock);
    }
    if (project.appendixBody.trim())
        parts.push(project.appendixBody.trim());
    if (includeChecklist) {
        parts.push('\\newpage');
        parts.push('\\input{checklist.tex}');
    }
    parts.push('\\end{document}');
    return parts.filter((p) => p && p.trim()).join('\n\n') + '\n';
}
export function renderAaaiMergedTex(project) {
    const passOptionLines = [];
    for (const packageName of Object.keys(project.passOptions).sort()) {
        const options = [...project.passOptions[packageName]].sort().join(',');
        passOptionLines.push(`\\PassOptionsToPackage{${options}}{${packageName}}`);
    }
    const titleContent = extractMacroContent(project.titleBlock) || 'Untitled Submission';
    const authorContent = 'Anonymous Submission';
    const compatibilityMacros = [
        '\\usepackage{iftex}',
        '\\ifPDFTeX\\else',
        "% AAAI's PSNFSS times/helvet/courier stack falls back to Latin Modern under",
        '% TU/XeTeX. Re-select the T1 text encoding so tectonic/XeTeX uses the intended',
        '% Times-compatible Type1 fonts without requiring extra packages.',
        '\\renewcommand{\\encodingdefault}{T1}',
        '\\AtBeginDocument{\\normalfont\\selectfont}',
        '\\fi',
        '\\providecommand{\\texorpdfstring}[2]{#1}',
        '\\providecommand{\\State}{\\STATE}',
        '\\providecommand{\\Statex}{\\item[]}',
        '\\providecommand{\\Require}{\\REQUIRE}',
        '\\providecommand{\\Ensure}{\\ENSURE}',
        '\\providecommand{\\Return}{\\textbf{return}}',
        '\\providecommand{\\Comment}[1]{\\COMMENT{#1}}',
    ].join('\n');
    const parts = [project.documentclass];
    if (passOptionLines.length)
        parts.push(passOptionLines.join('\n'));
    parts.push(project.targetPreamble.trim());
    parts.push(compatibilityMacros);
    parts.push(`\\title{${titleContent}}`);
    parts.push(`\\author{${authorContent}}`);
    parts.push('\\affiliations{}');
    parts.push('\\begin{document}');
    parts.push('\\maketitle');
    if (project.abstract) {
        parts.push(`\\begin{abstract}\n${project.abstract.trim()}\n\\end{abstract}`);
    }
    if (project.mainBody)
        parts.push(project.mainBody.trim());
    const bibliographyBlock = project.bibliographyBlock.trim();
    if (bibliographyBlock)
        parts.push(bibliographyBlock);
    if (project.appendixBody.trim())
        parts.push(project.appendixBody.trim());
    parts.push('\\end{document}');
    return parts.filter((p) => p && p.trim()).join('\n\n') + '\n';
}
export function renderIcmlMergedTex(project) {
    const passOptionLines = [];
    for (const packageName of Object.keys(project.passOptions).sort()) {
        const options = [...project.passOptions[packageName]].sort().join(',');
        passOptionLines.push(`\\PassOptionsToPackage{${options}}{${packageName}}`);
    }
    const titleContent = extractMacroContent(project.titleBlock) || 'Untitled Submission';
    const runningTitle = collapseTitleForRunningHead(titleContent);
    const compatibilityMacros = [
        '% Compatibility layer for source projects that use algpseudocode-style commands.',
        '\\providecommand{\\State}{\\STATE}',
        '\\providecommand{\\Statex}{\\item[]}',
        '\\providecommand{\\Require}{\\REQUIRE}',
        '\\providecommand{\\Ensure}{\\ENSURE}',
        '\\providecommand{\\Return}{\\textbf{return}}',
    ].join('\n');
    const parts = [project.documentclass];
    if (passOptionLines.length)
        parts.push(passOptionLines.join('\n'));
    parts.push(project.targetPreamble.trim());
    parts.push(`\\icmltitlerunning{${runningTitle}}`);
    parts.push(compatibilityMacros);
    parts.push('\\begin{document}');
    parts.push([
        '\\twocolumn[',
        `  \\icmltitle{${titleContent}}`,
        '  \\vskip 0.3in',
        ']',
        '\\printAffiliationsAndNotice{}',
    ].join('\n'));
    if (project.abstract) {
        parts.push(`\\begin{abstract}\n${project.abstract.trim()}\n\\end{abstract}`);
    }
    if (project.mainBody)
        parts.push(project.mainBody.trim());
    const bibliographyStyle = project.bibliographyStyle.trim() || defaultBibliographystyle(project.targetKind);
    const bibliographyBlock = project.bibliographyBlock.trim();
    if (bibliographyBlock) {
        parts.push(bibliographyStyle);
        parts.push(bibliographyBlock);
    }
    if (project.appendixBody.trim())
        parts.push(project.appendixBody.trim());
    parts.push('\\end{document}');
    return parts.filter((p) => p && p.trim()).join('\n\n') + '\n';
}
export function renderSubmissionSafeguards(project) {
    void project;
    return '';
}
export function renderPostMaketitleSubmissionSafeguards(_project) {
    return '';
}
function templateWantsLineNumbers(targetPreamble, targetKind) {
    const maskedPreamble = maskComments(targetPreamble);
    const optsFor = (packageName) => {
        const re = new RegExp(`\\\\usepackage(?:\\[([^\\]]*)\\])?\\{${reEscape(packageName)}\\}`);
        const match = maskedPreamble.match(re);
        if (!match)
            return new Set();
        return new Set((match[1] || '').split(',').map((s) => s.trim()).filter(Boolean));
    };
    if (targetKind === 'acl') {
        return optsFor('acl').has('review');
    }
    if (targetKind === 'cvpr') {
        const options = optsFor('cvpr');
        return options.has('review') || options.has('pagenumbers');
    }
    if (targetKind === 'neurips') {
        const options = optsFor('neurips_2026');
        return !options.has('preprint') && !options.has('final') && !options.has('nonanonymous');
    }
    return false;
}
function stripSourceLineNumberDisablers(text) {
    let cleaned = text;
    const patterns = [
        /^\s*\\nolinenumbers\s*$/gm,
        /^\s*\\AtBeginDocument\s*\{\s*\\nolinenumbers\s*\}\s*$/gm,
        /^\s*\\internallinenumbers\s*$/gm,
    ];
    for (const pattern of patterns) {
        cleaned = cleaned.replace(pattern, '');
    }
    return cleaned.trim();
}
export function stripLayoutModifyingCommands(sourcePreamble) {
    let cleaned = sourcePreamble;
    let removed = 0;
    const lengthPattern = LAYOUT_LENGTH_NAMES.join('|');
    const patterns = [
        new RegExp(`^\\s*\\\\(?:setlength|addtolength)\\s*\\{\\\\(?:${lengthPattern})\\}\\s*\\{[^}]*\\}\\s*$`, 'gm'),
        new RegExp(`^\\s*\\\\(?:setlength|addtolength)\\s*\\\\(?:${lengthPattern})\\s*\\{[^}]*\\}\\s*$`, 'gm'),
        /^\s*\\(?:geometry|newgeometry)\s*\{[^}]*\}\s*$/gm,
        /^\s*\\restoregeometry\s*$/gm,
        /^\s*\\(?:pagestyle|thispagestyle|pagenumbering)\s*\{[^}]*\}\s*$/gm,
    ];
    for (const pattern of patterns) {
        const r = subn(cleaned, pattern, '');
        cleaned = r.text;
        removed += r.count;
    }
    const warnings = [];
    if (removed) {
        warnings.push(`Removed ${removed} source preamble command(s) that alter page layout or pagination so the output stays within the target template.`);
    }
    return [cleaned.trim(), warnings];
}
export function stripAutoresubmitInjectedBlocks(sourcePreamble) {
    let cleaned = sourcePreamble.replace(/% Keep review-mode line numbers readable around wide floats in direct submission PDFs\.[\s\S]*?\\makeatother\s*/, '');
    cleaned = cleaned.replace(/\\makeatletter\s*% lineno's built-in switching is page-based, so in two-column ACL review mode it leaves[\s\S]*?\\makeatother\s*/, '');
    return cleaned.trim();
}
export function normalizeTargetSubmissionMode(targetPreamble, targetKind) {
    let normalized = targetPreamble;
    if (targetKind === 'acl') {
        return normalizeUsepackageOptions(normalized, 'acl', new Set(['review']), new Set(['final', 'preprint']));
    }
    if (targetKind === 'cvpr') {
        return normalizeUsepackageOptions(normalized, 'cvpr', new Set(['review']), new Set(['pagenumbers']));
    }
    if (targetKind === 'neurips') {
        return normalizeUsepackageOptions(normalized, 'neurips_2026', new Set(), new Set(['final', 'preprint', 'nonanonymous']));
    }
    if (targetKind === 'icml') {
        return normalizeUsepackageOptions(normalized, 'icml2026', new Set(), new Set(['accepted', 'preprint']));
    }
    if (targetKind === 'iclr') {
        return normalized.replace(/^\s*\\iclrfinalcopy\s*$/gm, '').trim();
    }
    if (targetKind === 'aaai') {
        return normalizeUsepackageOptions(normalized, 'aaai2026', new Set(['submission']), new Set());
    }
    return normalized.trim();
}
export function normalizeUsepackageOptions(preamble, packageName, add, remove) {
    const pattern = new RegExp(`^(?<indent>\\s*)\\\\usepackage(?:\\[(?<options>[^\\]]*)\\])?\\{${reEscape(packageName)}\\}(?<suffix>\\s*(?:%.*)?)$`, 'm');
    let replaced = false;
    const out = preamble.replace(pattern, (...args) => {
        replaced = true;
        const groups = args[args.length - 1];
        const existing = (groups.options || '')
            .split(',')
            .map((o) => o.trim())
            .filter((o) => o.length > 0);
        let filtered = existing.filter((o) => !remove.has(o));
        for (const opt of [...add].sort()) {
            if (!filtered.includes(opt))
                filtered.push(opt);
        }
        const optionBlock = filtered.length ? `[${filtered.join(',')}]` : '';
        const suffix = groups.suffix || '';
        return `${groups.indent}\\usepackage${optionBlock}{${packageName}}${suffix}`;
    });
    return replaced ? out.trim() : preamble.trim();
}
export async function detectTargetKind(rootDir) {
    const filenames = new Set();
    for (const entry of await rglob(rootDir)) {
        if (entry.isFile)
            filenames.add(path.basename(entry.path).toLowerCase());
    }
    if (filenames.has('aaai2026.sty'))
        return 'aaai';
    if (filenames.has('cvpr.sty'))
        return 'cvpr';
    if (filenames.has('iclr2026_conference.sty'))
        return 'iclr';
    if (filenames.has('icml2026.sty'))
        return 'icml';
    if (filenames.has('neurips_2026.sty'))
        return 'neurips';
    if (filenames.has('acl.sty'))
        return 'acl';
    return 'generic';
}
export function defaultBibliographystyle(targetKind) {
    return String(getTemplateConfig(targetKind).defaultBibliographystyle || '');
}
export function extractMacroContent(block) {
    if (!block)
        return '';
    const openBrace = block.indexOf('{');
    if (openBrace === -1)
        return '';
    const closeBrace = findMatchingBrace(block, openBrace);
    return block.slice(openBrace + 1, closeBrace).trim();
}
export function collapseTitleForRunningHead(title) {
    let collapsed = title.replace(/(?<!\\)%.*/g, '');
    collapsed = collapsed.replace(/\\includesvg(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/g, '');
    collapsed = collapsed.replace(/\\hspace\*?\s*\{[^}]+\}/g, ' ');
    collapsed = collapsed.replace(/\\\\/g, ' ');
    collapsed = collapsed.replace(/\s+/g, ' ');
    return collapsed.trim();
}
export function addInferredSourcePackages(sourcePreamble, bodyText) {
    const { packages: existingPackages } = parseUsepackageLines(sourcePreamble);
    const existingPackageNames = new Set(existingPackages.map((p) => p.name));
    const inferredPackages = [];
    const inferredMacros = [];
    const combinedText = `${sourcePreamble}\n${bodyText}`;
    const inferenceRules = [
        [['\\begin{algorithm}', '\\begin{algorithm*}'], 'algorithm'],
        [
            [
                '\\begin{algorithmic}',
                '\\State',
                '\\Statex',
                '\\Require',
                '\\Ensure',
                '\\Return',
                '\\Comment',
            ],
            'algorithmic',
        ],
        [['\\resizebox', '\\scalebox', '\\rotatebox', '\\includegraphics'], 'graphicx'],
        [['\\multirow'], 'multirow'],
        [['\\toprule', '\\midrule', '\\bottomrule', '\\cmidrule'], 'booktabs'],
        [['\\rowcolor', '\\cellcolor', '\\columncolor'], 'colortbl'],
        [['\\text{', '\\eqref{', '\\dfrac', '\\overset', '\\underset'], 'amsmath'],
        [['\\triangleq', '\\mathbb', '\\mathfrak', '\\leqslant', '\\geqslant'], 'amssymb'],
        [['\\mathscr'], 'mathrsfs'],
        [['\\xspace'], 'xspace'],
        [['\\begin{enumerate}[', '\\begin{itemize}['], 'enumitem'],
        [['\\DeclareCaptionStyle', '\\captionsetup', '\\captionof'], 'caption'],
    ];
    const tokenMatched = (token) => {
        if (/^\\[A-Za-z@]+$/.test(token)) {
            const pattern = new RegExp(`${reEscape(token)}(?![A-Za-z@])`);
            return pattern.test(combinedText);
        }
        return combinedText.includes(token);
    };
    for (const [tokens, packageName] of inferenceRules) {
        if (existingPackageNames.has(packageName))
            continue;
        if (packageName === 'algorithmic' && (existingPackageNames.has('algorithmic')
            || existingPackageNames.has('algorithmicx')
            || existingPackageNames.has('algpseudocode')))
            continue;
        if (tokens.some((t) => tokenMatched(t))) {
            inferredPackages.push(`\\usepackage{${packageName}}`);
            existingPackageNames.add(packageName);
        }
    }
    if (combinedText.includes('\\begin{links}') || combinedText.includes('\\link{')) {
        inferredMacros.push('\\providecommand{\\link}[2]{\\item \\textbf{#1}: \\url{#2}}');
        inferredMacros.push('\\newenvironment{links}{\\begin{itemize}}{\\end{itemize}}');
    }
    if (inferredPackages.length === 0 && inferredMacros.length === 0) {
        return sourcePreamble;
    }
    const additions = [...inferredPackages, ...inferredMacros];
    return `${sourcePreamble.trim()}\n\n% Inferred from source body during conversion\n${additions.join('\n')}`;
}
export function stripAlgorithmCompatibilityLines(sourcePreamble) {
    return sourcePreamble.replace(/^\s*\\newcommand\{\\theHalgorithm\}.*$/gm, '').trim();
}
export function extractPreservedSourcePreamble(preamble) {
    const markers = [
        '% Added from the source project to preserve paper content',
        '% Source project macros and local configuration',
    ];
    const starts = markers
        .map((m) => preamble.indexOf(m))
        .filter((i) => i !== -1);
    if (starts.length === 0)
        return preamble;
    return preamble.slice(Math.min(...starts)).trim();
}
export function stripSourceTemplatePackages(sourcePreamble, sourceKind) {
    const stripPackages = getTemplateConfig(sourceKind).sourceStripPackages;
    if (!stripPackages || stripPackages.size === 0)
        return sourcePreamble;
    const { packages, remaining } = parseUsepackageLines(sourcePreamble);
    const keptLines = [];
    for (const pkg of packages) {
        if (stripPackages.has(pkg.name))
            continue;
        if (sourceKind === 'neurips' && isNeuripsStylePackage(pkg.name))
            continue;
        const optionsPrefix = pkg.options.length ? `[${pkg.options.join(',')}]` : '';
        keptLines.push(`\\usepackage${optionsPrefix}{${pkg.name}}`);
    }
    const parts = [];
    if (keptLines.length)
        parts.push(keptLines.join('\n'));
    if (remaining.trim())
        parts.push(remaining.trim());
    return parts.join('\n\n').trim();
}
function isNeuripsStylePackage(packageName) {
    return /^neurips(?:_[0-9]{4})?$/.test(String(packageName || '').trim());
}
export function stripSourceTemplateCommands(sourcePreamble, sourceKind) {
    const commands = getTemplateConfig(sourceKind).sourceStripCommands || [];
    let cleaned = sourcePreamble;
    for (const command of commands) {
        cleaned = cleaned.replace(new RegExp(`^\\s*\\\\${reEscape(command)}\\s*$`, 'gm'), '');
    }
    return cleaned.trim();
}
