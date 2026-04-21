import { promises as fs } from 'fs';
import path from 'path';
import crypto from 'crypto';
import { buildSourceRepresentation, buildTargetRepresentation, mergePreambles, renderMergedTex, } from './latex.js';
const SOURCE_ASSET_SUFFIXES = new Set([
    '.bib',
    '.bmp',
    '.csv',
    '.eps',
    '.jpeg',
    '.jpg',
    '.json',
    '.pdf',
    '.png',
    '.svg',
    '.tsv',
]);
const REMOVABLE_SUFFIXES = new Set([
    '.aux',
    '.bbl',
    '.bcf',
    '.blg',
    '.fdb_latexmk',
    '.fls',
    '.log',
    '.nav',
    '.out',
    '.run.xml',
    '.snm',
    '.toc',
    '.vrb',
    '.xdv',
]);
const REMOVABLE_NAMES = new Set(['tectonic.log']);
export async function runConversion({ sourceDir, targetTemplateDir, outputDir, outputMainName = 'main.tex', }) {
    if (!(await pathExists(sourceDir))) {
        throw new Error(`Source directory not found: ${sourceDir}`);
    }
    if (!(await pathExists(targetTemplateDir))) {
        throw new Error(`Target template directory not found: ${targetTemplateDir}`);
    }
    await resetOutputDirectory(outputDir);
    const source = await buildSourceRepresentation(sourceDir);
    const target = await buildTargetRepresentation(targetTemplateDir);
    const [mergedPreamble, passOptions] = mergePreambles(target.targetPreamble, source.sourcePreamble, target.targetKind);
    const sourceMainRel = path.relative(sourceDir, source.mainTex);
    const generatedDir = path.join(outputDir, path.dirname(sourceMainRel));
    await fs.mkdir(generatedDir, { recursive: true });
    const targetTemplateBaseDir = path.dirname(target.mainTex);
    for (const templateFile of await walkFiles(targetTemplateBaseDir)) {
        const rel = path.relative(targetTemplateBaseDir, templateFile);
        const destination = path.join(generatedDir, rel);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(templateFile, destination);
    }
    await copySourceSupportFiles({
        sourceDir,
        sourceMainTex: source.mainTex,
        sourceMainDir: path.dirname(source.mainTex),
        generatedDir,
        mainBody: source.mainBody,
        bibliographyBlock: source.bibliographyBlock,
        appendixBody: source.appendixBody,
    });
    const includeChecklist = target.targetKind === 'neurips'
        && (await pathExists(path.join(generatedDir, 'checklist.tex')));
    const project = {
        rootDir: outputDir,
        targetKind: target.targetKind,
        documentclass: target.documentclass,
        titleBlock: source.titleBlock,
        authorBlock: source.authorBlock,
        dateBlock: source.dateBlock,
        targetPreamble: mergedPreamble,
        sourceMacroPreamble: source.sourcePreamble,
        passOptions,
        abstract: source.abstract,
        mainBody: source.mainBody,
        bibliographyStyle: source.bibliographyStyle,
        bibliographyBlock: source.bibliographyBlock,
        appendixBody: source.appendixBody,
    };
    let renderedTex = renderMergedTex(project, includeChecklist);
    const fixResult = applySafeTexFixes(renderedTex, target.targetKind);
    renderedTex = fixResult.text;
    const warnings = [...source.warnings, ...fixResult.warnings];
    const generatedMainTexInOutput = path.join(generatedDir, outputMainName);
    await fs.writeFile(generatedMainTexInOutput, renderedTex, 'utf8');
    const compileEntry = generatedMainTexInOutput;
    const copiedAssetCount = await countCopiedAssets(outputDir);
    const audit = buildContentAudit({
        sourceMainTex: source.mainTex,
        generatedMainTex: generatedMainTexInOutput,
        abstract: source.abstract,
        mainBody: source.mainBody,
        bibliographyStyle: source.bibliographyStyle,
        bibliographyBlock: source.bibliographyBlock,
        appendixBody: source.appendixBody,
        copiedAssetCount,
    });
    const auditPath = path.join(outputDir, 'content_audit.json');
    await fs.writeFile(auditPath, `${JSON.stringify(audit, null, 2)}\n`, 'utf8');
    const manifestPath = path.join(outputDir, 'conversion_manifest.json');
    const manifest = {
        source_dir: sourceDir,
        target_template_dir: targetTemplateDir,
        source_main_tex: path.relative(sourceDir, source.mainTex),
        target_main_tex: path.relative(targetTemplateDir, target.mainTex),
        target_kind: target.targetKind,
        generated_main_tex: path.relative(outputDir, generatedMainTexInOutput),
        compile_entry: path.relative(outputDir, compileEntry),
        content_audit: path.relative(outputDir, auditPath),
        warnings,
    };
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    return {
        projectDir: outputDir,
        mainTex: generatedMainTexInOutput,
        manifestPath,
        auditPath,
        targetKind: target.targetKind,
        warnings,
    };
}
async function pathExists(p) {
    try {
        await fs.access(p);
        return true;
    }
    catch {
        return false;
    }
}
async function resetOutputDirectory(dir) {
    await fs.mkdir(dir, { recursive: true });
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.isFile() && entry.name === 'project.json') {
            continue;
        }
        await fs.rm(path.join(dir, entry.name), { recursive: true, force: true });
    }
}
async function copyTreeInto(src, dest) {
    await fs.mkdir(dest, { recursive: true });
    const entries = await fs.readdir(src, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === 'project.json' || entry.name === '.compile') {
            continue;
        }
        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);
        if (entry.isDirectory()) {
            await copyTreeInto(srcPath, destPath);
        }
        else if (entry.isFile()) {
            await fs.copyFile(srcPath, destPath);
        }
    }
}
async function walkFiles(rootDir) {
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
                await walk(full);
            }
            else if (entry.isFile()) {
                results.push(full);
            }
        }
    }
    await walk(rootDir);
    results.sort();
    return results;
}
async function pruneLatexBuildArtifacts(projectDir) {
    for (const file of await walkFiles(projectDir)) {
        const base = path.basename(file);
        const ext = path.extname(file).toLowerCase();
        if (REMOVABLE_NAMES.has(base) || REMOVABLE_SUFFIXES.has(ext)) {
            try {
                await fs.unlink(file);
            }
            catch { }
        }
    }
}
async function countCopiedAssets(projectDir) {
    let count = 0;
    for (const file of await walkFiles(projectDir)) {
        if (path.extname(file) !== '.tex')
            count += 1;
    }
    return count;
}
async function copySourceSupportFiles({ sourceDir, sourceMainTex, sourceMainDir, generatedDir, mainBody, bibliographyBlock, appendixBody, }) {
    const referencedTexRel = collectReferencedTexRelPaths(`${mainBody}\n${appendixBody}`);
    const referencedBibRel = collectReferencedBibRelPaths(bibliographyBlock);
    for (const file of await walkFiles(sourceMainDir)) {
        const base = path.basename(file);
        const ext = path.extname(file).toLowerCase();
        if (base === 'project.json' || base === '.compile')
            continue;
        if (REMOVABLE_NAMES.has(base) || REMOVABLE_SUFFIXES.has(ext))
            continue;
        if (path.resolve(file) === path.resolve(sourceMainTex))
            continue;
        const relToMainDir = path.relative(sourceMainDir, file);
        const relNoExt = ext ? relToMainDir.slice(0, -ext.length) : relToMainDir;
        if (ext === '.tex') {
            if (!referencedTexRel.has(relToMainDir) && !referencedTexRel.has(relNoExt)) {
                continue;
            }
        }
        if (ext === '.bib') {
            if (referencedBibRel.size > 0 && !referencedBibRel.has(relToMainDir) && !referencedBibRel.has(relNoExt)) {
                continue;
            }
        }
        const destination = path.join(generatedDir, relToMainDir);
        await fs.mkdir(path.dirname(destination), { recursive: true });
        await fs.copyFile(file, destination);
    }
}
function collectReferencedTexRelPaths(text) {
    const refs = new Set();
    const pattern = /\\(?:input|include)\{([^}]+)\}/g;
    for (const match of text.matchAll(pattern)) {
        const raw = match[1].trim();
        if (!raw)
            continue;
        refs.add(raw);
        if (!raw.endsWith('.tex'))
            refs.add(`${raw}.tex`);
    }
    return refs;
}
function collectReferencedBibRelPaths(text) {
    const refs = new Set();
    const pattern = /\\bibliography(?:\[[^\]]*\])?\{([^}]+)\}/g;
    for (const match of text.matchAll(pattern)) {
        const entries = match[1].split(',').map((s) => s.trim()).filter(Boolean);
        for (const raw of entries) {
            refs.add(raw);
            if (!raw.endsWith('.bib'))
                refs.add(`${raw}.bib`);
        }
    }
    return refs;
}
function buildContentAudit({ sourceMainTex, generatedMainTex, abstract, mainBody, bibliographyStyle, bibliographyBlock, appendixBody, copiedAssetCount, }) {
    return {
        source_main_tex: sourceMainTex,
        generated_main_tex: generatedMainTex,
        segments: {
            abstract: segmentFingerprint(abstract),
            main_body: segmentFingerprint(mainBody),
            bibliography_style: segmentFingerprint(bibliographyStyle),
            bibliography_block: segmentFingerprint(bibliographyBlock),
            appendix_body: segmentFingerprint(appendixBody),
        },
        copied_asset_count: copiedAssetCount,
    };
}
function segmentFingerprint(text) {
    const value = text || '';
    const raw = Buffer.from(value, 'utf8');
    return {
        chars: value.length,
        lines: value.split('\n').length - (value.length === 0 ? 1 : (value.endsWith('\n') ? 1 : 0)),
        sha256: crypto.createHash('sha256').update(raw).digest('hex'),
    };
}
function applySafeTexFixes(text, targetKind) {
    const warnings = [];
    let out = text;
    let count;
    ({ out, count } = subnAll(out, /(?<!\\)\\(?=\d+\.\d)/g, ''));
    if (count) {
        warnings.push(`Applied ${count} compile-safe fix(es) for invalid backslashes directly before decimal numbers.`);
    }
    ({ out, count } = subnAll(out, /\\includesvg(?:\s*\[[^\]]*\])?\s*\{[^}]+\}/g, ''));
    if (count) {
        warnings.push(`Removed ${count} inline SVG include(s) because the current build environment does not provide an SVG conversion backend.`);
    }
    ({ out, count } = subnAll(out, /\\newcommand\\(red)(?=\s*\[)/g, '\\providecommand\\$1'));
    if (count) {
        warnings.push(`Downgraded ${count} potentially conflicting color macro definition(s) to \\providecommand for template compatibility.`);
    }
    if (targetKind === 'aaai') {
        ({ out, count } = subnAll(out, /^\s*\\(?:clearpage|newpage|pagebreak)\s*$/gm, ''));
        if (count) {
            warnings.push(`Removed ${count} page-break command(s) that violate AAAI formatting constraints.`);
        }
    }
    return { text: out, warnings };
}
function subnAll(text, regex, replacement) {
    let count = 0;
    const out = text.replace(regex, (...args) => {
        count += 1;
        if (typeof replacement === 'function')
            return replacement(...args);
        return replacement;
    });
    return { out, count };
}
