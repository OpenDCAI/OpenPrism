import { spawn } from 'child_process';
import os from 'os';
import path from 'path';
import { DATA_DIR } from '../config/constants.js';

const LATEX_COMMANDS = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'];
const PYTHON_CANDIDATES = ['python3', 'python'];

if (process.env.OPENPRISM_PYTHON) {
  PYTHON_CANDIDATES.unshift(process.env.OPENPRISM_PYTHON);
}
if (process.env.CONDA_PREFIX) {
  PYTHON_CANDIDATES.unshift(path.join(process.env.CONDA_PREFIX, 'bin', 'python'));
}

function runCommand(cmd, args, timeoutMs = 4000) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe']
    });

    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      proc.kill('SIGKILL');
      resolve({ ok: false, error: 'timeout', stdout, stderr });
    }, timeoutMs);

    proc.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });
    proc.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      resolve({ ok: false, error: String(err), stdout, stderr });
    });

    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve({ ok: code === 0, code: code ?? -1, stdout, stderr });
    });
  });
}

function firstLine(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
}

async function checkLatexCommands() {
  const result = {};
  for (const cmd of LATEX_COMMANDS) {
    const checked = await runCommand(cmd, ['--version']);
    result[cmd] = {
      ok: checked.ok,
      version: firstLine(`${checked.stdout}\n${checked.stderr}`),
      error: checked.ok ? '' : firstLine(checked.stderr || checked.error || '')
    };
  }
  return result;
}

async function detectPython() {
  const tried = [];
  for (const cmd of PYTHON_CANDIDATES) {
    if (!cmd || tried.includes(cmd)) continue;
    tried.push(cmd);
    const probe = await runCommand(cmd, ['-c', 'import sys;print(sys.executable)']);
    if (!probe.ok) continue;
    const versionProbe = await runCommand(cmd, ['--version']);
    return {
      command: cmd,
      executable: firstLine(probe.stdout),
      version: firstLine(versionProbe.stdout) || firstLine(versionProbe.stderr)
    };
  }
  return null;
}

async function detectPythonPackages(pythonCommand) {
  if (!pythonCommand) {
    return {
      matplotlib: false,
      pandas: false,
      seaborn: false
    };
  }
  const script = [
    'import importlib.util, json',
    'print(json.dumps({',
    '  "matplotlib": importlib.util.find_spec("matplotlib") is not None,',
    '  "pandas": importlib.util.find_spec("pandas") is not None,',
    '  "seaborn": importlib.util.find_spec("seaborn") is not None',
    '}))'
  ].join(';');
  const res = await runCommand(pythonCommand, ['-c', script]);
  if (!res.ok) {
    return {
      matplotlib: false,
      pandas: false,
      seaborn: false
    };
  }
  try {
    return JSON.parse(firstLine(res.stdout) || '{}');
  } catch {
    return {
      matplotlib: false,
      pandas: false,
      seaborn: false
    };
  }
}

export function registerDesktopRoutes(fastify) {
  fastify.get('/api/desktop/diagnostics', async () => {
    const latex = await checkLatexCommands();
    const python = await detectPython();
    const pythonPackages = await detectPythonPackages(python?.command || '');
    return {
      ok: true,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      hostname: os.hostname(),
      dataDir: DATA_DIR,
      latex,
      python: {
        ok: Boolean(python),
        command: python?.command || '',
        executable: python?.executable || '',
        version: python?.version || '',
        packages: pythonPackages
      }
    };
  });
}
