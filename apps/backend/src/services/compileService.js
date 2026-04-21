import crypto from 'crypto';
import path from 'path';
import { promises as fs } from 'fs';
import { spawn } from 'child_process';
import { ensureDir } from '../utils/fsUtils.js';
import { safeJoin } from '../utils/pathUtils.js';
import { getProjectRoot } from './projectService.js';

const SUPPORTED_ENGINES = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'];

function buildCommand(engine, mainFile) {
  switch (engine) {
    case 'pdflatex':
    case 'xelatex':
    case 'lualatex':
      return { cmd: engine, args: ['-interaction=nonstopmode', mainFile] };
    case 'latexmk':
      return { cmd: 'latexmk', args: ['-pdf', '-interaction=nonstopmode', mainFile] };
    case 'tectonic':
      return { cmd: 'tectonic', args: [mainFile] };
    default:
      return null;
  }
}

export { SUPPORTED_ENGINES };

// Engines that need multiple passes + bibtex for citations
const MULTI_PASS_ENGINES = ['pdflatex', 'xelatex', 'lualatex'];

function runSpawn(cmd, args, cwd, pushLog, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { cwd, env: env || process.env });
    child.stdout.on('data', pushLog);
    child.stderr.on('data', pushLog);
    child.on('error', (err) => reject(err));
    child.on('close', (code) => resolve(code));
  });
}

