import { promises as fs } from 'fs';
import path from 'path';
import { safeJoin } from '../../../utils/pathUtils.js';
import { ensureDir, listFilesRecursive } from '../../../utils/fsUtils.js';

/**
 * Check if a file exists at the given absolute path.
 */
async function fileExists(absPath) {
  try {
    await fs.access(absPath);
    return true;
  } catch {
    return false;
  }
}

/**
 * Copy a single asset file from source to target project.
 * If target already has a file with the same name, place it under assets/source/.
 */
async function copySingleAsset(srcRoot, destRoot, relPath) {
  const srcAbs = safeJoin(srcRoot, relPath);
  if (!(await fileExists(srcAbs))) return { path: relPath, status: 'missing' };

  let destRel = relPath;
  const destAbs = safeJoin(destRoot, relPath);

  if (await fileExists(destAbs)) {
    // Conflict: place under assets/source/
    destRel = path.join('assets', 'source', relPath);
  }

  const finalAbs = safeJoin(destRoot, destRel);
  await ensureDir(path.dirname(finalAbs));
  await fs.copyFile(srcAbs, finalAbs);
  return { path: relPath, destRel, status: destRel !== relPath ? 'conflict' : 'copied' };
}

/**
 * Legacy mode: copy bib files, images, and style files from source project.
 */
async function copyAssetsLegacy(state) {
  const assets = state.sourceAssets || {};
  const results = [];

  for (const bib of (assets.bib || [])) {
    const r = await copySingleAsset(state.sourceProjectRoot, state.targetProjectRoot, bib);
    results.push(r);
  }

  for (const img of (assets.images || [])) {
    const r = await copySingleAsset(state.sourceProjectRoot, state.targetProjectRoot, img);
    results.push(r);
  }

  for (const sty of (assets.styles || [])) {
    const destAbs = safeJoin(state.targetProjectRoot, sty);
    if (!(await fileExists(destAbs))) {
      const r = await copySingleAsset(state.sourceProjectRoot, state.targetProjectRoot, sty);
      results.push(r);
    }
  }

  const copied = results.filter(r => r.status === 'copied').length;
  const conflicts = results.filter(r => r.status === 'conflict').length;
  const missing = results.filter(r => r.status === 'missing').length;

  return {
    progressLog: `[copyAssets] Copied ${copied} files, ${conflicts} conflicts (relocated), ${missing} missing.`,
  };
}

/**
 * MinerU mode: copy MinerU-extracted images to target project images/ dir,
 * and optionally copy bib files from source project if available.
 */
async function copyAssetsMineru(state) {
  const images = state.sourceImages || [];
  let copiedCount = 0;
  let renamedCount = 0;

  // Copy MinerU-extracted images to target project images/
  const imagesDir = path.join(state.targetProjectRoot, 'images');
  await ensureDir(imagesDir);
  const usedNames = new Set();

  for (const img of images) {
    const originalName = path.basename(img.name || img.localPath || 'image');
    const ext = path.extname(originalName);
    const stem = ext ? originalName.slice(0, -ext.length) : originalName;
    let finalName = originalName;
    let suffix = 2;
    while (usedNames.has(finalName) || await fileExists(path.join(imagesDir, finalName))) {
      finalName = `${stem}__dup${suffix}${ext}`;
      suffix++;
    }
    usedNames.add(finalName);
    if (finalName !== originalName) renamedCount++;

    const destPath = path.join(imagesDir, finalName);
    if (await fileExists(img.localPath)) {
      await fs.copyFile(img.localPath, destPath);
      copiedCount++;
    }
  }

  // Copy bib files from source project if available
  let bibCount = 0;
  if (state.sourceProjectRoot) {
    let bibCandidates = state.sourceAssets?.bib || [];
    if (!bibCandidates.length) {
      const allFiles = await listFilesRecursive(state.sourceProjectRoot);
      bibCandidates = allFiles
        .filter(f => f.type === 'file' && path.extname(f.path).toLowerCase() === '.bib')
        .map(f => f.path);
    }

    for (const bib of [...new Set(bibCandidates)]) {
      const r = await copySingleAsset(
        state.sourceProjectRoot, state.targetProjectRoot, bib
      );
      if (r.status === 'copied') bibCount++;
    }
  }

  return {
    progressLog: `[copyAssets:mineru] Copied ${copiedCount} images (${renamedCount} renamed to avoid conflicts), ${bibCount} bib files.`,
  };
}

/**
 * copyAssets node — dispatches to legacy or MinerU mode.
 */
export async function copyAssets(state) {
  if (state.transferMode === 'mineru') {
    return copyAssetsMineru(state);
  }
  return copyAssetsLegacy(state);
}