export async function runCompile({ projectId, mainFile, engine = 'pdflatex' }) {
  if (!SUPPORTED_ENGINES.includes(engine)) {
    return { ok: false, error: `Unsupported engine: ${engine}` };
  }

  const projectRoot = await getProjectRoot(projectId);
  const absMain = safeJoin(projectRoot, mainFile);
  await fs.access(absMain);

  const buildRoot = path.join(projectRoot, '.compile');
  await ensureDir(buildRoot);
  const runId = crypto.randomUUID();
  const outDir = path.join(buildRoot, runId);
  await ensureDir(outDir);

  const logChunks = [];
  const MAX_LOG_BYTES = 200_000;
  const pushLog = (chunk) => {
    if (!chunk) return;
    const next = chunk.toString();
    const currentSize = logChunks.reduce((sum, item) => sum + item.length, 0);
    if (currentSize >= MAX_LOG_BYTES) return;
    const remaining = MAX_LOG_BYTES - currentSize;
    logChunks.push(next.slice(0, remaining));
  };

  const { cmd, args } = buildCommand(engine, mainFile);
  const needsBibPass = MULTI_PASS_ENGINES.includes(engine);

  // Copy all project files to output directory
  try {
    const files = await fs.readdir(projectRoot, { withFileTypes: true });
    for (const file of files) {
      if (file.name === '.compile' || file.name === 'node_modules') continue;
      const srcPath = path.join(projectRoot, file.name);
      const dstPath = path.join(outDir, file.name);
      if (file.isDirectory()) {
        await fs.cp(srcPath, dstPath, { recursive: true });
      } else {
        await fs.copyFile(srcPath, dstPath);
      }
    }
    pushLog(Buffer.from('[info] Copied project files to build directory.\n'));
  } catch (err) {
    await fs.rm(outDir, { recursive: true, force: true });
    return { ok: false, error: `Failed to copy project files: ${err.message}` };
  }

  let code;
  try {
    // Pass 1: generate .aux with \citation{} entries
    code = await runSpawn(cmd, args, outDir, pushLog);

    if (needsBibPass) {
      const base = path.basename(mainFile, path.extname(mainFile));
      const auxPath = path.join(outDir, `${base}.aux`);

      // Check if user-provided .bib files exist in the project.
      // IMPORTANT: check against the ORIGINAL project files (projectRoot),
      // not outDir, because Pass 1 may auto-generate .bib files
      // (e.g. revtex4-1 + apsrev4-1.bst creates *Notes.bib).
      // Using outDir would give a false positive and cause bibtex to run,
      // which overwrites the existing .bbl with an empty one.
      // Also skip empty/placeholder .bib files (< 50 bytes, e.g. template stubs).
      let hasUserBibFiles = false;
      try {
        const projFiles = await fs.readdir(projectRoot);
        const bibFiles = projFiles.filter(f => f.endsWith('.bib'));
        for (const bf of bibFiles) {
          try {
            const st = await fs.stat(path.join(projectRoot, bf));
            if (st.size >= 50) { hasUserBibFiles = true; break; }
          } catch { /* ignore */ }
        }
      } catch { /* ignore */ }

      // Also check if a pre-compiled .bbl already exists in the project
      const mainBblPath = path.join(outDir, `${base}.bbl`);
      let hasPrecompiledBbl = false;
      try {
        await fs.access(mainBblPath);
        hasPrecompiledBbl = true;
      } catch { /* no main.bbl yet */ }

      // If no .bbl with the main name, look for one that matches
      // \bibliography{} or \addbibresource{} or \input{*.bbl} references
      if (!hasPrecompiledBbl) {
        try {
          const texContent = await fs.readFile(path.join(outDir, mainFile), 'utf8');

          // Check if tex uses \input{something.bbl} — in that case,
          // the bbl is loaded directly and we don't need main.bbl at all.
          const inputBblRe = /\\input\s*\{\s*([^}]*\.bbl)\s*\}/g;
          let inputBblMatch;
          while ((inputBblMatch = inputBblRe.exec(texContent)) !== null) {
            const bblName = inputBblMatch[1].trim();
            const bblPath = path.join(outDir, bblName);
            try {
              const st = await fs.stat(bblPath);
              if (st.size > 100) {
                // The tex directly \input's a real .bbl file — skip bibtex entirely
                hasPrecompiledBbl = true;
                pushLog(Buffer.from(`[info] Found \\input{${bblName}} (${st.size} bytes); using it directly.\n`));
                break;
              }
            } catch { /* file not found, continue */ }
          }

          if (!hasPrecompiledBbl) {
            // Collect bibliography names from \bibliography{a,b} and \addbibresource{a.bib}
            const bibNames = [];
            const bibPatternTrad = /\\bibliography\{([^}]+)\}/g;
            let m;
            while ((m = bibPatternTrad.exec(texContent)) !== null) {
              m[1].split(',').forEach(ref => bibNames.push(ref.trim()));
            }
            const bibPatternRes = /\\addbibresource\{([^}]+)\}/g;
            while ((m = bibPatternRes.exec(texContent)) !== null) {
              bibNames.push(m[1].trim().replace(/\.bib$/i, ''));
            }

            // Try each matched name to find a corresponding .bbl and copy it
            for (const bibName of bibNames) {
              if (bibName === base) continue;
              const candidateBbl = path.join(outDir, `${bibName}.bbl`);
              try {
                await fs.access(candidateBbl);
                await fs.copyFile(candidateBbl, mainBblPath);
                hasPrecompiledBbl = true;
                pushLog(Buffer.from(`[info] Copied ${bibName}.bbl to ${base}.bbl for LaTeX to use.\n`));
                break;
              } catch { /* this .bbl not found, try next */ }
            }
          }

          // Fallback: if still no main.bbl, try any lone .bbl in the directory
          if (!hasPrecompiledBbl) {
            const allFiles = await fs.readdir(outDir);
            const bblFiles = allFiles.filter(f => f.endsWith('.bbl'));
            // If there's exactly one .bbl that's substantial (> 100 bytes), use it
            const realBbls = [];
            for (const bf of bblFiles) {
              try {
                const st = await fs.stat(path.join(outDir, bf));
                if (st.size > 100) realBbls.push(bf);
              } catch { /* ignore */ }
            }
            if (realBbls.length === 1) {
              await fs.copyFile(path.join(outDir, realBbls[0]), mainBblPath);
              hasPrecompiledBbl = true;
              pushLog(Buffer.from(`[info] Copied ${realBbls[0]} to ${base}.bbl (only substantial .bbl found).\n`));
            }
          }
        } catch { /* ignore */ }
      }

      if (!hasUserBibFiles) {
        // No user .bib files — do NOT run bibtex/biber as it would overwrite
        // the existing .bbl with an empty one. Just use whatever .bbl is available.
        if (hasPrecompiledBbl) {
          pushLog(Buffer.from(`[info] No .bib files found; using existing ${base}.bbl (skipping bibtex/biber).\n`));
        } else {
          pushLog(Buffer.from('[warn] No .bib or .bbl files found, citations will not resolve.\n'));
        }
      } else {
        // Detect whether to use biber or bibtex by checking .aux / source for biblatex
        let useBiber = false;
        try {
          const auxContent = await fs.readFile(auxPath, 'utf8');
          // biblatex writes \abx@aux@... commands in .aux; traditional bibtex does not
          useBiber = auxContent.includes('\\abx@aux@');
        } catch { /* .aux missing — skip bib pass */ }

        // Also check the source .tex for \usepackage{biblatex} as a fallback
        if (!useBiber) {
          try {
            const texContent = await fs.readFile(path.join(outDir, mainFile), 'utf8');
            useBiber = /\\usepackage(\[.*?\])?\{biblatex\}/.test(texContent);
          } catch { /* ignore */ }
        }

        const bibCmd = useBiber
          ? 'biber'
          : 'bibtex';
        const bibEnv = {
          ...process.env,
          BIBINPUTS: `${outDir}:`,
          BSTINPUTS: `${outDir}:`,
        };
        const bibArgs = useBiber ? [base] : [base];

        try {
          await runSpawn(bibCmd, bibArgs, outDir, pushLog, bibEnv);
        } catch {
          // bibtex/biber not installed or failed — continue without it
          pushLog(Buffer.from(`[warn] ${bibCmd} not available, skipping bibliography pass.\n`));
        }
      }

      // Pass 2 + 3: resolve citations and cross-references
      code = await runSpawn(cmd, args, outDir, pushLog);
      code = await runSpawn(cmd, args, outDir, pushLog);
    }
  } catch (err) {
    await fs.rm(outDir, { recursive: true, force: true });
    return { ok: false, error: `${engine} not available: ${err.message}` };
  }

  const base = path.basename(mainFile, path.extname(mainFile));
  const pdfPath = path.join(outDir, `${base}.pdf`);
  let pdfBase64 = '';
  try {
    const buffer = await fs.readFile(pdfPath);
    pdfBase64 = buffer.toString('base64');
  } catch {
    pdfBase64 = '';
  }

  // Copy all .bbl files back to project root
  try {
    const files = await fs.readdir(outDir);
    const bblFiles = files.filter(f => f.endsWith('.bbl'));
    for (const bblFile of bblFiles) {
      const srcPath = path.join(outDir, bblFile);
      const dstPath = path.join(projectRoot, bblFile);
      await fs.copyFile(srcPath, dstPath);
    }
    if (bblFiles.length > 0) {
      pushLog(Buffer.from(`[info] Copied ${bblFiles.length} .bbl file(s) back to project.\n`));
    }
  } catch {
    // Ignore errors copying .bbl files
  }

  const log = logChunks.join('');

  // Save compile log to project directory
  try {
    const logPath = path.join(projectRoot, 'compile.log');
    const timestamp = new Date().toISOString();
    const logContent = `=== Compile Log (${timestamp}) ===\nEngine: ${engine}\nMain File: ${mainFile}\n\n${log}`;
    await fs.writeFile(logPath, logContent, 'utf8');
  } catch {
    // Ignore errors saving log
  }

  await fs.rm(outDir, { recursive: true, force: true });
  if (!pdfBase64) {
    return { ok: false, error: 'No PDF generated.', log, status: code ?? -1 };
  }
  return { ok: true, pdf: pdfBase64, log, status: code ?? 0 };
}
