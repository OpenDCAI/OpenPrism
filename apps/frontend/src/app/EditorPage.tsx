import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, MouseEvent, SetStateAction, RefObject, DragEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { basicSetup } from 'codemirror';
import { latex } from '../latex/lang';
import { Compartment, EditorState, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, DecorationSet, WidgetType, keymap } from '@codemirror/view';
import { search, searchKeymap } from '@codemirror/search';
import { autocompletion, CompletionContext } from '@codemirror/autocomplete';
import { toggleComment } from '@codemirror/commands';
import { foldKeymap, foldService, indentOnInput } from '@codemirror/language';
import { GlobalWorkerOptions, getDocument, renderTextLayer } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  arxivBibtex,
  arxivSearch,
  createFolder as createFolderApi,
  createCollabInvite,
  compileProject,
  getAllFiles,
  getCollabServer,
  getFile,
  getProjectTree,
  getCollabToken,
  listProjects,
  renamePath,
  updateFileOrder,
  runAgent,
  plotFromTable,
  callLLM,
  uploadFiles,
  visionToLatex,
  writeFile,
  flushCollabFile,
  setCollabServer
} from '../api/client';
import type { ArxivPaper } from '../api/client';
import { createTwoFilesPatch, diffLines } from 'diff';
import type { CompileOutcome } from '../latex/engine';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { yCollab } from 'y-codemirror.next';
import { CollabProvider } from '../collab/provider';

GlobalWorkerOptions.workerSrc = pdfWorker;

interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface WebsearchItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  bibtex: string;
  citeKey: string;
}

interface PendingChange {
  filePath: string;
  original: string;
  proposed: string;
  diff: string;
}

type InlineEdit =
  | { kind: 'new-file' | 'new-folder'; parent: string; value: string }
  | { kind: 'rename'; path: string; value: string };

type CompileEngine = 'pdflatex' | 'xelatex' | 'lualatex' | 'latexmk' | 'tectonic';

type AppSettings = {
  llmEndpoint: string;
  llmApiKey: string;
  llmModel: string;
  searchEndpoint: string;
  searchApiKey: string;
  searchModel: string;
  visionEndpoint: string;
  visionApiKey: string;
  visionModel: string;
  compileEngine: CompileEngine;
};

const DEFAULT_TASKS = (t: (key: string) => string) => [
  { value: 'polish', label: t('润色') },
  { value: 'rewrite', label: t('改写') },
  { value: 'structure', label: t('结构调整') },
  { value: 'translate', label: t('翻译') },
  { value: 'websearch', label: t('检索 (arXiv)') },
  { value: 'custom', label: t('自定义') }
];

const RIGHT_VIEW_OPTIONS = (t: (key: string) => string) => [
  { value: 'pdf', label: 'PDF' },
  { value: 'toc', label: t('目录') },
  { value: 'figures', label: 'FIG' },
  { value: 'diff', label: 'DIFF' },
  { value: 'log', label: 'LOG' },
  { value: 'review', label: t('评审报告') }
];

const SETTINGS_KEY = 'openprism-settings-v1';
const DEFAULT_SETTINGS: AppSettings = {
  llmEndpoint: 'https://api.openai.com/v1/chat/completions',
  llmApiKey: '',
  llmModel: 'gpt-4o-mini',
  searchEndpoint: '',
  searchApiKey: '',
  searchModel: '',
  visionEndpoint: '',
  visionApiKey: '',
  visionModel: '',
  compileEngine: 'pdflatex'
};

const COLLAB_NAME_KEY = 'openprism-collab-name';
const COLLAB_COLORS = ['#b44a2f', '#2f6fb4', '#2f9b74', '#b48a2f', '#6b2fb4', '#b42f6d', '#2f8fb4'];

function loadSettings(): AppSettings {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(SETTINGS_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw) as Partial<AppSettings>;
    const engine = parsed.compileEngine;
    const VALID_ENGINES: CompileEngine[] = ['pdflatex', 'xelatex', 'lualatex', 'latexmk', 'tectonic'];
    const compileEngine: CompileEngine =
      VALID_ENGINES.includes(engine as CompileEngine)
        ? (engine as CompileEngine)
        : DEFAULT_SETTINGS.compileEngine;
    return {
      ...DEFAULT_SETTINGS,
      ...parsed,
      compileEngine
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function persistSettings(settings: AppSettings) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
  } catch {
    // ignore
  }
}

function loadCollabName() {
  if (typeof window === 'undefined') return '';
  try {
    return window.localStorage.getItem(COLLAB_NAME_KEY) || '';
  } catch {
    return '';
  }
}

function persistCollabName(name: string) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(COLLAB_NAME_KEY, name);
  } catch {
    // ignore
  }
}

function pickCollabColor(seed?: string) {
  if (!seed) {
    return COLLAB_COLORS[Math.floor(Math.random() * COLLAB_COLORS.length)];
  }
  let hash = 0;
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash * 31 + seed.charCodeAt(i)) % 997;
  }
  return COLLAB_COLORS[hash % COLLAB_COLORS.length];
}

function normalizeServerUrl(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  return `http://${trimmed}`;
}

const FIGURE_EXTS = ['.png', '.jpg', '.jpeg', '.pdf', '.svg', '.eps'];
const TEXT_EXTS = ['.sty', '.cls', '.bst', '.txt', '.md', '.json', '.yaml', '.yml', '.csv', '.tsv'];

function isTextPath(filePath: string) {
  const lower = filePath.toLowerCase();
  return lower.endsWith('.tex') || lower.endsWith('.bib') || TEXT_EXTS.some((ext) => lower.endsWith(ext));
}

const SECTION_LEVELS: Record<string, number> = {
  section: 1,
  subsection: 2,
  subsubsection: 3,
  paragraph: 4,
  subparagraph: 5
};

const SECTION_RE = /\\(section|subsection|subsubsection|paragraph|subparagraph)\*?\b/;
const ENV_RE = /\\(begin|end)\{([^}]+)\}/g;
const IF_START_RE = /\\if[a-zA-Z@]*\b/g;
const IF_END_RE = /\\fi\b/g;
const IF_START_TEST = /\\if[a-zA-Z@]*\b/;
const GROUP_START_RE = /\\begingroup\b/g;
const GROUP_END_RE = /\\endgroup\b/g;
const GROUP_START_TEST = /\\begingroup\b/;

function stripLatexComment(text: string) {
  let result = '';
  let escaped = false;
  for (const ch of text) {
    if (ch === '%' && !escaped) break;
    result += ch;
    if (ch === '\\' && !escaped) {
      escaped = true;
    } else {
      escaped = false;
    }
  }
  return result;
}

function findEnvFold(state: EditorState, startLineNumber: number, lineEnd: number, env: string) {
  let depth = 1;
  for (let lineNo = startLineNumber + 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const clean = stripLatexComment(line.text);
    let match: RegExpExecArray | null;
    ENV_RE.lastIndex = 0;
    while ((match = ENV_RE.exec(clean)) !== null) {
      const kind = match[1];
      const name = match[2];
      if (name !== env) continue;
      if (kind === 'begin') depth += 1;
      if (kind === 'end') depth -= 1;
      if (depth === 0) {
        if (line.from > lineEnd) {
          return { from: lineEnd, to: line.from };
        }
        return null;
      }
    }
  }
  return null;
}

function findSectionFold(state: EditorState, startLineNumber: number, lineEnd: number, level: number) {
  for (let lineNo = startLineNumber + 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const clean = stripLatexComment(line.text);
    const match = clean.match(SECTION_RE);
    if (!match) continue;
    const nextLevel = SECTION_LEVELS[match[1]] ?? 99;
    if (nextLevel <= level) {
      if (line.from > lineEnd) {
        return { from: lineEnd, to: line.from };
      }
      return null;
    }
  }
  if (state.doc.length > lineEnd) {
    return { from: lineEnd, to: state.doc.length };
  }
  return null;
}

function countRegex(text: string, re: RegExp) {
  let count = 0;
  let match: RegExpExecArray | null;
  re.lastIndex = 0;
  while ((match = re.exec(text)) !== null) {
    count += 1;
  }
  return count;
}

function countUnescapedToken(text: string, token: string) {
  let count = 0;
  for (let i = 0; i <= text.length - token.length; i += 1) {
    if (text.slice(i, i + token.length) !== token) continue;
    if (i > 0 && text[i - 1] === '\\') continue;
    count += 1;
    i += token.length - 1;
  }
  return count;
}

function findTokenFold(
  state: EditorState,
  startLineNumber: number,
  lineEnd: number,
  startRe: RegExp,
  endRe: RegExp
) {
  let depth = 1;
  for (let lineNo = startLineNumber + 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const clean = stripLatexComment(line.text);
    depth += countRegex(clean, startRe);
    depth -= countRegex(clean, endRe);
    if (depth <= 0) {
      if (line.from > lineEnd) {
        return { from: lineEnd, to: line.from };
      }
      return null;
    }
  }
  return null;
}

function findDisplayMathFold(
  state: EditorState,
  startLineNumber: number,
  lineEnd: number,
  startToken: string,
  endToken: string
) {
  for (let lineNo = startLineNumber + 1; lineNo <= state.doc.lines; lineNo += 1) {
    const line = state.doc.line(lineNo);
    const clean = stripLatexComment(line.text);
    if (countUnescapedToken(clean, endToken) > 0) {
      if (line.from > lineEnd) {
        return { from: lineEnd, to: line.from };
      }
      return null;
    }
  }
  return null;
}

function latexFoldService(state: EditorState, lineStart: number, lineEnd: number) {
  const line = state.doc.lineAt(lineStart);
  const clean = stripLatexComment(line.text);
  if (!clean.trim()) return null;
  const envMatch = clean.match(/\\begin\{([^}]+)\}/);
  if (envMatch) {
    return findEnvFold(state, line.number, lineEnd, envMatch[1]);
  }
  const sectionMatch = clean.match(SECTION_RE);
  if (sectionMatch) {
    const level = SECTION_LEVELS[sectionMatch[1]] ?? 99;
    return findSectionFold(state, line.number, lineEnd, level);
  }
  if (GROUP_START_TEST.test(clean)) {
    return findTokenFold(state, line.number, lineEnd, GROUP_START_RE, GROUP_END_RE);
  }
  if (IF_START_TEST.test(clean)) {
    return findTokenFold(state, line.number, lineEnd, IF_START_RE, IF_END_RE);
  }
  const hasDisplayDollar = countUnescapedToken(clean, '$$') % 2 === 1;
  if (hasDisplayDollar) {
    return findDisplayMathFold(state, line.number, lineEnd, '$$', '$$');
  }
  const hasDisplayBracket = clean.includes('\\[');
  if (hasDisplayBracket && !clean.includes('\\]')) {
    return findDisplayMathFold(state, line.number, lineEnd, '\\[', '\\]');
  }
  return null;
}

function isFigureFile(path: string) {
  const lower = path.toLowerCase();
  return FIGURE_EXTS.some((ext) => lower.endsWith(ext));
}

function isTextFile(path: string) {
  const lower = path.toLowerCase();
  return lower.endsWith('.tex') || lower.endsWith('.bib') || TEXT_EXTS.some((ext) => lower.endsWith(ext));
}

function getFileTypeLabel(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tex')) return 'TEX';
  if (lower.endsWith('.bib')) return 'BIB';
  if (lower.endsWith('.cls')) return 'CLS';
  if (lower.endsWith('.sty')) return 'STY';
  if (lower.endsWith('.png')) return 'PNG';
  if (lower.endsWith('.jpg') || lower.endsWith('.jpeg')) return 'JPG';
  if (lower.endsWith('.svg')) return 'SVG';
  if (lower.endsWith('.pdf')) return 'PDF';
  if (lower.endsWith('.txt')) return 'TXT';
  return 'FILE';
}

function getParentPath(target: string) {
  if (!target) return '';
  const idx = target.lastIndexOf('/');
  return idx === -1 ? '' : target.slice(0, idx);
}

type TreeNode = {
  name: string;
  path: string;
  type: 'file' | 'dir';
  children: TreeNode[];
};

type OutlineItem = {
  title: string;
  level: number;
  pos: number;
  line: number;
};

function buildTree(items: { path: string; type: string }[], orderMap: Record<string, string[]> = {}) {
  const root: TreeNode = { name: '', path: '', type: 'dir', children: [] };
  const nodeMap = new Map<string, TreeNode>([['', root]]);

  const sorted = [...items].sort((a, b) => a.path.localeCompare(b.path));

  sorted.forEach((item) => {
    const parts = item.path.split('/').filter(Boolean);
    let currentPath = '';
    parts.forEach((part, index) => {
      const nextPath = currentPath ? `${currentPath}/${part}` : part;
      if (!nodeMap.has(nextPath)) {
        const isLeaf = index === parts.length - 1;
        const node: TreeNode = {
          name: part,
          path: nextPath,
          type: isLeaf ? (item.type === 'dir' ? 'dir' : 'file') : 'dir',
          children: []
        };
        const parent = nodeMap.get(currentPath);
        if (parent) {
          parent.children.push(node);
        }
        nodeMap.set(nextPath, node);
      }
      currentPath = nextPath;
    });
  });

  const sortNodes = (node: TreeNode) => {
    const order = orderMap[node.path] || [];
    node.children.sort((a, b) => {
      const aKey = a.name;
      const bKey = b.name;
      const aIndex = order.indexOf(aKey);
      const bIndex = order.indexOf(bKey);
      if (aIndex !== -1 || bIndex !== -1) {
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        if (aIndex !== bIndex) return aIndex - bIndex;
      }
      if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    node.children.forEach(sortNodes);
  };

  sortNodes(root);
  return root;
}

function findTreeNode(root: TreeNode, targetPath: string) {
  if (root.path === targetPath) return root;
  const parts = targetPath.split('/').filter(Boolean);
  let current: TreeNode | null = root;
  let pathSoFar = '';
  for (const part of parts) {
    if (!current) return null;
    pathSoFar = pathSoFar ? `${pathSoFar}/${part}` : part;
    current = current.children.find((child) => child.path === pathSoFar) || null;
  }
  return current;
}

function stripLineComment(line: string) {
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === '%' && !escaped) {
      return line.slice(0, i);
    }
    escaped = ch === '\\';
  }
  return line;
}

function parseOutline(text: string): OutlineItem[] {
  const items: OutlineItem[] = [];
  const lines = text.split(/\r?\n/);
  let offset = 0;
  lines.forEach((line, index) => {
    const clean = stripLineComment(line);
    const regex = /\\+(section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clean))) {
      const name = match[1];
      const title = (match[2] || '').trim() || '(untitled)';
      const level = name === 'section' ? 1 : name === 'subsection' ? 2 : 3;
      items.push({
        title,
        level,
        pos: offset + (match.index ?? 0),
        line: index + 1
      });
    }
    offset += line.length + 1;
  });
  return items;
}

function extractIncludeTargets(text: string) {
  const targets: string[] = [];
  const lines = text.split(/\r?\n/);
  const regex = /\\(?:input|include)\s*\{([^}]+)\}/g;
  lines.forEach((line) => {
    const clean = stripLineComment(line);
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clean))) {
      const raw = (match[1] || '').trim();
      if (raw) targets.push(raw);
    }
  });
  return targets;
}

function findNearestHeading(text: string, cursorPos: number) {
  const before = text.slice(0, cursorPos);
  const lines = before.split(/\r?\n/).reverse();
  for (const line of lines) {
    const clean = stripLineComment(line);
    const match = clean.match(/\\+(section|subsection|subsubsection)\*?\s*(?:\[[^\]]*\])?\s*\{([^}]*)\}/);
    if (match) {
      return {
        title: (match[2] || '').trim() || '(untitled)',
        level: match[1]
      };
    }
  }
  return null;
}

function findCurrentEnvironment(text: string) {
  const stack: string[] = [];
  const clean = text
    .split('\n')
    .map((line) => stripLineComment(line))
    .join('\n');
  const regex = /\\\\(begin|end)\\s*\\{([^}]+)\\}/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(clean))) {
    const type = match[1];
    const name = match[2].trim();
    if (!name) continue;
    if (type === 'begin') {
      stack.push(name);
    } else if (type === 'end') {
      const idx = stack.lastIndexOf(name);
      if (idx !== -1) {
        stack.splice(idx, 1);
      }
    }
  }
  return stack.length > 0 ? stack[stack.length - 1] : '';
}

function extractJsonBlock(text: string) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return '';
  return text.slice(start, end + 1);
}

function sanitizeJsonString(raw: string) {
  let inString = false;
  let escaped = false;
  let out = '';
  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inString) {
      if (escaped) {
        out += ch;
        escaped = false;
        continue;
      }
      if (ch === '\\') {
        out += ch;
        escaped = true;
        continue;
      }
      if (ch === '"') {
        out += ch;
        inString = false;
        continue;
      }
      if (ch === '\n') {
        out += '\\n';
        continue;
      }
      if (ch === '\r') {
        out += '\\r';
        continue;
      }
      if (ch === '\t') {
        out += '\\t';
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code >= 0 && code < 0x20) {
        out += `\\u${code.toString(16).padStart(4, '0')}`;
        continue;
      }
      out += ch;
    } else {
      if (ch === '"') {
        inString = true;
      }
      out += ch;
    }
  }
  return out;
}

function safeJsonParse<T>(raw: string): T | null {
  try {
    return JSON.parse(raw) as T;
  } catch (err) {
    try {
      return JSON.parse(sanitizeJsonString(raw)) as T;
    } catch (err2) {
      return null;
    }
  }
}

function appendLog(setter: (val: string[] | ((prev: string[]) => string[])) => void, line: string) {
  setter((prev) => [...prev, line]);
}

function latexCompletionSource(context: CompletionContext) {
  const before = context.matchBefore(/[\\/][A-Za-z]*$/);
  if (!before) return null;
  const prev = before.from > 0 ? context.state.doc.sliceString(before.from - 1, before.from) : ' ';
  if (prev && !/[\s({\n]/.test(prev)) return null;
  if (before.text.startsWith('/') && prev === ':') return null;
  const options = [
    { label: '\\section{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\section{}' },
        selection: { anchor: from + '\\section{'.length }
      });
    }},
    { label: '\\subsection{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\subsection{}' },
        selection: { anchor: from + '\\subsection{'.length }
      });
    }},
    { label: '\\subsubsection{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\subsubsection{}' },
        selection: { anchor: from + '\\subsubsection{'.length }
      });
    }},
    { label: '\\paragraph{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\paragraph{}' },
        selection: { anchor: from + '\\paragraph{'.length }
      });
    }},
    { label: '\\cite{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\cite{}' },
        selection: { anchor: from + '\\cite{'.length }
      });
    }},
    { label: '\\ref{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\ref{}' },
        selection: { anchor: from + '\\ref{'.length }
      });
    }},
    { label: '\\label{}', type: 'keyword', apply: (view: any, _completion: any, from: number, to: number) => {
      view.dispatch({
        changes: { from, to, insert: '\\label{}' },
        selection: { anchor: from + '\\label{'.length }
      });
    }},
    { label: '\\begin{itemize}', type: 'keyword', apply: '\\begin{itemize}\n\\item \n\\end{itemize}' },
    { label: '\\begin{enumerate}', type: 'keyword', apply: '\\begin{enumerate}\n\\item \n\\end{enumerate}' },
    { label: '\\begin{figure}', type: 'keyword', apply: '\\begin{figure}[t]\n\\centering\n\\includegraphics[width=0.9\\linewidth]{}\n\\caption{}\n\\label{}\n\\end{figure}' },
    { label: '\\begin{table}', type: 'keyword', apply: '\\begin{table}[t]\n\\centering\n\\begin{tabular}{}\n\\end{tabular}\n\\caption{}\n\\label{}\n\\end{table}' }
  ];
  return {
    from: before.from,
    options,
    validFor: /^[\\/][A-Za-z]*$/
  };
}

const setGhostEffect = StateEffect.define<{ pos: number | null; text: string }>();

class GhostWidget extends WidgetType {
  constructor(private text: string) {
    super();
  }

  toDOM() {
    const span = document.createElement('span');
    span.className = 'cm-ghost';
    span.textContent = this.text;
    return span;
  }

  ignoreEvent() {
    return true;
  }
}

const ghostField = StateField.define<DecorationSet>({
  create() {
    return Decoration.none;
  },
  update(deco, tr) {
    let next = deco.map(tr.changes);
    for (const effect of tr.effects) {
      if (effect.is(setGhostEffect)) {
        const { pos, text } = effect.value;
        if (pos == null || !text) {
          return Decoration.none;
        }
        const widget = Decoration.widget({
          widget: new GhostWidget(text),
          side: 1
        });
        return Decoration.set([widget.range(pos)]);
      }
    }
    if (tr.docChanged || tr.selectionSet) {
      return Decoration.none;
    }
    return next;
  },
  provide: (field) => EditorView.decorations.from(field)
});

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      background: 'transparent'
    },
    '.cm-scroller': {
      fontFamily: '"JetBrains Mono", "SF Mono", "Menlo", monospace',
      fontSize: 'var(--editor-font-size, 11px)',
      lineHeight: '1.6'
    },
    '.cm-content': {
      padding: '16px'
    },
    '.cm-gutters': {
      background: 'transparent',
      border: 'none',
      color: 'rgba(122, 111, 103, 0.6)'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 12px'
    },
    '.cm-activeLine': {
      background: 'rgba(180, 74, 47, 0.08)'
    },
    '.cm-activeLineGutter': {
      background: 'transparent'
    },
    '.cm-selectionBackground': {
      background: 'rgba(180, 74, 47, 0.18)'
    }
  },
  { dark: false }
);

function buildSplitDiff(original: string, proposed: string) {
  const parts = diffLines(original, proposed);
  let leftLine = 1;
  let rightLine = 1;
  const rows: {
    left?: string;
    right?: string;
    leftNo?: number;
    rightNo?: number;
    type: 'context' | 'added' | 'removed';
  }[] = [];

  parts.forEach((part) => {
    const lines = part.value.split('\n');
    if (lines[lines.length - 1] === '') {
      lines.pop();
    }
    lines.forEach((line) => {
      if (part.added) {
        rows.push({ right: line, rightNo: rightLine++, type: 'added' });
      } else if (part.removed) {
        rows.push({ left: line, leftNo: leftLine++, type: 'removed' });
      } else {
        rows.push({
          left: line,
          right: line,
          leftNo: leftLine++,
          rightNo: rightLine++,
          type: 'context'
        });
      }
    });
  });

  return rows;
}

type CompileError = {
  message: string;
  line?: number;
  file?: string;
  raw?: string;
};

function parseCompileErrors(log: string): CompileError[] {
  if (!log) return [];
  const lines = log.split('\n');
  const errors: CompileError[] = [];
  const seen = new Set<string>();

  const pushError = (error: CompileError) => {
    const key = `${error.file || ''}:${error.line || ''}:${error.message}`;
    if (seen.has(key)) return;
    seen.add(key);
    errors.push(error);
  };

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const fileLineMatch = line.match(/([A-Za-z0-9_./-]+\.tex):(\d+)/);
    if (fileLineMatch) {
      pushError({
        message: line.trim(),
        file: fileLineMatch[1],
        line: Number(fileLineMatch[2]),
        raw: line
      });
    }
    if (line.startsWith('!')) {
      const message = line.replace(/^!+\s*/, '').trim();
      let lineNo: number | undefined;
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j += 1) {
        const match = lines[j].match(/l\.(\d+)/);
        if (match) {
          lineNo = Number(match[1]);
          break;
        }
      }
      pushError({ message, line: lineNo, raw: line });
    }
  }

  return errors;
}

function findLineOffset(text: string, line: number) {
  if (line <= 1) return 0;
  let offset = 0;
  let current = 1;
  while (current < line && offset < text.length) {
    const next = text.indexOf('\n', offset);
    if (next === -1) break;
    offset = next + 1;
    current += 1;
  }
  return offset;
}

function replaceSelection(source: string, start: number, end: number, replacement: string) {
  return source.slice(0, start) + replacement + source.slice(end);
}

function SplitDiffView({ rows }: { rows: ReturnType<typeof buildSplitDiff> }) {
  const { t } = useTranslation();
  const leftRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  const lockRef = useRef(false);

  const syncScroll = (source: HTMLDivElement | null, target: HTMLDivElement | null) => {
    if (!source || !target || lockRef.current) return;
    lockRef.current = true;
    target.scrollTop = source.scrollTop;
    target.scrollLeft = source.scrollLeft;
    requestAnimationFrame(() => {
      lockRef.current = false;
    });
  };

  return (
    <div className="split-diff">
      <div
        className="split-column"
        ref={leftRef}
        onScroll={() => syncScroll(leftRef.current, rightRef.current)}
      >
        <div className="split-header">{t('Before')}</div>
        {rows.map((row, idx) => (
          <div key={`l-${idx}`} className={`split-row ${row.type}`}>
            <div className="line-no">{row.leftNo ?? ''}</div>
            <div className="line-text">{row.left ?? ''}</div>
          </div>
        ))}
      </div>
      <div
        className="split-column"
        ref={rightRef}
        onScroll={() => syncScroll(rightRef.current, leftRef.current)}
      >
        <div className="split-header">{t('After')}</div>
        {rows.map((row, idx) => (
          <div key={`r-${idx}`} className={`split-row ${row.type}`}>
            <div className="line-no">{row.rightNo ?? ''}</div>
            <div className="line-text">{row.right ?? ''}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PdfPreview({
  pdfUrl,
  scale,
  fitWidth,
  spread,
  onFitScale,
  onTextClick,
  onOutline,
  annotations,
  annotateMode,
  onAddAnnotation,
  containerRef: externalRef
}: {
  pdfUrl: string;
  scale: number;
  fitWidth: boolean;
  spread: boolean;
  onFitScale?: (value: number | null) => void;
  onTextClick: (text: string) => void;
  onOutline?: (items: { title: string; page?: number; level: number }[]) => void;
  annotations: { id: string; page: number; x: number; y: number; text: string }[];
  annotateMode: boolean;
  onAddAnnotation?: (page: number, x: number, y: number) => void;
  containerRef?: RefObject<HTMLDivElement>;
}) {
  const { t } = useTranslation();
  const localRef = useRef<HTMLDivElement | null>(null);
  const containerRef = externalRef || localRef;

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfUrl) return;
    let cancelled = false;
    container.innerHTML = '';

    const render = async () => {
      try {
        const loadingTask = getDocument(pdfUrl);
        const pdf = await loadingTask.promise;

        // 获取容器宽度用于计算缩放比例
        const containerWidth = container.clientWidth - 24; // 减去 padding
        const pageTargetWidth = spread ? Math.max(200, (containerWidth - 16) / 2) : containerWidth;

        let baseScale = scale;
        let firstPage: Awaited<ReturnType<typeof pdf.getPage>> | null = null;
        if (fitWidth && containerWidth > 0) {
          firstPage = await pdf.getPage(1);
          const originalViewport = firstPage.getViewport({ scale: 1.0 });
          baseScale = pageTargetWidth / originalViewport.width;
          if (onFitScale) {
            onFitScale(baseScale);
          }
        } else if (onFitScale) {
          onFitScale(null);
        }

        const renderPage = async (page: Awaited<ReturnType<typeof pdf.getPage>>) => {
          // 先获取原始尺寸
          const cssViewport = page.getViewport({ scale: baseScale });
          const qualityBoost = Math.min(2.4, (window.devicePixelRatio || 1) * 1.25);
          const renderViewport = page.getViewport({ scale: baseScale * qualityBoost });

          const pageWrapper = document.createElement('div');
          pageWrapper.className = 'pdf-page';
          pageWrapper.style.width = `${cssViewport.width}px`;
          pageWrapper.style.height = `${cssViewport.height}px`;
          pageWrapper.dataset.pageNumber = String(page.pageNumber);

          const canvas = document.createElement('canvas');
          const ctx = canvas.getContext('2d');
          canvas.width = renderViewport.width;
          canvas.height = renderViewport.height;
          canvas.style.width = `${cssViewport.width}px`;
          canvas.style.height = `${cssViewport.height}px`;
          pageWrapper.appendChild(canvas);

          const textLayer = document.createElement('div');
          textLayer.className = 'textLayer';
          textLayer.style.width = `${cssViewport.width}px`;
          textLayer.style.height = `${cssViewport.height}px`;
          pageWrapper.appendChild(textLayer);

          if (ctx) {
            await page.render({ canvasContext: ctx, viewport: renderViewport }).promise;
          }
          const textContent = await page.getTextContent();
          renderTextLayer({
            textContentSource: textContent,
            container: textLayer,
            viewport: cssViewport
          });
          return pageWrapper;
        };

        const wrappers: HTMLElement[] = [];
        if (firstPage) {
          if (cancelled) return;
          const firstWrapper = await renderPage(firstPage);
          wrappers.push(firstWrapper);
        }

        for (let pageNum = firstPage ? 2 : 1; pageNum <= pdf.numPages; pageNum += 1) {
          if (cancelled) return;
          const page = await pdf.getPage(pageNum);
          const wrapper = await renderPage(page);
          wrappers.push(wrapper);
        }

        if (spread) {
          for (let idx = 0; idx < wrappers.length; idx += 2) {
            const row = document.createElement('div');
            row.className = 'pdf-spread';
            row.appendChild(wrappers[idx]);
            if (wrappers[idx + 1]) {
              row.appendChild(wrappers[idx + 1]);
            }
            container.appendChild(row);
          }
        } else {
          wrappers.forEach((wrapper) => container.appendChild(wrapper));
        }

        if (onOutline) {
          try {
            const outline = await pdf.getOutline();
            const items: { title: string; page?: number; level: number }[] = [];
            const walk = async (entries: any[], level: number) => {
              if (!entries) return;
              for (const entry of entries) {
                let pageNumber: number | undefined;
                try {
                  const dest = typeof entry.dest === 'string' ? await pdf.getDestination(entry.dest) : entry.dest;
                  if (Array.isArray(dest) && dest.length > 0) {
                    const pageIndex = await pdf.getPageIndex(dest[0]);
                    pageNumber = pageIndex + 1;
                  }
                } catch {
                  pageNumber = undefined;
                }
                items.push({ title: entry.title || t('(untitled)'), page: pageNumber, level });
                if (entry.items?.length) {
                  await walk(entry.items, level + 1);
                }
              }
            };
            await walk(outline || [], 1);
            onOutline(items);
          } catch {
            onOutline([]);
          }
        }
      } catch (err) {
        console.error('PDF render error:', err);
        container.innerHTML = `<div class="muted">${t('PDF 渲染失败')}</div>`;
      }
    };

    render().catch(() => {
      container.innerHTML = `<div class="muted">${t('PDF 渲染失败')}</div>`;
    });

    return () => {
      cancelled = true;
      container.innerHTML = '';
    };
  }, [pdfUrl, fitWidth, onFitScale, scale, spread, onOutline, t]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.querySelectorAll('.pdf-annotation').forEach((node) => node.remove());
    annotations.forEach((note) => {
      const pageEl = container.querySelector(`.pdf-page[data-page-number="${note.page}"]`) as HTMLElement | null;
      if (!pageEl) return;
      const marker = document.createElement('div');
      marker.className = 'pdf-annotation';
      marker.style.left = `${note.x * 100}%`;
      marker.style.top = `${note.y * 100}%`;
      marker.title = note.text;
      marker.dataset.annotationId = note.id;
      pageEl.appendChild(marker);
    });
  }, [annotations, pdfUrl, spread]);

  return (
    <div
      className={`pdf-preview ${annotateMode ? 'annotate' : ''}`}
      ref={containerRef}
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (!target) return;
        if (annotateMode && onAddAnnotation) {
          const pageEl = target.closest('.pdf-page') as HTMLElement | null;
          if (pageEl) {
            const rect = pageEl.getBoundingClientRect();
            const x = (event.clientX - rect.left) / rect.width;
            const y = (event.clientY - rect.top) / rect.height;
            const page = Number(pageEl.dataset.pageNumber || 1);
            onAddAnnotation(page, x, y);
            return;
          }
        }
        if (target.tagName !== 'SPAN') return;
        const text = (target.textContent || '').trim();
        if (text.length < 3) return;
        onTextClick(text);
      }}
    />
  );
}

export default function EditorPage() {
  const navigate = useNavigate();
  const { t, i18n } = useTranslation();
  const { projectId: routeProjectId } = useParams();
  const projectId = routeProjectId || '';
  const [settings, setSettings] = useState<AppSettings>(() => loadSettings());
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [tree, setTree] = useState<{ path: string; type: string }[]>([]);
  const [fileOrder, setFileOrder] = useState<Record<string, string[]>>({});
  const [activePath, setActivePath] = useState<string>('');
  const [files, setFiles] = useState<Record<string, string>>({});
  const [editorValue, setEditorValue] = useState<string>('');
  const [selectionRange, setSelectionRange] = useState<[number, number]>([0, 0]);
  const [isSuggesting, setIsSuggesting] = useState(false);
  const [inlineSuggestionText, setInlineSuggestionText] = useState('');
  const [suggestionPos, setSuggestionPos] = useState<{ left: number; top: number } | null>(null);
  const [assistantMode, setAssistantMode] = useState<'chat' | 'agent'>('agent');
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [agentMessages, setAgentMessages] = useState<Message[]>([]);
  const [prompt, setPrompt] = useState('');
  const [task, setTask] = useState(DEFAULT_TASKS(t)[0].value);
  const [mode, setMode] = useState<'direct' | 'tools'>('direct');
  const [translateScope, setTranslateScope] = useState<'selection' | 'file' | 'project'>('selection');
  const [translateTarget, setTranslateTarget] = useState('English');
  const [taskDropdownOpen, setTaskDropdownOpen] = useState(false);
  const [modeDropdownOpen, setModeDropdownOpen] = useState(false);
  const [translateScopeDropdownOpen, setTranslateScopeDropdownOpen] = useState(false);
  const [translateTargetDropdownOpen, setTranslateTargetDropdownOpen] = useState(false);
  const [rightViewDropdownOpen, setRightViewDropdownOpen] = useState(false);
  const [mainFileDropdownOpen, setMainFileDropdownOpen] = useState(false);
  const [engineDropdownOpen, setEngineDropdownOpen] = useState(false);
  const [langDropdownOpen, setLangDropdownOpen] = useState(false);
  const [topBarDropdownRect, setTopBarDropdownRect] = useState<{ top: number; left: number; width: number } | null>(null);
  const [visionModeDropdownOpen, setVisionModeDropdownOpen] = useState(false);
  const [bibTargetDropdownOpen, setBibTargetDropdownOpen] = useState(false);
  const [citeTargetDropdownOpen, setCiteTargetDropdownOpen] = useState(false);
  const [wsBibDropdownOpen, setWsBibDropdownOpen] = useState(false);
  const [wsTexDropdownOpen, setWsTexDropdownOpen] = useState(false);
  const [plotTypeDropdownOpen, setPlotTypeDropdownOpen] = useState(false);
  const [figureDropdownOpen, setFigureDropdownOpen] = useState(false);
  const [pendingChanges, setPendingChanges] = useState<PendingChange[]>([]);
  const [compileLog, setCompileLog] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  const [pdfScale, setPdfScale] = useState(1);
  const [pdfFitWidth, setPdfFitWidth] = useState(true);
  const [pdfFitScale, setPdfFitScale] = useState<number | null>(null);
  const [pdfSpread, setPdfSpread] = useState(false);
  const [pdfOutline, setPdfOutline] = useState<{ title: string; page?: number; level: number }[]>([]);
  const [pdfAnnotations, setPdfAnnotations] = useState<{ id: string; page: number; x: number; y: number; text: string }[]>([]);
  const [pdfAnnotateMode, setPdfAnnotateMode] = useState(false);
  const [engineName, setEngineName] = useState<string>('');
  const [isCompiling, setIsCompiling] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [isDirty, setIsDirty] = useState(false);
  const [savePulse, setSavePulse] = useState(false);
  const [status, setStatus] = useState<string>('');
  const [rightView, setRightView] = useState<'pdf' | 'figures' | 'diff' | 'log' | 'toc' | 'review'>('pdf');
  const [selectedFigure, setSelectedFigure] = useState<string>('');
  const [diffFocus, setDiffFocus] = useState<PendingChange | null>(null);
  const [activeSidebar, setActiveSidebar] = useState<'files' | 'agent' | 'vision' | 'search' | 'websearch' | 'plot' | 'review' | 'collab'>('files');
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [columnSizes, setColumnSizes] = useState({ sidebar: 260, editor: 640, right: 420 });
  const [editorSplit, setEditorSplit] = useState(0.7);
  const [selectedPath, setSelectedPath] = useState('');
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [dragOverPath, setDragOverPath] = useState('');
  const [dragOverKind, setDragOverKind] = useState<'file' | 'folder' | ''>('');
  const [draggingPath, setDraggingPath] = useState('');
  const [dragHint, setDragHint] = useState<{ text: string; x: number; y: number } | null>(null);
  const [mainFile, setMainFile] = useState('main.tex');
  const [fileFilter, setFileFilter] = useState('');
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [editorFontSize, setEditorFontSize] = useState(11);
  const [visionMode, setVisionMode] = useState<'equation' | 'table' | 'figure' | 'algorithm' | 'ocr'>('equation');
  const [visionFile, setVisionFile] = useState<File | null>(null);
  const [visionPrompt, setVisionPrompt] = useState('');
  const [visionResult, setVisionResult] = useState('');
  const [visionBusy, setVisionBusy] = useState(false);
  const [visionPreviewUrl, setVisionPreviewUrl] = useState('');
  const [arxivQuery, setArxivQuery] = useState('');
  const [arxivMaxResults, setArxivMaxResults] = useState(5);
  const [arxivResults, setArxivResults] = useState<ArxivPaper[]>([]);
  const [arxivSelected, setArxivSelected] = useState<Record<string, boolean>>({});
  const [arxivBusy, setArxivBusy] = useState(false);
  const [arxivStatus, setArxivStatus] = useState('');
  const [useLlmSearch, setUseLlmSearch] = useState(false);
  const [llmSearchOutput, setLlmSearchOutput] = useState('');
  const [arxivBibtexCache, setArxivBibtexCache] = useState<Record<string, string>>({});
  const [bibTarget, setBibTarget] = useState('');
  const [autoInsertCite, setAutoInsertCite] = useState(true);
  const [autoInsertToMain, setAutoInsertToMain] = useState(false);
  const [citeTargetFile, setCiteTargetFile] = useState('');
  const [outlineText, setOutlineText] = useState('');
  const [currentHeading, setCurrentHeading] = useState<{ title: string; level: string } | null>(null);
  const [plotType, setPlotType] = useState<'bar' | 'line' | 'heatmap'>('bar');
  const [plotTitle, setPlotTitle] = useState('');
  const [plotFilename, setPlotFilename] = useState('');
  const [plotPrompt, setPlotPrompt] = useState('');
  const [plotRetries, setPlotRetries] = useState(2);
  const [plotBusy, setPlotBusy] = useState(false);
  const [plotStatus, setPlotStatus] = useState('');
  const [plotAssetPath, setPlotAssetPath] = useState('');
  const [plotAutoInsert, setPlotAutoInsert] = useState(true);
  const [websearchQuery, setWebsearchQuery] = useState('');
  const [websearchLog, setWebsearchLog] = useState<string[]>([]);
  const [websearchBusy, setWebsearchBusy] = useState(false);
  const [websearchResults, setWebsearchResults] = useState<WebsearchItem[]>([]);
  const [websearchSelected, setWebsearchSelected] = useState<Record<string, boolean>>({});
  const [websearchParagraph, setWebsearchParagraph] = useState('');
  const [websearchItemNotes, setWebsearchItemNotes] = useState<Record<string, string>>({});
  const [websearchTargetFile, setWebsearchTargetFile] = useState('');
  const [websearchTargetBib, setWebsearchTargetBib] = useState('');
  const [reviewNotes, setReviewNotes] = useState<{ title: string; content: string }[]>([]);
  const [reviewReport, setReviewReport] = useState('');
  const [reviewReportBusy, setReviewReportBusy] = useState(false);
  const [diagnoseBusy, setDiagnoseBusy] = useState(false);
  const [websearchSelectedAll, setWebsearchSelectedAll] = useState(false);
  const [collabEnabled, setCollabEnabled] = useState(() => Boolean(getCollabToken()));
  const [collabStatus, setCollabStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [collabInviteBusy, setCollabInviteBusy] = useState(false);
  const [collabInviteLink, setCollabInviteLink] = useState('');
  const [collabServer, setCollabServerState] = useState(() => getCollabServer() || (typeof window === 'undefined' ? '' : window.location.origin));
  const [collabName, setCollabName] = useState(() => loadCollabName() || 'Guest');
  const [collabToken] = useState(() => getCollabToken());
  const [collabPeers, setCollabPeers] = useState<{ id: number; name: string; color: string }[]>([]);
  const editorHostRef = useRef<HTMLDivElement | null>(null);
  const editorAreaRef = useRef<HTMLDivElement | null>(null);
  const cmViewRef = useRef<EditorView | null>(null);
  const activePathRef = useRef<string>('');
  const inlineSuggestionRef = useRef<string>('');
  const inlineAnchorRef = useRef<number | null>(null);
  const applyingSuggestionRef = useRef(false);
  const suppressDirtyRef = useRef(false);
  const typewriterTimerRef = useRef<number | null>(null);
  const requestSuggestionRef = useRef<() => void>(() => {});
  const acceptSuggestionRef = useRef<() => void>(() => {});
  const acceptChunkRef = useRef<() => void>(() => {});
  const clearSuggestionRef = useRef<() => void>(() => {});
  const saveActiveFileRef = useRef<() => void>(() => {});
  const gridRef = useRef<HTMLDivElement | null>(null);
  const editorSplitRef = useRef<HTMLDivElement | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement | null>(null);
  const fileTreeRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const collabProviderRef = useRef<CollabProvider | null>(null);
  const collabDocRef = useRef<{ doc: Y.Doc; text: Y.Text; awareness: Awareness } | null>(null);
  const collabActiveRef = useRef(false);
  const collabColorRef = useRef<string>(pickCollabColor(collabName));
  const collabCompartment = useMemo(() => new Compartment(), []);

  const {
    llmEndpoint,
    llmApiKey,
    llmModel,
    searchEndpoint,
    searchApiKey,
    searchModel,
    visionEndpoint,
    visionApiKey,
    visionModel,
    compileEngine
  } = settings;

  useEffect(() => {
    persistSettings(settings);
  }, [settings]);

  useEffect(() => {
    if (collabServer) {
      setCollabServer(collabServer);
    }
  }, [collabServer]);

  useEffect(() => {
    persistCollabName(collabName);
    collabColorRef.current = pickCollabColor(collabName);
    if (collabDocRef.current) {
      collabDocRef.current.awareness.setLocalStateField('user', {
        name: collabName,
        color: collabColorRef.current
      });
    }
  }, [collabName]);

  useEffect(() => {
    collabActiveRef.current = collabEnabled;
    if (collabEnabled) {
      setIsDirty(false);
    }
  }, [collabEnabled]);

  const llmConfig = useMemo(
    () => ({
      endpoint: llmEndpoint,
      apiKey: llmApiKey || undefined,
      model: llmModel
    }),
    [llmEndpoint, llmApiKey, llmModel]
  );

  const searchLlmConfig = useMemo(() => {
    const hasOverride = Boolean(searchEndpoint || searchApiKey || searchModel);
    return {
      endpoint: (hasOverride ? searchEndpoint : llmEndpoint) || llmEndpoint,
      apiKey: (hasOverride ? searchApiKey : llmApiKey) || undefined,
      model: (hasOverride ? searchModel : llmModel) || llmModel
    };
  }, [llmEndpoint, llmApiKey, llmModel, searchEndpoint, searchApiKey, searchModel]);

  const visionLlmConfig = useMemo(() => {
    const hasOverride = Boolean(visionEndpoint || visionApiKey || visionModel);
    return {
      endpoint: (hasOverride ? visionEndpoint : llmEndpoint) || llmEndpoint,
      apiKey: (hasOverride ? visionApiKey : llmApiKey) || undefined,
      model: (hasOverride ? visionModel : llmModel) || llmModel
    };
  }, [llmEndpoint, llmApiKey, llmModel, visionEndpoint, visionApiKey, visionModel]);

  useEffect(() => {
    if (!projectId) {
      navigate('/projects', { replace: true });
      return;
    }
    setProjectName('');
    listProjects()
      .then((res) => {
        const current = res.projects.find((item) => item.id === projectId);
        if (!current) {
          setStatus(t('项目不存在或已被删除。'));
          return;
        }
        setProjectName(current.name);
      })
      .catch((err) => setStatus(t('加载项目信息失败: {{error}}', { error: String(err) })));
  }, [navigate, projectId, t]);

  useEffect(() => {
    activePathRef.current = activePath;
  }, [activePath]);

  useEffect(() => {
    const view = cmViewRef.current;
    if (!view) return;
    if (!collabEnabled || !projectId || !activePath) {
      if (collabProviderRef.current) {
        collabProviderRef.current.disconnect();
        collabProviderRef.current = null;
      }
      collabDocRef.current = null;
      view.dispatch({ effects: collabCompartment.reconfigure([]) });
      setCollabStatus('disconnected');
      setCollabPeers([]);
      return;
    }
    if (!isTextPath(activePath)) {
      if (collabProviderRef.current) {
        collabProviderRef.current.disconnect();
        collabProviderRef.current = null;
      }
      collabDocRef.current = null;
      view.dispatch({ effects: collabCompartment.reconfigure([]) });
      setCollabPeers([]);
      setStatus(t('协作暂不支持该文件类型。'));
      return;
    }
    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    const awareness = new Awareness(ydoc);
    awareness.setLocalStateField('user', {
      name: collabName,
      color: collabColorRef.current
    });
    const provider = new CollabProvider({
      serverUrl: normalizeServerUrl(collabServer) || (typeof window === 'undefined' ? '' : window.location.origin),
      token: collabToken || undefined,
      projectId,
      filePath: activePath,
      doc: ydoc,
      awareness,
      onStatus: setCollabStatus,
      onError: (error) => setStatus(t('协作连接失败: {{error}}', { error }))
    });
    provider.connect();
    collabProviderRef.current = provider;
    collabDocRef.current = { doc: ydoc, text: ytext, awareness };
    view.dispatch({ effects: collabCompartment.reconfigure(yCollab(ytext, awareness)) });

    const updatePeers = () => {
      const peers: { id: number; name: string; color: string }[] = [];
      awareness.getStates().forEach((state, id) => {
        const user = (state as { user?: { name?: string; color?: string } }).user;
        if (!user) return;
        peers.push({
          id,
          name: user.name || `User-${id}`,
          color: user.color || '#b44a2f'
        });
      });
      setCollabPeers(peers);
    };
    awareness.on('update', updatePeers);
    updatePeers();

    return () => {
      awareness.off('update', updatePeers);
      provider.disconnect();
      collabProviderRef.current = null;
      collabDocRef.current = null;
      ydoc.destroy();
      view.dispatch({ effects: collabCompartment.reconfigure([]) });
      setCollabPeers([]);
    };
  }, [activePath, collabCompartment, collabEnabled, collabName, collabServer, collabToken, projectId, t]);

  const handleCreateInvite = useCallback(async () => {
    if (!projectId) return;
    setCollabInviteBusy(true);
    try {
      const res = await createCollabInvite(projectId);
      if (!res.ok || !res.token) {
        throw new Error(t('邀请生成失败'));
      }
      const baseInput = normalizeServerUrl(collabServer) || (typeof window === 'undefined' ? '' : window.location.origin);
      const base = baseInput.replace(/\/$/, '');
      const link = `${base}/collab?token=${encodeURIComponent(res.token)}`;
      setCollabInviteLink(link);
      if (!collabEnabled) {
        setCollabEnabled(true);
      }
      setStatus(t('邀请链接已生成'));
    } catch (err) {
      setStatus(t('生成邀请失败: {{error}}', { error: String(err) }));
    } finally {
      setCollabInviteBusy(false);
    }
  }, [collabServer, projectId, t]);

  const copyInviteLink = useCallback(async () => {
    if (!collabInviteLink) return;
    try {
      await navigator.clipboard.writeText(collabInviteLink);
      setStatus(t('邀请链接已复制'));
    } catch (err) {
      setStatus(t('复制失败: {{error}}', { error: String(err) }));
    }
  }, [collabInviteLink, t]);

  const refreshTree = async (keepActive = true) => {
    if (!projectId) return;
    const res = await getProjectTree(projectId);
    setTree(res.items);
    setFileOrder(res.fileOrder || {});
    if (!keepActive || !activePath || !res.items.find((item) => item.path === activePath)) {
      const main = res.items.find((item) => item.path.endsWith('main.tex'))?.path;
      const next = main || res.items.find((item) => item.type === 'file')?.path || '';
      if (next) {
        await openFile(next);
      }
    }
  };

  useEffect(() => {
    if (!projectId) return;
    setFiles({});
    setActivePath('');
    refreshTree(false).catch((err) => setStatus(t('加载文件树失败: {{error}}', { error: String(err) })));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId, t]);


  useEffect(() => {
    if (!editorHostRef.current || cmViewRef.current) return;

    const updateListener = EditorView.updateListener.of((update) => {
      const skipClear = applyingSuggestionRef.current;
      if (update.docChanged) {
        const value = update.state.doc.toString();
        setEditorValue(value);
        if (!suppressDirtyRef.current && !collabActiveRef.current) {
          setIsDirty(true);
        } else {
          suppressDirtyRef.current = false;
        }
        const path = activePathRef.current;
        if (path) {
          setFiles((prev) => ({ ...prev, [path]: value }));
        }
      }
      if (update.selectionSet) {
        const sel = update.state.selection.main;
        setSelectionRange([sel.from, sel.to]);
        const heading = findNearestHeading(update.state.doc.toString(), sel.head);
        setCurrentHeading(heading);
      }
      if (!skipClear && inlineSuggestionRef.current && (update.docChanged || update.selectionSet)) {
        inlineSuggestionRef.current = '';
        inlineAnchorRef.current = null;
        setInlineSuggestionText('');
        setTimeout(() => {
          const view = cmViewRef.current;
          if (view) {
            view.dispatch({ effects: setGhostEffect.of({ pos: null, text: '' }) });
          }
        }, 0);
      }
      if (skipClear) {
        applyingSuggestionRef.current = false;
      }
    });

    const keymapExtension = keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          saveActiveFileRef.current();
          return true;
        }
      },
      {
        key: 'Alt-/',
        run: () => {
          requestSuggestionRef.current();
          return true;
        }
      },
      {
        key: 'Mod-/',
        run: toggleComment
      },
      {
        key: 'Mod-Space',
        run: () => {
          requestSuggestionRef.current();
          return true;
        }
      },
      {
        key: 'ArrowRight',
        run: (view) => {
          const pos = view.state.selection.main.head;
          if (inlineSuggestionRef.current && inlineAnchorRef.current === pos) {
            acceptChunkRef.current();
            return true;
          }
          return false;
        }
      },
      {
        key: 'Tab',
        run: () => {
          if (!inlineSuggestionRef.current) return false;
          acceptSuggestionRef.current();
          return true;
        }
      },
      {
        key: 'Escape',
        run: () => {
          clearSuggestionRef.current();
          return true;
        }
      },
      ...foldKeymap,
      ...searchKeymap
    ]);

    const state = EditorState.create({
      doc: '',
      extensions: [
        basicSetup,
        latex(),
        indentOnInput(),
        foldService.of(latexFoldService),
        EditorView.lineWrapping,
        editorTheme,
        collabCompartment.of([]),
        ghostField,
        search(),
        autocompletion({ override: [latexCompletionSource] }),
        updateListener,
        keymapExtension
      ]
    });

    const view = new EditorView({
      state,
      parent: editorHostRef.current
    });
    cmViewRef.current = view;

    const handleAltSlash = (event: KeyboardEvent) => {
      if (!event.altKey) return;
      if (event.key === '/' || event.key === '÷' || event.code === 'Slash') {
        event.preventDefault();
        event.stopPropagation();
        requestSuggestionRef.current();
      }
    };
    view.dom.addEventListener('keydown', handleAltSlash, true);

    return () => {
      view.dom.removeEventListener('keydown', handleAltSlash, true);
      view.destroy();
      cmViewRef.current = null;
    };
  }, []);

  const openFile = async (filePath: string) => {
    setActivePath(filePath);
    activePathRef.current = filePath;
    setSelectedPath(filePath);
    if (filePath.includes('/')) {
      const parts = filePath.split('/').slice(0, -1);
      setOpenFolders((prev) => {
        const next = { ...prev };
        let current = '';
        parts.forEach((part) => {
          current = current ? `${current}/${part}` : part;
          next[current] = true;
        });
        return next;
      });
    }
    if (Object.prototype.hasOwnProperty.call(files, filePath)) {
      const cached = files[filePath] ?? '';
      setEditorValue(cached);
      setIsDirty(false);
      setEditorDoc(cached);
      return cached;
    }
    const data = await getFile(projectId, filePath);
    setFiles((prev) => ({ ...prev, [filePath]: data.content }));
    setEditorValue(data.content);
    setIsDirty(false);
    setEditorDoc(data.content);
    return data.content;
  };

  const setEditorDoc = useCallback((value: string) => {
    const view = cmViewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current === value) return;
    suppressDirtyRef.current = true;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: value }
    });
  }, []);

  const clearInlineSuggestion = useCallback(() => {
    inlineSuggestionRef.current = '';
    inlineAnchorRef.current = null;
    setInlineSuggestionText('');
    setSuggestionPos(null);
    const view = cmViewRef.current;
    if (view) {
      view.dispatch({ effects: setGhostEffect.of({ pos: null, text: '' }) });
    }
  }, []);

  const nextSuggestionChunk = (text: string) => {
    const match = text.match(/^(\s*\S+\s*)/);
    return match ? match[1] : text;
  };

  const acceptInlineSuggestion = useCallback(() => {
    const view = cmViewRef.current;
    const text = inlineSuggestionRef.current;
    const pos = inlineAnchorRef.current;
    if (!view || !text || pos == null) return;
    applyingSuggestionRef.current = true;
    view.dispatch({
      changes: { from: pos, to: pos, insert: text },
      selection: { anchor: pos + text.length }
    });
    clearInlineSuggestion();
  }, [clearInlineSuggestion]);

  const acceptSuggestionChunk = useCallback(() => {
    const view = cmViewRef.current;
    const remaining = inlineSuggestionRef.current;
    const pos = inlineAnchorRef.current;
    if (!view || !remaining || pos == null) return;
    const chunk = nextSuggestionChunk(remaining);
    applyingSuggestionRef.current = true;
    view.dispatch({
      changes: { from: pos, to: pos, insert: chunk },
      selection: { anchor: pos + chunk.length }
    });
    const leftover = remaining.slice(chunk.length);
    if (!leftover) {
      clearInlineSuggestion();
      return;
    }
    inlineSuggestionRef.current = leftover;
    inlineAnchorRef.current = pos + chunk.length;
    setInlineSuggestionText(leftover);
    view.dispatch({ effects: setGhostEffect.of({ pos: pos + chunk.length, text: leftover }) });
  }, [clearInlineSuggestion]);

  const updateSuggestionPosition = useCallback((force = false) => {
    const view = cmViewRef.current;
    const anchor = inlineAnchorRef.current;
    const host = editorAreaRef.current;
    if (!view || !host || (!inlineSuggestionRef.current && !force) || anchor == null) {
      setSuggestionPos(null);
      return;
    }
    const coords = view.coordsAtPos(anchor);
    if (!coords) {
      setSuggestionPos(null);
      return;
    }
    const rect = host.getBoundingClientRect();
    const preferredLeft = coords.left - rect.left;
    const preferredTop = coords.bottom - rect.top + 6;
    const popoverWidth = 320;
    const clampedLeft = Math.min(Math.max(12, preferredLeft), Math.max(12, rect.width - popoverWidth));
    let top = preferredTop;
    if (preferredTop + 80 > rect.height) {
      top = Math.max(12, coords.top - rect.top - 62);
    }
    setSuggestionPos({ left: clampedLeft, top });
  }, []);

  const requestInlineSuggestion = useCallback(async () => {
    const view = cmViewRef.current;
    if (!view || isSuggesting) return;
    clearInlineSuggestion();
    const pos = view.state.selection.main.head;
    const docText = view.state.doc.toString();
    const before = docText.slice(Math.max(0, pos - 4000), pos);
    const after = docText.slice(pos, pos + 400);
    const heading = findNearestHeading(docText, pos);
    const env = findCurrentEnvironment(docText.slice(0, pos));
    inlineAnchorRef.current = pos;
    setIsSuggesting(true);
    updateSuggestionPosition(true);
    try {
      const res = await runAgent({
        task: 'autocomplete',
        prompt: [
          t('You are a LaTeX writing assistant.'),
          t('Continue after <CURSOR> with a coherent next block (1-2 paragraphs or a full environment).'),
          heading ? t('Current section: {{title}} ({{level}}).', { title: heading.title, level: heading.level }) : '',
          env ? t('You are inside environment: {{env}}.', { env }) : '',
          t('Preserve style and formatting.'),
          t('Return only the continuation text, no commentary.')
        ].filter(Boolean).join(' '),
        selection: '',
        content: `${before}<CURSOR>${after}`,
        mode: 'direct',
        projectId,
        activePath,
        compileLog,
        llmConfig
      });
      const suggestion = (res.suggestion || res.reply || '').trim();
      if (!suggestion) return;
      inlineSuggestionRef.current = suggestion;
      inlineAnchorRef.current = pos;
      setInlineSuggestionText(suggestion);
      view.dispatch({
        effects: setGhostEffect.of({ pos, text: suggestion })
      });
    } catch (err) {
      setStatus(t('补全失败: {{error}}', { error: String(err) }));
    } finally {
      setIsSuggesting(false);
      if (!inlineSuggestionRef.current) {
        setSuggestionPos(null);
      }
    }
  }, [activePath, clearInlineSuggestion, compileLog, isSuggesting, llmConfig, projectId, updateSuggestionPosition, t]);

  useEffect(() => {
    if (!inlineSuggestionText) {
      setSuggestionPos(null);
      return;
    }
    updateSuggestionPosition();
  }, [inlineSuggestionText, updateSuggestionPosition]);

  useEffect(() => {
    const view = cmViewRef.current;
    if (!view) return;
    const handleScroll = () => {
      if (inlineSuggestionRef.current) {
        updateSuggestionPosition();
      }
    };
    view.scrollDOM.addEventListener('scroll', handleScroll);
    window.addEventListener('resize', handleScroll);
    return () => {
      view.scrollDOM.removeEventListener('scroll', handleScroll);
      window.removeEventListener('resize', handleScroll);
    };
  }, [updateSuggestionPosition]);

  useEffect(() => {
    if (!inlineSuggestionRef.current) return;
    updateSuggestionPosition();
  }, [columnSizes, editorSplit, updateSuggestionPosition]);

  useEffect(() => {
    requestSuggestionRef.current = requestInlineSuggestion;
    acceptSuggestionRef.current = acceptInlineSuggestion;
    acceptChunkRef.current = acceptSuggestionChunk;
    clearSuggestionRef.current = clearInlineSuggestion;
  }, [requestInlineSuggestion, acceptInlineSuggestion, acceptSuggestionChunk, clearInlineSuggestion]);

  const saveActiveFile = useCallback(
    async (opts?: { silent?: boolean }) => {
      if (!activePath) return;
      if (collabActiveRef.current) {
        setIsSaving(true);
        try {
          await flushCollabFile(projectId, activePath);
          setSavePulse(true);
          window.setTimeout(() => setSavePulse(false), 1200);
          if (!opts?.silent) {
            setStatus(t('协作已同步 {{path}}', { path: activePath }));
          }
        } catch (err) {
          setStatus(t('协作同步失败: {{error}}', { error: String(err) }));
        } finally {
          setIsSaving(false);
        }
        return;
      }
      setIsSaving(true);
      try {
        await writeFile(projectId, activePath, editorValue);
        setIsDirty(false);
        setSavePulse(true);
        window.setTimeout(() => setSavePulse(false), 1200);
        if (!opts?.silent) {
          setStatus(t('已保存 {{path}}', { path: activePath }));
        }
      } catch (err) {
        setStatus(t('保存失败: {{error}}', { error: String(err) }));
      } finally {
        setIsSaving(false);
      }
    },
    [activePath, editorValue, projectId, t]
  );

  const writeFileCompat = useCallback(
    async (path: string, content: string) => {
      if (collabActiveRef.current && collabDocRef.current && path === activePath) {
        const { text } = collabDocRef.current;
        text.delete(0, text.length);
        text.insert(0, content);
        setIsDirty(false);
        return { ok: true };
      }
      return writeFile(projectId, path, content);
    },
    [activePath, projectId]
  );

  useEffect(() => {
    saveActiveFileRef.current = () => saveActiveFile();
  }, [saveActiveFile]);

  useEffect(() => {
    if (!cmViewRef.current) return;
    setEditorDoc(editorValue);
  }, [editorValue, setEditorDoc]);

  useEffect(() => {
    if (collabActiveRef.current) return;
    if (!isDirty || !activePath) return;
    if (saveTimerRef.current) {
      window.clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = window.setTimeout(() => {
      saveActiveFile({ silent: true });
    }, 1500);
    return () => {
      if (saveTimerRef.current) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
    };
  }, [activePath, editorValue, isDirty, saveActiveFile, collabEnabled]);

  const createBibFile = async () => {
    if (!projectId) return;
    const parent = selectedPath && tree.find((item) => item.path === selectedPath && item.type === 'dir')
      ? selectedPath
      : getParentPath(selectedPath || activePath || '');
    const path = parent ? `${parent}/references.bib` : 'references.bib';
    const content = '% Add BibTeX entries here\n';
    await writeFileCompat(path, content);
    await refreshTree();
    await openFile(path);
    return path;
  };

  const insertAtCursor = (text: string, opts?: { block?: boolean }) => {
    if (!activePath) return;
    const view = cmViewRef.current;
    if (!view) return;
    const sel = view.state.selection.main;
    let insert = text;
    if (opts?.block) {
      const before = sel.from > 0 ? view.state.doc.sliceString(sel.from - 1, sel.from) : '';
      if (before && before !== '\n') {
        insert = `\n${insert}`;
      }
      if (!insert.endsWith('\n\n')) {
        insert = insert.endsWith('\n') ? `${insert}\n` : `${insert}\n\n`;
      }
    }
    view.dispatch({
      changes: { from: sel.from, to: sel.to, insert },
      selection: { anchor: sel.from + insert.length }
    });
  };

  const insertFigureSnippet = (filePath: string) => {
    const snippet = [
      '\\begin{figure}[t]',
      '\\centering',
      `\\includegraphics[width=0.9\\linewidth]{${filePath}}`,
      '\\caption{Caption.}',
      `\\label{fig:${filePath.replace(/[^a-zA-Z0-9]+/g, '-')}}`,
      '\\end{figure}',
      ''
    ].join('\n');
    insertAtCursor(snippet, { block: true });
  };

  const insertSectionSnippet = () => insertAtCursor('\\section{Section Title}', { block: true });

  const insertSubsectionSnippet = () => insertAtCursor('\\subsection{Subsection Title}', { block: true });

  const insertSubsubsectionSnippet = () => insertAtCursor('\\subsubsection{Subsubsection Title}', { block: true });

  const insertItemizeSnippet = () => insertAtCursor(['\\begin{itemize}', '\\item ', '\\end{itemize}'].join('\n'), { block: true });

  const insertEnumerateSnippet = () => insertAtCursor(['\\begin{enumerate}', '\\item ', '\\end{enumerate}'].join('\n'), { block: true });

  const insertEquationSnippet = () => insertAtCursor(['\\begin{equation}', 'E = mc^2', '\\end{equation}'].join('\n'), { block: true });

  const insertTableSnippet = () =>
    insertAtCursor(['\\begin{table}[t]', '\\centering', '\\begin{tabular}{lcc}', '\\toprule', 'Method & A & B \\\\', '\\midrule', 'Ours & 0.0 & 0.0 \\\\', '\\bottomrule', '\\end{tabular}', '\\caption{Table caption.}', '\\label{tab:main}', '\\end{table}'].join('\n'), { block: true });

  const insertListingSnippet = () =>
    insertAtCursor(['\\begin{lstlisting}[language=Python]', '# code here', '\\end{lstlisting}'].join('\n'), { block: true });

  const insertAlgorithmSnippet = () =>
    insertAtCursor(['\\begin{algorithm}[t]', '\\caption{Algorithm}', '\\label{alg:main}', '\\begin{algorithmic}', '\\State Initialize', '\\end{algorithmic}', '\\end{algorithm}'].join('\n'), { block: true });

  const insertCiteSnippet = () => insertAtCursor('\\cite{citation-key}');

  const insertRefSnippet = () => insertAtCursor('\\ref{label}');

  const insertLabelSnippet = () => insertAtCursor('\\label{label}');

  const insertFigureTemplate = () =>
    insertAtCursor(['\\begin{figure}[t]', '\\centering', '\\includegraphics[width=0.9\\linewidth]{figures/placeholder.png}', '\\caption{Caption.}', '\\label{fig:placeholder}', '\\end{figure}'].join('\n'), { block: true });

  const ensureFileContent = useCallback(
    async (path: string) => {
      if (Object.prototype.hasOwnProperty.call(files, path)) {
        return files[path] ?? '';
      }
      const data = await getFile(projectId, path);
      setFiles((prev) => ({ ...prev, [path]: data.content }));
      return data.content;
    },
    [files, projectId]
  );

  const buildProjectContext = useCallback(async () => {
    const root = mainFile || activePath;
    if (!root) return '';
    const visited = new Set<string>();
    const queue: string[] = [root];
    const summaries: string[] = [];
    while (queue.length > 0) {
      const current = queue.shift();
      if (!current || visited.has(current)) continue;
      visited.add(current);
      if (!current.toLowerCase().endsWith('.tex')) continue;
      let content = '';
      try {
        content = await ensureFileContent(current);
      } catch {
        continue;
      }
      const outline = parseOutline(content).slice(0, 12);
      const headings = outline.map((item) => `${'  '.repeat(item.level - 1)}- ${item.title}`);
      summaries.push(t('File: {{file}}\n{{headings}}', { file: current, headings: headings.join('\n') }));
      const baseDir = getParentPath(current);
      const includes = extractIncludeTargets(content);
      includes.forEach((raw) => {
        let target = raw.replace(/^\//, '');
        if (!target.endsWith('.tex')) {
          target = `${target}.tex`;
        }
        const resolved = baseDir ? `${baseDir}/${target}` : target;
        if (!visited.has(resolved)) {
          queue.push(resolved);
        }
      });
    }
    const filesList = Array.from(visited).join(', ');
    return t('Project files: {{files}}\nOutline:\n{{summaries}}', { files: filesList, summaries: summaries.join('\n') });
  }, [activePath, ensureFileContent, mainFile, t]);

  const extractBibKey = (bibtex: string) => {
    const match = bibtex.match(/@\w+\s*{\s*([^,\s]+)\s*,/);
    return match ? match[1].trim() : '';
  };

  const handleArxivSearch = useCallback(async () => {
    const query = arxivQuery.trim();
    if (!query) {
      setArxivStatus(t('请输入检索关键词。'));
      return;
    }
    setArxivBusy(true);
    setArxivStatus('');
    try {
      if (useLlmSearch) {
        setLlmSearchOutput('');
        const res = await runAgent({
          task: 'websearch',
          prompt: [
            t('Search arXiv for the user query.'),
            t('Return at most {{max}} papers.', { max: arxivMaxResults }),
            t('Use arxiv_search and arxiv_bibtex tools.'),
            t('Return JSON ONLY in this schema:'),
            t('{"papers":[{"title":"","authors":[],"arxivId":"","bibtex":""}]}.')
          ].join(' '),
          selection: '',
          content: query,
          mode: 'tools',
          projectId,
          activePath,
          compileLog,
          llmConfig: searchLlmConfig,
          interaction: 'agent',
          history: []
        });
        const raw = res.reply || '';
        if (raw) {
          setLlmSearchOutput(raw);
        }
        const jsonBlock = extractJsonBlock(raw);
        if (!jsonBlock) {
          throw new Error(t('LLM 输出无法解析为 JSON。'));
        }
        const parsed = safeJsonParse<{ papers?: { title: string; authors?: string[]; arxivId: string; bibtex?: string }[] }>(jsonBlock);
        if (!parsed) {
          throw new Error(t('LLM 输出 JSON 解析失败。'));
        }
        const papers = parsed.papers || [];
        setArxivResults(
          papers.map((paper) => ({
            title: paper.title || t('(untitled)'),
            abstract: '',
            authors: paper.authors || [],
            url: paper.arxivId ? `https://arxiv.org/abs/${paper.arxivId}` : '',
            arxivId: paper.arxivId
          }))
        );
        const cache: Record<string, string> = {};
        papers.forEach((paper) => {
          if (paper.arxivId && paper.bibtex) {
            cache[paper.arxivId] = paper.bibtex;
          }
        });
        setArxivBibtexCache(cache);
        setArxivSelected({});
        if (papers.length === 0) {
          setArxivStatus(t('没有匹配结果。'));
        }
      } else {
        const res = await arxivSearch({ query, maxResults: arxivMaxResults });
        if (!res.ok) {
          throw new Error(res.error || t('检索失败'));
        }
        setArxivResults(res.papers || []);
        setArxivSelected({});
        if ((res.papers || []).length === 0) {
          setArxivStatus(t('没有匹配结果。'));
        }
      }
    } catch (err) {
      setArxivStatus(t('检索失败: {{error}}', { error: String(err) }));
    } finally {
      setArxivBusy(false);
    }
  }, [arxivQuery, arxivMaxResults, useLlmSearch, projectId, activePath, compileLog, searchLlmConfig, t]);

  const handleArxivApply = useCallback(async () => {
    if (!projectId) return;
    const selected = arxivResults.filter((paper) => arxivSelected[paper.arxivId]);
    if (selected.length === 0) {
      setArxivStatus(t('请选择要导入的论文。'));
      return;
    }
    let targetBib = bibTarget;
    if (!targetBib) {
      const created = await createBibFile();
      if (created) {
        targetBib = created;
        setBibTarget(created);
      }
    }
    if (!targetBib) {
      setArxivStatus(t('请先创建 Bib 文件。'));
      return;
    }
    setArxivBusy(true);
    setArxivStatus(t('正在写入 Bib...'));
    try {
      let content = await ensureFileContent(targetBib);
      const keys: string[] = [];
      for (const paper of selected) {
        let bibtexSource = arxivBibtexCache[paper.arxivId] || '';
        if (!bibtexSource) {
          const res = await arxivBibtex({ arxivId: paper.arxivId });
          if (!res.ok || !res.bibtex) {
            throw new Error(res.error || t('生成 BibTeX 失败: {{id}}', { id: paper.arxivId }));
          }
          bibtexSource = res.bibtex;
        }
        const normalizedBibtex = bibtexSource.replace(/\\n/g, '\n');
        const key = extractBibKey(normalizedBibtex);
        if (key) {
          const exists = new RegExp(`@\\w+\\s*{\\s*${key}\\s*,`, 'i').test(content);
          if (exists) {
            keys.push(key);
            continue;
          }
          keys.push(key);
        }
        if (content && !content.endsWith('\n')) content += '\n';
        content += `${normalizedBibtex.trim()}\n`;
      }
      await writeFileCompat(targetBib, content);
      setFiles((prev) => ({ ...prev, [targetBib]: content }));
      if (activePath === targetBib) {
        setEditorValue(content);
        setEditorDoc(content);
      }
      if (autoInsertCite && keys.length > 0) {
        if (activePath && activePath.toLowerCase().endsWith('.tex')) {
          insertAtCursor(`\\cite{${keys.join(',')}}`);
        } else {
          setArxivStatus(t('Bib 已写入。打开 TeX 文件后可插入引用。'));
          setArxivBusy(false);
          return;
        }
      }
      if (autoInsertToMain && keys.length > 0) {
        const targetFile = citeTargetFile || mainFile;
        if (!targetFile) {
          setArxivStatus(t('未选择引用插入文件。'));
          setArxivBusy(false);
          return;
        }
        const citePayload = arxivResults
          .filter((paper) => keys.includes(extractBibKey(arxivBibtexCache[paper.arxivId] || '') || ''))
          .map((paper) => ({
            title: paper.title,
            arxivId: paper.arxivId
          }));
        const prompt = [
          t('Insert citations into the target TeX file.'),
          t('Target file: {{file}}.', { file: targetFile }),
          t('Use \\\\cite{{{keys}}}.', { keys: keys.join(',') }),
          t('If a Related Work section exists, add the citations there.'),
          t('Otherwise add a Related Work subsection near the end and cite the papers.'),
          t('Keep edits minimal and preserve formatting.'),
          citePayload.length > 0 ? t('Papers: {{payload}}', { payload: JSON.stringify(citePayload) }) : ''
        ].filter(Boolean).join(' ');
        try {
          const targetContent = await ensureFileContent(targetFile);
          const res = await runAgent({
            task: 'insert_citations',
            prompt,
            selection: '',
            content: targetContent || '',
            mode: 'tools',
            projectId,
            activePath: targetFile,
            compileLog,
            llmConfig: searchLlmConfig,
            interaction: 'agent',
            history: []
          });
          if (res.patches && res.patches.length > 0) {
            const nextPending = res.patches.map((patch) => ({
              filePath: patch.path,
              original: files[patch.path] ?? '',
              proposed: patch.content,
              diff: patch.diff
            }));
            setPendingChanges(nextPending);
            setRightView('diff');
            setArxivStatus(t('已生成引用插入建议，请在 Diff 面板应用。'));
          } else {
            setArxivStatus(t('未生成可应用的引用修改。'));
          }
        } catch (err) {
          setArxivStatus(t('引用插入失败: {{error}}', { error: String(err) }));
        }
      } else {
        setArxivStatus(t('已写入 Bib。'));
      }
    } catch (err) {
      setArxivStatus(t('写入失败: {{error}}', { error: String(err) }));
    } finally {
      setArxivBusy(false);
    }
  }, [activePath, arxivResults, arxivSelected, autoInsertCite, autoInsertToMain, bibTarget, projectId, createBibFile, ensureFileContent, setEditorDoc, arxivBibtexCache, compileLog, searchLlmConfig, mainFile, files, citeTargetFile, t]);

  const handlePlotGenerate = async () => {
    if (!projectId) return;
    if (!selectionText || (!selectionText.includes('\\begin{tabular') && !selectionText.includes('\\begin{table'))) {
      setPlotStatus(t('请在编辑器中选择一个 LaTeX 表格 (tabular)。'));
      return;
    }
    setPlotBusy(true);
    setPlotStatus('');
    try {
      const res = await plotFromTable({
        projectId,
        tableLatex: selectionText,
        chartType: plotType,
        title: plotTitle.trim() || undefined,
        prompt: plotPrompt.trim() || undefined,
        filename: plotFilename.trim() || undefined,
        retries: plotRetries,
        llmConfig
      });
      if (!res.ok || !res.assetPath) {
        throw new Error(res.error || t('图表生成失败'));
      }
      setPlotAssetPath(res.assetPath);
      setPlotStatus(t('图表已生成'));
      await refreshTree();
      if (plotAutoInsert) {
        insertFigureSnippet(res.assetPath);
      }
    } catch (err) {
      setPlotStatus(t('生成失败: {{error}}', { error: String(err) }));
    } finally {
      setPlotBusy(false);
    }
  };

  const runWebsearch = async () => {
    const query = websearchQuery.trim();
    if (!query) {
      setWebsearchLog([t('请输入查询关键词。')]);
      return;
    }
    setWebsearchBusy(true);
    setWebsearchLog([]);
    setWebsearchResults([]);
    setWebsearchSelected({});
    setWebsearchSelectedAll(false);
    setWebsearchParagraph('');
    setWebsearchItemNotes({});
    try {
      appendLog(setWebsearchLog, t('拆分查询...'));
      const splitRes = await callLLM({
        llmConfig: searchLlmConfig,
        messages: [
          { role: 'system', content: t('Split the query into 2-4 targeted search queries. Return JSON only: {"queries":["..."]}.') },
          { role: 'user', content: t('用户问题: {{query}}', { query }) }
        ]
      });
      if (!splitRes.ok || !splitRes.content) {
        throw new Error(splitRes.error || t('Query split failed'));
      }
      const jsonBlock = extractJsonBlock(splitRes.content);
      if (!jsonBlock) {
        throw new Error(t('无法解析拆分结果 JSON。'));
      }
      const parsed = safeJsonParse<{ queries?: string[] }>(jsonBlock);
      if (!parsed) {
        throw new Error(t('拆分结果 JSON 解析失败。'));
      }
      const queries = (parsed.queries || []).filter(Boolean).slice(0, 4);
      if (queries.length === 0) {
        throw new Error(t('拆分结果为空。'));
      }
      appendLog(setWebsearchLog, t('并行检索: {{queries}}', { queries: queries.join(' | ') }));
      const aggregated: WebsearchItem[] = [];
      await Promise.all(
        queries.map(async (q, idx) => {
          appendLog(setWebsearchLog, t('检索中: {{query}}', { query: q }));
          const res = await callLLM({
            llmConfig: searchLlmConfig,
            messages: [
              {
                role: 'system',
                content:
                  t('You are a search assistant. Use the provider search. Return JSON only: {"results":[{"title":"","summary":"","url":"","bibtex":""}]}.')
              },
              { role: 'user', content: t('帮我检索: {{query}}', { query: q }) }
            ]
          });
          if (!res.ok || !res.content) {
            appendLog(setWebsearchLog, t('检索失败: {{query}}', { query: q }));
            return;
          }
          const block = extractJsonBlock(res.content);
          if (!block) {
            appendLog(setWebsearchLog, t('结果解析失败: {{query}}', { query: q }));
            return;
          }
          const parsedRes = safeJsonParse<{ results?: { title?: string; summary?: string; url?: string; bibtex?: string }[] }>(block);
          if (!parsedRes) {
            appendLog(setWebsearchLog, t('结果 JSON 解析失败: {{query}}', { query: q }));
            return;
          }
          const results = parsedRes.results || [];
          results.forEach((item, i) => {
            const bibtex = item.bibtex || '';
            const citeKey = bibtex ? extractBibKey(bibtex.replace(/\\n/g, '\n')) : '';
            aggregated.push({
              id: `${idx}-${i}-${item.url || item.title || 'result'}`,
              title: item.title || t('Untitled'),
              summary: item.summary || '',
              url: item.url || '',
              bibtex,
              citeKey
            });
          });
          appendLog(setWebsearchLog, t('完成: {{query}} ({{count}})', { query: q, count: results.length }));
        })
      );
      const deduped: WebsearchItem[] = [];
      aggregated.forEach((item) => {
        if (!deduped.find((d) => d.url && item.url && d.url === item.url) && !deduped.find((d) => d.title === item.title)) {
          deduped.push(item);
        }
      });
      setWebsearchResults(deduped);
      appendLog(setWebsearchLog, t('聚合结果: {{count}} 条', { count: deduped.length }));
      if (deduped.length === 0) {
        setWebsearchBusy(false);
        return;
      }
      appendLog(setWebsearchLog, t('生成逐条总结...'));
      const summariesRes = await callLLM({
        llmConfig: searchLlmConfig,
        messages: [
          {
            role: 'system',
            content:
              t('你是论文检索助手。请为每篇论文写一条简短总结（1-2 句）。返回 JSON：{"summaries":[{"id":"","summary":""}]}.')
          },
          {
            role: 'user',
            content: JSON.stringify({
              papers: deduped.map((p) => ({
                id: p.id,
                title: p.title,
                summary: p.summary,
                url: p.url,
                citeKey: p.citeKey
              }))
            })
          }
        ]
      });
      if (summariesRes.ok && summariesRes.content) {
        const summaryBlock = extractJsonBlock(summariesRes.content);
        const parsedSummaries = summaryBlock
          ? safeJsonParse<{ summaries?: { id: string; summary: string }[] }>(summaryBlock)
          : null;
        if (parsedSummaries?.summaries?.length) {
          const notes: Record<string, string> = {};
          parsedSummaries.summaries.forEach((item) => {
            if (item.id && item.summary) {
              notes[item.id] = item.summary.trim();
            }
          });
          setWebsearchItemNotes(notes);
          appendLog(setWebsearchLog, t('逐条总结已生成。'));
        } else {
          appendLog(setWebsearchLog, t('逐条总结解析失败。'));
        }
      } else {
        appendLog(setWebsearchLog, t('逐条总结生成失败。'));
      }

      appendLog(setWebsearchLog, t('生成综合总结...'));
      const citeKeys = deduped.map((item) => item.citeKey).filter(Boolean);
      const paragraphRes = await callLLM({
        llmConfig: searchLlmConfig,
        messages: [
          {
            role: 'system',
            content:
              t('请根据提供论文生成 3-5 句中文综合总结（不要分条）。可以使用 \\cite{...} 引用。只返回总结文本。')
          },
          {
            role: 'user',
            content: JSON.stringify({ query, papers: deduped.map((p) => ({ title: p.title, summary: p.summary, url: p.url })), citeKeys })
          }
        ]
      });
      if (paragraphRes.ok && paragraphRes.content) {
        setWebsearchParagraph(paragraphRes.content.trim());
        appendLog(setWebsearchLog, t('段落已生成。'));
      } else {
        appendLog(setWebsearchLog, t('段落生成失败。'));
      }
    } catch (err) {
      appendLog(setWebsearchLog, t('错误: {{error}}', { error: String(err) }));
    } finally {
      setWebsearchBusy(false);
    }
  };

  const applyWebsearchInsert = async () => {
    if (!projectId) return;
    let targetBib = websearchTargetBib;
    if (!targetBib) {
      const created = await createBibFile();
      if (created) targetBib = created;
    }
    if (!targetBib) {
      setWebsearchLog((prev) => [...prev, t('缺少 Bib 文件。')]);
      return;
    }
    let content = await ensureFileContent(targetBib);
    const keys: string[] = [];
    const selectedItems = websearchResults.filter((item) => websearchSelected[item.id]);
    if (selectedItems.length === 0) {
      appendLog(setWebsearchLog, t('请选择至少一条结果。'));
      return;
    }
    const perItemLines = selectedItems.map((item) => {
      const note = websearchItemNotes[item.id] || item.summary || item.title;
      const cite = item.citeKey ? ` \\cite{${item.citeKey}}` : '';
      return `  \\item ${note}${cite}`;
    });
    selectedItems.forEach((item) => {
      if (!item.bibtex) return;
      const normalized = item.bibtex.replace(/\\n/g, '\n');
      const key = extractBibKey(normalized);
      if (!key) return;
      if (new RegExp(`@\\w+\\s*{\\s*${key}\\s*,`, 'i').test(content)) {
        keys.push(key);
        return;
      }
      keys.push(key);
      if (content && !content.endsWith('\n')) content += '\n';
      content += `${normalized.trim()}\n`;
    });
    await writeFileCompat(targetBib, content);
    setFiles((prev) => ({ ...prev, [targetBib]: content }));
    appendLog(setWebsearchLog, t('Bib 写入完成: {{path}}', { path: targetBib }));

    const targetFile = websearchTargetFile || mainFile || activePath;
    const perItemBlock = perItemLines.length
      ? `\\paragraph{${t('逐条总结')}}\n\\begin{itemize}\n${perItemLines.join('\n')}\n\\end{itemize}\n\n`
      : '';
    const finalBlock = websearchParagraph ? `\\paragraph{${t('综合总结')}}\n${websearchParagraph}\n` : '';
    const insertBlock = `${perItemBlock}${finalBlock}`.trim();
    if (!insertBlock) {
      appendLog(setWebsearchLog, t('没有可插入的总结内容。'));
      return;
    }
    if (targetFile && targetFile.toLowerCase().endsWith('.tex')) {
      const targetContent = await ensureFileContent(targetFile);
      const insertText = insertBlock ? `\n${insertBlock}\n` : '\n';
      const nextContent = `${targetContent}\n${insertText}`.replace(/\n{3,}/g, '\n\n');
      await writeFileCompat(targetFile, nextContent);
      setFiles((prev) => ({ ...prev, [targetFile]: nextContent }));
      if (activePath === targetFile) {
        setEditorValue(nextContent);
        setEditorDoc(nextContent);
      }
      appendLog(setWebsearchLog, t('段落已插入 {{path}}', { path: targetFile }));
    } else if (activePath && activePath.toLowerCase().endsWith('.tex')) {
      if (insertBlock) {
        insertAtCursor(insertBlock, { block: true });
      }
      appendLog(setWebsearchLog, t('段落已插入光标位置。'));
    }
  };

  const handleUpload = async (fileList: FileList | null, basePath = '') => {
    if (!projectId || !fileList || fileList.length === 0) return;
    const files = Array.from(fileList);
    await uploadFiles(projectId, files, basePath);
    await refreshTree();
  };

  const handleVisionSubmit = async () => {
    if (!projectId) return;
    if (!visionFile) {
      setStatus(t('请先选择图片。'));
      return;
    }
    setVisionBusy(true);
    setVisionResult('');
    try {
      let extraPrompt = visionPrompt.trim();
      if (!extraPrompt) {
        if (visionMode === 'table') {
          extraPrompt = t('只输出表格的 LaTeX（tabular 或 table），不要包含文档结构。');
        } else if (visionMode === 'algorithm') {
          extraPrompt = t('只输出 algorithm/algorithmic 环境，不要包含文档结构。');
        } else if (visionMode === 'equation') {
          extraPrompt = t('只输出 equation 环境，不要包含文档结构。');
        }
      }
      const res = await visionToLatex({
        projectId,
        file: visionFile,
        mode: visionMode,
        prompt: extraPrompt,
        llmConfig: visionLlmConfig
      });
      if (!res.ok) {
        throw new Error(res.error || t('识别失败'));
      }
      setVisionResult(res.latex || '');
    } catch (err) {
      setStatus(t('识别失败: {{error}}', { error: String(err) }));
    } finally {
      setVisionBusy(false);
    }
  };

  const handleVisionInsert = () => {
    if (!visionResult) return;
    insertAtCursor(visionResult, { block: true });
  };

  const beginInlineCreate = (kind: 'new-file' | 'new-folder') => {
    if (!projectId) return;
    const selectedIsDir = selectedPath && tree.find((item) => item.path === selectedPath && item.type === 'dir');
    const parent = selectedIsDir ? selectedPath : getParentPath(selectedPath || activePath || '');
    setInlineEdit({ kind, parent, value: '' });
    if (parent) {
      setOpenFolders((prev) => ({ ...prev, [parent]: true }));
    }
  };

  const beginInlineRename = () => {
    if (!projectId) return;
    const target = selectedPath || activePath;
    if (!target) return;
    const name = target.split('/').pop() || target;
    setInlineEdit({ kind: 'rename', path: target, value: name });
  };

  const confirmInlineEdit = async () => {
    if (!projectId || !inlineEdit) return;
    const value = inlineEdit.value.trim();
    if (!value) {
      setInlineEdit(null);
      return;
    }
    if (inlineEdit.kind === 'rename') {
      const from = inlineEdit.path;
      const parent = getParentPath(from);
      const to = parent ? `${parent}/${value}` : value;
      const entry = tree.find((item) => item.path === from);
      const fromName = from.split('/').pop() || '';
      await renamePath(projectId, from, to);
      if (activePath === from) {
        setActivePath(to);
        activePathRef.current = to;
      }
      setSelectedPath(to);
      if (parent && fromName && fileOrder[parent]) {
        const nextOrder = fileOrder[parent].map((name) => (name === fromName ? value : name));
        await persistFileOrder(parent, nextOrder);
      }
      if (entry?.type === 'dir' && fileOrder[from]) {
        await persistFileOrder(to, fileOrder[from]);
        await persistFileOrder(from, []);
      }
      await refreshTree();
      setInlineEdit(null);
      return;
    }

    const parent = inlineEdit.parent;
    const target = parent ? `${parent}/${value}` : value;
    if (inlineEdit.kind === 'new-folder') {
      await createFolderApi(projectId, target);
      if (fileOrder[parent]) {
        await persistFileOrder(parent, [...fileOrder[parent], value]);
      }
    } else {
      await writeFileCompat(target, '');
      if (isTextFile(target)) {
        await openFile(target);
      }
      if (fileOrder[parent]) {
        await persistFileOrder(parent, [...fileOrder[parent], value]);
      }
    }
    await refreshTree();
    setInlineEdit(null);
  };

  const cancelInlineEdit = () => setInlineEdit(null);

  const moveFileWithOrder = async (fromPath: string, folderPath: string, beforeName?: string) => {
    if (!projectId || !fromPath) return;
    const fileName = fromPath.split('/').pop();
    if (!fileName) return;
    const target = folderPath ? `${folderPath}/${fileName}` : fileName;
    if (target === fromPath) return;
    await renamePath(projectId, fromPath, target);
    if (activePath === fromPath) {
      setActivePath(target);
      activePathRef.current = target;
    }
    setSelectedPath(target);

    const fromParent = getParentPath(fromPath);
    if (fromParent && fileOrder[fromParent]) {
      await persistFileOrder(fromParent, fileOrder[fromParent].filter((name) => name !== fileName));
    }

    const targetNode = folderPath ? findTreeNode(treeRoot, folderPath) : treeRoot;
    const childNames = targetNode ? targetNode.children.map((child) => child.name) : [];
    const baseOrder = (fileOrder[folderPath] || []).filter((name) => childNames.includes(name) && name !== fileName);
    childNames.forEach((name) => {
      if (!baseOrder.includes(name) && name !== fileName) baseOrder.push(name);
    });
    const insertIndex = beforeName && baseOrder.includes(beforeName) ? baseOrder.indexOf(beforeName) : baseOrder.length;
    const nextOrder = [...baseOrder];
    nextOrder.splice(insertIndex, 0, fileName);
    await persistFileOrder(folderPath, nextOrder);

    await refreshTree();
  };

  const updateDragHint = useCallback((text: string, event: DragEvent) => {
    const host = fileTreeRef.current;
    if (!host) return;
    const rect = host.getBoundingClientRect();
    const x = Math.min(rect.width - 12, Math.max(8, event.clientX - rect.left));
    const y = Math.min(rect.height - 12, Math.max(8, event.clientY - rect.top));
    setDragHint({ text, x, y });
  }, []);

  const persistFileOrder = useCallback(
    async (folder: string, order: string[]) => {
      if (!projectId) return;
      setFileOrder((prev) => ({ ...prev, [folder]: order }));
      try {
        await updateFileOrder(projectId, folder, order);
      } catch (err) {
        setStatus(t('保存排序失败: {{error}}', { error: String(err) }));
      }
    },
    [projectId, t]
  );

  const filteredTreeItems = useMemo(() => {
    const term = fileFilter.trim().toLowerCase();
    if (!term) return tree;
    return tree.filter((item) => item.path.toLowerCase().includes(term));
  }, [tree, fileFilter]);

  const treeRoot = useMemo(() => buildTree(filteredTreeItems, fileOrder), [filteredTreeItems, fileOrder]);

  const reorderWithinFolder = useCallback(
    async (fromPath: string, targetPath: string) => {
      if (fileFilter.trim()) return false;
      const fromParent = getParentPath(fromPath);
      const targetParent = getParentPath(targetPath);
      if (fromParent !== targetParent) return false;
      const fromName = fromPath.split('/').pop();
      const targetName = targetPath.split('/').pop();
      if (!fromName || !targetName || fromName === targetName) return false;
      const node = findTreeNode(treeRoot, fromParent);
      if (!node) return false;
      const currentNames = node.children.map((child) => child.name);
      const baseOrder = (fileOrder[fromParent] || []).filter((name) => currentNames.includes(name));
      currentNames.forEach((name) => {
        if (!baseOrder.includes(name)) baseOrder.push(name);
      });
      const nextOrder = baseOrder.filter((name) => name !== fromName);
      const targetIndex = nextOrder.indexOf(targetName);
      const insertIndex = targetIndex === -1 ? nextOrder.length : targetIndex;
      nextOrder.splice(insertIndex, 0, fromName);
      await persistFileOrder(fromParent, nextOrder);
      return true;
    },
    [fileOrder, persistFileOrder, treeRoot]
  );

  const texFiles = useMemo(
    () => tree.filter((item) => item.type === 'file' && item.path.toLowerCase().endsWith('.tex')).map((item) => item.path),
    [tree]
  );

  const bibFiles = useMemo(
    () => tree.filter((item) => item.type === 'file' && item.path.toLowerCase().endsWith('.bib')).map((item) => item.path),
    [tree]
  );

  const translateTargetOptions = useMemo(
    () => [
      { value: 'English', label: t('English') },
      { value: '中文', label: t('中文') },
      { value: '日本語', label: t('日本語') },
      { value: '한국어', label: t('한국어') },
      { value: 'Français', label: t('Français') },
      { value: 'Deutsch', label: t('Deutsch') },
      { value: 'Español', label: t('Español') }
    ],
    [t]
  );

  const outlineItems = useMemo(() => {
    if (!outlineText || !mainFile || !mainFile.toLowerCase().endsWith('.tex')) return [];
    return parseOutline(outlineText);
  }, [outlineText, mainFile]);

  useEffect(() => {
    if (!mainFile) {
      setOutlineText('');
      return;
    }
    if (activePath === mainFile) {
      setOutlineText(editorValue);
      return;
    }
    let cancelled = false;
    const load = async () => {
      try {
        const content = await ensureFileContent(mainFile);
        if (!cancelled) setOutlineText(content);
      } catch {
        if (!cancelled) setOutlineText('');
      }
    };
    load();
    return () => {
      cancelled = true;
    };
  }, [activePath, editorValue, ensureFileContent, mainFile]);

  useEffect(() => {
    if (!visionFile) {
      setVisionPreviewUrl('');
      return;
    }
    const url = URL.createObjectURL(visionFile);
    setVisionPreviewUrl(url);
    return () => {
      URL.revokeObjectURL(url);
    };
  }, [visionFile]);

  useEffect(() => {
    if (texFiles.length === 0) return;
    if (!texFiles.includes(mainFile)) {
      const preferred = texFiles.find((path) => path.endsWith('main.tex')) || texFiles[0];
      setMainFile(preferred);
    }
  }, [texFiles, mainFile]);

  useEffect(() => {
    if (citeTargetFile) return;
    if (mainFile) {
      setCiteTargetFile(mainFile);
    } else if (texFiles.length > 0) {
      setCiteTargetFile(texFiles[0]);
    }
  }, [citeTargetFile, mainFile, texFiles]);

  useEffect(() => {
    if (websearchTargetFile) return;
    if (mainFile) {
      setWebsearchTargetFile(mainFile);
    } else if (texFiles.length > 0) {
      setWebsearchTargetFile(texFiles[0]);
    }
  }, [websearchTargetFile, mainFile, texFiles]);

  useEffect(() => {
    if (websearchTargetBib) return;
    if (bibFiles.length > 0) {
      setWebsearchTargetBib(bibFiles[0]);
    }
  }, [bibFiles, websearchTargetBib]);

  useEffect(() => {
    if (!bibTarget && bibFiles.length > 0) {
      setBibTarget(bibFiles[0]);
    }
  }, [bibFiles, bibTarget]);

  const setAllFolders = useCallback(
    (open: boolean) => {
      const next: Record<string, boolean> = {};
      const walk = (nodes: TreeNode[]) => {
        nodes.forEach((node) => {
          if (node.type === 'dir') {
            next[node.path] = open;
            walk(node.children);
          }
        });
      };
      walk(treeRoot.children);
      setOpenFolders(next);
    },
    [treeRoot]
  );

  const toggleFolder = (path: string) => {
    setOpenFolders((prev) => ({ ...prev, [path]: !prev[path] }));
    setSelectedPath(path);
  };

  const handleFileSelect = async (path: string) => {
    setSelectedPath(path);
    if (isFigureFile(path)) {
      setSelectedFigure(path);
      setRightView('figures');
      return;
    }
    if (!isTextFile(path)) {
      setStatus(t('该文件为二进制文件，暂不支持直接编辑。'));
      return;
    }
    await openFile(path);
  };

  const inlineInputRow = (depth: number) => {
    if (!inlineEdit) return null;
    const paddingLeft = 8 + depth * 14;
    const isFolder = inlineEdit.kind === 'new-folder';
    return (
      <div className="tree-node">
        <div className={`tree-row ${isFolder ? 'folder' : 'file'} inline`} style={{ paddingLeft: paddingLeft + 14 }}>
          <input
            className="inline-input"
            autoFocus
            value={inlineEdit.value}
            onChange={(event) => setInlineEdit({ ...inlineEdit, value: event.target.value })}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                confirmInlineEdit().catch((err) => setStatus(t('操作失败: {{error}}', { error: String(err) })));
              }
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelInlineEdit();
              }
            }}
            onBlur={() => cancelInlineEdit()}
            placeholder={isFolder ? t('新建文件夹') : t('新建文件')}
          />
        </div>
      </div>
    );
  };

  const jumpToError = async (error: CompileError) => {
    const view = cmViewRef.current;
    const targetFile = error.file && isTextFile(error.file) ? error.file : activePath;
    if (!targetFile) return;
    let content = '';
    try {
      content = targetFile === activePath ? editorValue : await openFile(targetFile);
    } catch {
      return;
    }
    if (!content || !view) return;
    if (error.line) {
      const offset = findLineOffset(content, error.line);
      view.dispatch({
        selection: { anchor: offset, head: offset },
        scrollIntoView: true
      });
      view.focus();
    }
  };

  const renderTree = (nodes: TreeNode[], depth = 0) =>
    nodes.map((node) => {
      const isDir = node.type === 'dir';
      const isOpen = openFolders[node.path] ?? depth < 1;
      const isActive = activePath === node.path;
      const isSelected = selectedPath === node.path;
      const isDragOver = dragOverPath === node.path;
      const paddingLeft = 8 + depth * 14;

      if (isDir) {
        return (
          <div key={node.path} className="tree-node">
            <button
              className={`tree-row folder ${isOpen ? 'open' : ''} ${isSelected ? 'selected' : ''} ${isDragOver ? 'drag-over' : ''}`}
              style={{ paddingLeft }}
              onClick={() => toggleFolder(node.path)}
              onDragOver={(event) => {
                event.preventDefault();
                setDragOverPath(node.path);
                setDragOverKind('folder');
                if (draggingPath) {
                  updateDragHint(t('移动到 {{name}} 文件夹', { name: node.name }), event);
                }
              }}
              onDragLeave={() => {
                setDragOverPath('');
                setDragOverKind('');
                setDragHint(null);
              }}
              onDrop={(event) => {
                event.preventDefault();
                if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                  handleUpload(event.dataTransfer.files, node.path).catch((err) => setStatus(t('上传失败: {{error}}', { error: String(err) })));
                  setDragOverPath('');
                  setDragOverKind('');
                  setDragHint(null);
                  return;
                }
                const from = event.dataTransfer.getData('text/plain');
                setDragOverPath('');
                setDragOverKind('');
                setDragHint(null);
                if (from) {
                  if (fileFilter.trim()) {
                    setStatus(t('搜索过滤中无法拖拽移动。'));
                    return;
                  }
                  moveFileWithOrder(from, node.path).catch((err) => setStatus(t('移动失败: {{error}}', { error: String(err) })));
                }
              }}
            >
              <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
              <span className="tree-icon folder" />
              {inlineEdit?.kind === 'rename' && inlineEdit.path === node.path ? (
                <input
                  className="inline-input"
                  autoFocus
                  value={inlineEdit.value}
                  onChange={(event) => setInlineEdit({ ...inlineEdit, value: event.target.value })}
                  onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    event.preventDefault();
                    confirmInlineEdit().catch((err) => setStatus(t('操作失败: {{error}}', { error: String(err) })));
                  }
                    if (event.key === 'Escape') {
                      event.preventDefault();
                      cancelInlineEdit();
                    }
                  }}
                  onBlur={() => cancelInlineEdit()}
                />
              ) : (
                <span className="tree-label">{node.name}</span>
              )}
            </button>
            {isOpen && (
              <div className="tree-children">
                {renderTree(node.children, depth + 1)}
                {inlineEdit && inlineEdit.kind !== 'rename' && inlineEdit.parent === node.path && inlineInputRow(depth + 1)}
              </div>
            )}
          </div>
        );
      }

      return (
        <button
          key={node.path}
          className={`tree-row file ${isActive ? 'active' : ''} ${isSelected ? 'selected' : ''} ${isDragOver ? (dragOverKind === 'file' ? 'drag-over-file' : 'drag-over') : ''} ${draggingPath === node.path ? 'dragging' : ''}`}
          style={{ paddingLeft: paddingLeft + 14 }}
          onClick={() => handleFileSelect(node.path)}
          draggable
          onDragStart={(event) => {
            event.dataTransfer.setData('text/plain', node.path);
            setDraggingPath(node.path);
          }}
          onDragEnd={() => {
            setDraggingPath('');
            setDragHint(null);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragOverPath(node.path);
            setDragOverKind('file');
            if (draggingPath) {
              const targetParent = getParentPath(node.path);
              const fromParent = getParentPath(draggingPath);
              const parentLabel = targetParent || t('根目录');
              const hint =
                fromParent === targetParent
                  ? t('插入到 {{name}} 前', { name: node.name })
                  : t('移动到 {{parent}} 并插入到 {{name}} 前', { parent: parentLabel, name: node.name });
              updateDragHint(hint, event);
            }
          }}
          onDragLeave={() => {
            setDragOverPath('');
            setDragOverKind('');
            setDragHint(null);
          }}
          onDrop={(event) => {
            event.preventDefault();
            const from = event.dataTransfer.getData('text/plain');
            setDragOverPath('');
            setDragOverKind('');
            setDragHint(null);
            if (!from) return;
            if (fileFilter.trim()) {
              setStatus(t('搜索过滤中无法拖拽排序。'));
              return;
            }
            const targetParent = getParentPath(node.path);
            const fromParent = getParentPath(from);
            if (fromParent === targetParent) {
              reorderWithinFolder(from, node.path).catch((err) => setStatus(t('排序失败: {{error}}', { error: String(err) })));
              return;
            }
            moveFileWithOrder(from, targetParent, node.name).catch((err) => setStatus(t('移动失败: {{error}}', { error: String(err) })));
          }}
        >
          <span className={`tree-icon file ext-${getFileTypeLabel(node.path).toLowerCase()}`}>{getFileTypeLabel(node.path)}</span>
          {inlineEdit?.kind === 'rename' && inlineEdit.path === node.path ? (
            <input
              className="inline-input"
              autoFocus
              value={inlineEdit.value}
              onChange={(event) => setInlineEdit({ ...inlineEdit, value: event.target.value })}
              onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                confirmInlineEdit().catch((err) => setStatus(t('操作失败: {{error}}', { error: String(err) })));
              }
                if (event.key === 'Escape') {
                  event.preventDefault();
                  cancelInlineEdit();
                }
              }}
              onBlur={() => cancelInlineEdit()}
            />
          ) : (
            <span className="tree-label">{node.name}</span>
          )}
          {isFigureFile(node.path) && <span className="tree-tag">FIG</span>}
          {node.path.endsWith('.bib') && <span className="tree-tag">BIB</span>}
        </button>
      );
    });

  const compile = async () => {
    if (!projectId) return;
    setIsCompiling(true);
    setStatus(t('编译中...'));
    try {
      const { files: serverFiles } = await getAllFiles(projectId);
      const fileMap: Record<string, string | Uint8Array> = {};
      for (const file of serverFiles) {
        if (file.encoding === 'base64') {
          const binary = Uint8Array.from(atob(file.content), (c) => c.charCodeAt(0));
          fileMap[file.path] = binary;
        } else {
          fileMap[file.path] = files[file.path] ?? file.content;
        }
      }
      if (activePath) {
        fileMap[activePath] = editorValue;
      }
      if (!fileMap[mainFile]) {
        throw new Error(t('主文件不存在: {{file}}', { file: mainFile }));
      }
      const res = await compileProject({ projectId, mainFile, engine: compileEngine });
      if (!res.ok || !res.pdf) {
        const detail = [res.error, res.log].filter(Boolean).join('\n');
        throw new Error(detail || t('后端编译失败'));
      }
      const result: CompileOutcome = {
        pdf: Uint8Array.from(atob(res.pdf), (c) => c.charCodeAt(0)),
        log: res.log || '',
        status: res.status ?? 0,
        engine: compileEngine
      };

      const meta = [
        t('Engine: {{engine}}', { engine: compileEngine }),
        t('Main file: {{file}}', { file: mainFile })
      ].filter(Boolean).join('\n');
      setEngineName(compileEngine);
      setCompileLog(`${meta}\n\n${result.log || t('No log')}`.trim());

      const blob = new Blob([result.pdf], { type: 'application/pdf' });
      const nextUrl = URL.createObjectURL(blob);
      if (pdfUrl) {
        URL.revokeObjectURL(pdfUrl);
      }
      setPdfUrl(nextUrl);
      setRightView('pdf');
      setStatus(t('编译完成 ({{engine}})', { engine: result.engine }));
    } catch (err) {
      console.error('Compilation error:', err);
      setCompileLog(`${t('编译错误: {{error}}', { error: String(err) })}\n${(err as Error).stack || ''}`);
      setStatus(t('编译失败: {{error}}', { error: String(err) }));
    } finally {
      setIsCompiling(false);
    }
  };

  const selectionText = useMemo(() => {
    const [start, end] = selectionRange;
    if (start === end) return '';
    return editorValue.slice(start, end);
  }, [selectionRange, editorValue]);

  const compileErrors = useMemo(() => parseCompileErrors(compileLog), [compileLog]);
  const pendingGrouped = useMemo(() => {
    const map = new Map<string, PendingChange>();
    pendingChanges.forEach((item) => {
      map.set(item.filePath, item);
    });
    return Array.from(map.values());
  }, [pendingChanges]);

  const figureFiles = useMemo(
    () =>
      tree.filter(
        (item) =>
          item.type === 'file' &&
          FIGURE_EXTS.some((ext) => item.path.toLowerCase().endsWith(ext))
      ),
    [tree]
  );

  useEffect(() => {
    if (!selectedFigure && figureFiles.length > 0) {
      setSelectedFigure(figureFiles[0].path);
    }
  }, [figureFiles, selectedFigure]);

  useEffect(() => {
    setPdfAnnotations([]);
    setPdfOutline([]);
  }, [pdfUrl]);

  const pdfScaleLabel = useMemo(() => {
    if (pdfFitWidth) {
      const fitValue = pdfFitScale ?? pdfScale;
      return t('Fit · {{percent}}%', { percent: Math.round(fitValue * 100) });
    }
    return `${Math.round(pdfScale * 100)}%`;
  }, [pdfFitScale, pdfFitWidth, pdfScale, t]);

  const breadcrumbParts = useMemo(() => (activePath ? activePath.split('/').filter(Boolean) : []), [activePath]);

  const clampPdfScale = useCallback((value: number) => Math.min(2.5, Math.max(0.6, value)), []);

  const zoomPdf = useCallback(
    (delta: number) => {
      const base = pdfFitScale ?? pdfScale;
      setPdfFitWidth(false);
      setPdfScale(clampPdfScale(base + delta));
    },
    [clampPdfScale, pdfFitScale, pdfScale]
  );

  const scrollToPdfPage = useCallback((page: number) => {
    const container = pdfContainerRef.current;
    if (!container || !page) return;
    const target = container.querySelector(`.pdf-page[data-page-number="${page}"]`) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }, []);

  const handlePdfOutline = useCallback((items: { title: string; page?: number; level: number }[]) => {
    setPdfOutline(items);
  }, []);

  const addPdfAnnotation = useCallback((page: number, x: number, y: number) => {
    const text = window.prompt(t('输入注释内容'))?.trim();
    if (!text) return;
    const id = typeof crypto !== 'undefined' && crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    setPdfAnnotations((prev) => [...prev, { id, page, x, y, text }]);
  }, [t]);

  const downloadPdf = useCallback(() => {
    if (!pdfUrl) return;
    const name = projectName ? projectName.replace(/\s+/g, '-') : projectId || 'openprism';
    const link = document.createElement('a');
    link.href = pdfUrl;
    link.download = `${name}.pdf`;
    document.body.appendChild(link);
    link.click();
    link.remove();
  }, [pdfUrl, projectId, projectName]);

  const handleFitScale = useCallback((value: number | null) => {
    if (value == null) {
      setPdfFitScale(null);
      return;
    }
    setPdfFitScale((prev) => (prev && Math.abs(prev - value) < 0.005 ? prev : value));
  }, []);

  const startTypewriter = useCallback((setHistory: Dispatch<SetStateAction<Message[]>>, text: string) => {
    if (typewriterTimerRef.current) {
      window.clearTimeout(typewriterTimerRef.current);
      typewriterTimerRef.current = null;
    }
    if (!text) {
      setHistory((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const last = next[next.length - 1];
        if (last.role === 'assistant') {
          next[next.length - 1] = { ...last, content: '' };
        }
        return next;
      });
      return;
    }
    let idx = 0;
    const step = () => {
      idx = Math.min(text.length, idx + 2);
      const slice = text.slice(0, idx);
      setHistory((prev) => {
        if (prev.length === 0) return prev;
        const next = [...prev];
        const last = next[next.length - 1];
        if (last.role !== 'assistant') return prev;
        next[next.length - 1] = { ...last, content: slice };
        return next;
      });
      if (idx < text.length) {
        typewriterTimerRef.current = window.setTimeout(step, 16);
      }
    };
    step();
  }, []);

  useEffect(() => {
    return () => {
      if (typewriterTimerRef.current) {
        window.clearTimeout(typewriterTimerRef.current);
      }
    };
  }, []);

  const sendPrompt = async () => {
    const isChat = assistantMode === 'chat';
    if (!activePath && !isChat) return;
    if (isChat === false && task === 'translate') {
      if (translateScope === 'selection' && !selectionText) {
        setStatus(t('请选择要翻译的文本。'));
        return;
      }
    }
    const userMsg: Message = { role: 'user', content: prompt || t('(empty)') };
    const setHistory = isChat ? setChatMessages : setAgentMessages;
    const history = isChat ? chatMessages : agentMessages;
    const nextHistory = [...history, userMsg];
    setHistory(nextHistory);
    try {
      let effectivePrompt = prompt;
      let effectiveSelection = selectionText;
      let effectiveContent = editorValue;
      let effectiveMode = mode;
      let effectiveTask = task;

      if (!isChat && task === 'translate') {
        const note = prompt ? `\n${t('User note')}: ${prompt}` : '';
        if (translateScope === 'project') {
          effectiveMode = 'tools';
          effectiveSelection = '';
          effectiveContent = '';
          effectivePrompt = t('Translate all .tex files in the project to {{target}}. Preserve LaTeX commands and structure.{{note}}', { target: translateTarget, note });
        } else if (translateScope === 'file') {
          effectiveSelection = '';
          effectivePrompt = t('Translate the current file to {{target}}. Preserve LaTeX commands and structure.{{note}}', { target: translateTarget, note });
        } else {
          effectivePrompt = t('Translate the selected text to {{target}}. Preserve LaTeX commands and structure.{{note}}', { target: translateTarget, note });
        }
        effectiveTask = 'translate';
      }

      if (!isChat && task === 'websearch') {
        effectiveMode = 'tools';
        effectiveSelection = '';
        effectiveContent = '';
        effectivePrompt = prompt
          ? t('Search arXiv and return 3-5 relevant papers with BibTeX entries. User query: {{query}}', { query: prompt })
          : t('Search arXiv and return 3-5 relevant papers with BibTeX entries.');
        effectiveTask = 'websearch';
      }

      if (!isChat && effectiveTask !== 'websearch') {
        const context = await buildProjectContext();
        if (context) {
          effectivePrompt = `${effectivePrompt}\n\n[Project Context]\n${context}`;
        }
      }

      const effectiveLlmConfig = !isChat && effectiveTask === 'websearch' ? searchLlmConfig : llmConfig;
      const res = await runAgent({
        task: effectiveTask,
        prompt: effectivePrompt,
        selection: effectiveSelection,
        content: effectiveContent,
        mode: isChat ? 'direct' : effectiveMode,
        projectId,
        activePath,
        compileLog,
        llmConfig: effectiveLlmConfig,
        interaction: isChat ? 'chat' : 'agent',
        history: nextHistory.slice(-8)
      });
      const replyText = res.reply || t('已生成建议。');
      setHistory((prev) => [...prev, { role: 'assistant', content: '' }]);
      window.setTimeout(() => startTypewriter(setHistory, replyText), 0);

      if (!isChat && res.patches && res.patches.length > 0) {
        const nextPending = res.patches.map((patch) => ({
          filePath: patch.path,
          original: files[patch.path] ?? '',
          proposed: patch.content,
          diff: patch.diff
        }));
        setPendingChanges(nextPending);
        setRightView('diff');
      } else if (!isChat && res.suggestion) {
        const proposed = selectionText
          ? replaceSelection(editorValue, selectionRange[0], selectionRange[1], res.suggestion)
          : res.suggestion;
        const diff = createTwoFilesPatch(activePath, activePath, editorValue, proposed, 'current', 'suggested');
        setPendingChanges([{ filePath: activePath, original: editorValue, proposed, diff }]);
        setRightView('diff');
      }
    } catch (err) {
      setHistory((prev) => [...prev, { role: 'assistant', content: t('请求失败: {{error}}', { error: String(err) }) }]);
    }
  };

  const diagnoseCompile = async () => {
    if (!compileLog) {
      setStatus(t('暂无编译日志可诊断。'));
      return;
    }
    if (!activePath) return;
    setDiagnoseBusy(true);
    const userMsg: Message = { role: 'user', content: t('诊断并修复编译错误') };
    const nextHistory = [...agentMessages, userMsg];
    setAgentMessages(nextHistory);
    try {
      const res = await runAgent({
        task: 'debug_compile',
        prompt: t('基于编译日志诊断并修复错误，给出可应用的 diff。'),
        selection: compileLog,
        content: editorValue,
        mode: 'tools',
        projectId,
        activePath,
        compileLog,
        llmConfig,
        interaction: 'agent',
        history: nextHistory.slice(-8)
      });
      const assistant: Message = {
        role: 'assistant',
        content: res.reply || t('已生成编译修复建议。')
      };
      setAgentMessages((prev) => [...prev, assistant]);
      if (res.patches && res.patches.length > 0) {
        const nextPending = res.patches.map((patch) => ({
          filePath: patch.path,
          original: files[patch.path] ?? '',
          proposed: patch.content,
          diff: patch.diff
        }));
        setPendingChanges(nextPending);
        setRightView('diff');
      }
    } catch (err) {
      setAgentMessages((prev) => [...prev, { role: 'assistant', content: t('请求失败: {{error}}', { error: String(err) }) }]);
    } finally {
      setDiagnoseBusy(false);
    }
  };

  const applyPending = async (change?: PendingChange) => {
    const list = change ? [change] : pendingChanges;
    for (const item of list) {
      await writeFileCompat(item.filePath, item.proposed);
      setFiles((prev) => ({ ...prev, [item.filePath]: item.proposed }));
      if (activePath === item.filePath) {
        setEditorDoc(item.proposed);
      }
    }
    if (change) {
      setPendingChanges((prev) => prev.filter((item) => item.filePath !== change.filePath));
      if (diffFocus?.filePath === change.filePath) {
        setDiffFocus(null);
      }
    } else {
      setPendingChanges([]);
      setDiffFocus(null);
    }
    setStatus(t('已应用修改'));
  };

  const discardPending = (change?: PendingChange) => {
    if (change) {
      setPendingChanges((prev) => prev.filter((item) => item.filePath !== change.filePath));
      if (diffFocus?.filePath === change.filePath) {
        setDiffFocus(null);
      }
    } else {
      setPendingChanges([]);
      setDiffFocus(null);
    }
  };

  const startColumnDrag = useCallback(
    (side: 'left' | 'right', event: MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const { sidebar, editor, right } = columnSizes;
      const minSidebar = 220;
      const minEditor = 360;
      const minRight = 320;

      const onMove = (moveEvent: MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        if (side === 'left') {
          const nextSidebar = Math.max(minSidebar, sidebar + dx);
          const nextEditor = Math.max(minEditor, editor - dx);
          setColumnSizes({ sidebar: nextSidebar, editor: nextEditor, right });
        } else {
          const nextEditor = Math.max(minEditor, editor + dx);
          const nextRight = Math.max(minRight, right - dx);
          setColumnSizes({ sidebar, editor: nextEditor, right: nextRight });
        }
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [columnSizes]
  );

  const startEditorSplitDrag = useCallback(
    (event: MouseEvent) => {
      event.preventDefault();
      const container = editorSplitRef.current;
      if (!container) return;

      const onMove = (moveEvent: MouseEvent) => {
        const rect = container.getBoundingClientRect();
        const offsetY = moveEvent.clientY - rect.top;
        const ratio = Math.min(0.85, Math.max(0.35, offsetY / rect.height));
        setEditorSplit(ratio);
      };

      const onUp = () => {
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };

      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    []
  );

  return (
    <div className="app-shell">
      <header className="top-bar">
        <div className="brand">
          <div className="brand-title">OpenPrism</div>
          <div className="brand-sub">{projectName || t('Editor Workspace')}</div>
        </div>
        <div className="toolbar">
          <Link to="/projects" className="btn ghost">{t('Projects')}</Link>
          <button className="btn ghost" onClick={() => setSidebarOpen((prev) => !prev)}>
            {sidebarOpen ? t('隐藏侧栏') : t('显示侧栏')}
          </button>
          <div className="ios-select-wrapper">
            <button className="ios-select-trigger" onClick={(e) => {
              const opening = !mainFileDropdownOpen;
              setMainFileDropdownOpen(opening); setEngineDropdownOpen(false); setLangDropdownOpen(false);
              if (opening) { const r = e.currentTarget.getBoundingClientRect(); setTopBarDropdownRect({ top: r.bottom + 6, left: r.left, width: r.width }); }
            }}>
              <span>{mainFile}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={mainFileDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
          <div className="ios-select-wrapper">
            <button className="ios-select-trigger" onClick={(e) => {
              const opening = !engineDropdownOpen;
              setEngineDropdownOpen(opening); setMainFileDropdownOpen(false); setLangDropdownOpen(false);
              if (opening) { const r = e.currentTarget.getBoundingClientRect(); setTopBarDropdownRect({ top: r.bottom + 6, left: r.left, width: r.width }); }
            }}>
              <span>{({'pdflatex':'pdfLaTeX','xelatex':'XeLaTeX','lualatex':'LuaLaTeX','latexmk':'Latexmk','tectonic':'Tectonic'} as Record<string,string>)[compileEngine] || compileEngine}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={engineDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
          <button onClick={saveActiveFile} className="btn ghost">{t('保存')}</button>
          <button onClick={compile} className="btn" disabled={isCompiling}>
            {isCompiling ? t('编译中...') : t('编译 PDF')}
          </button>
          <button className="btn ghost" onClick={() => setSettingsOpen(true)}>{t('设置')}</button>
          <div className="ios-select-wrapper">
            <button className="ios-select-trigger" onClick={(e) => {
              const opening = !langDropdownOpen;
              setLangDropdownOpen(opening); setMainFileDropdownOpen(false); setEngineDropdownOpen(false);
              if (opening) { const r = e.currentTarget.getBoundingClientRect(); setTopBarDropdownRect({ top: r.bottom + 6, left: r.left, width: r.width }); }
            }}>
              <span>{i18n.language === 'zh-CN' ? t('中文') : t('English')}</span>
              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={langDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
          </div>
        </div>
      </header>

      <div className="status-bar">
        <div className="status-left">
          <div>{status}</div>
          <div className={`save-indicator ${isSaving ? 'saving' : isDirty ? 'dirty' : 'saved'} ${savePulse ? 'pulse' : ''}`}>
            <span className="dot" />
            <span>{isSaving ? t('保存中...') : isDirty ? t('未保存') : t('已保存')}</span>
          </div>
        </div>
        <div className="status-right">
          {t('Compile')}: {compileEngine} · {t('Engine')}: {engineName || t('未初始化')}
        </div>
      </div>

      <main
        className="workspace"
        ref={gridRef}
        style={{
          '--col-sidebar': sidebarOpen ? `${columnSizes.sidebar}px` : '0px',
          '--col-sidebar-gap': sidebarOpen ? '10px' : '0px',
          '--col-editor': `${columnSizes.editor}px`,
          '--col-right': `${columnSizes.right}px`
        } as CSSProperties}
      >
        {sidebarOpen && (
          <aside className="panel side-panel">
            <div className="sidebar-tabs">
              <div className="tab-group">
                <button
                  className={`tab-btn ${activeSidebar === 'files' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('files')}
                  title={t('Files')}
                >
                  <span className="tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg></span>
                  <span className="tab-text">{t('Files')}</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'collab' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('collab')}
                  title={t('协作')}
                >
                  <span className="tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 21v-2a4 4 0 0 0-3-3.87"/><path d="M7 21v-2a4 4 0 0 1 3-3.87"/><circle cx="7" cy="7" r="3"/><circle cx="17" cy="7" r="3"/></svg></span>
                  <span className="tab-text">{t('协作')}</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'agent' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('agent')}
                  title={t('Agent')}
                >
                  <span className="tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/></svg></span>
                  <span className="tab-text">{t('Agent')}</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'vision' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('vision')}
                  title={t('图像识别')}
                >
                  <span className="tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg></span>
                  <span className="tab-text">{t('图像识别')}</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'search' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('search')}
                  title={t('论文检索')}
                >
                  <span className="tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg></span>
                  <span className="tab-text">{t('论文检索')}</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'websearch' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('websearch')}
                  title={t('Websearch')}
                >
                  <span className="tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10"/><line x1="2" y1="12" x2="22" y2="12"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg></span>
                  <span className="tab-text">{t('Websearch')}</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'plot' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('plot')}
                  title={t('绘图')}
                >
                  <span className="tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg></span>
                  <span className="tab-text">{t('绘图')}</span>
                </button>
                <button
                  className={`tab-btn ${activeSidebar === 'review' ? 'active' : ''}`}
                  onClick={() => setActiveSidebar('review')}
                  title={t('Review')}
                >
                  <span className="tab-icon"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg></span>
                  <span className="tab-text">{t('Review')}</span>
                </button>
              </div>
              <button className="icon-btn" onClick={() => setSidebarOpen(false)}>✕</button>
            </div>
            {activeSidebar === 'files' ? (
              <>
                <div className="panel-header">
                  <div>{t('Project Files')}</div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  onChange={(event) => {
                    handleUpload(event.target.files).catch((err) => setStatus(t('上传失败: {{error}}', { error: String(err) })));
                    if (event.target) {
                      event.target.value = '';
                    }
                  }}
                />
                <input
                  ref={folderInputRef}
                  type="file"
                  multiple
                  style={{ display: 'none' }}
                  {...({ webkitdirectory: 'true', directory: 'true' } as Record<string, string>)}
                  onChange={(event) => {
                    handleUpload(event.target.files).catch((err) => setStatus(t('上传失败: {{error}}', { error: String(err) })));
                    if (event.target) {
                      event.target.value = '';
                    }
                  }}
                />
                <div className="panel-search">
                  <input
                    className="input"
                    value={fileFilter}
                    onChange={(e) => setFileFilter(e.target.value)}
                    placeholder={t('搜索文件...')}
                  />
                </div>
                <div className="drag-hint muted">{t('拖拽文件：同级排序 / 跨文件夹移动')}</div>
                <div
                  className="file-tree-body"
                  ref={fileTreeRef}
                  onContextMenu={(event) => {
                    event.preventDefault();
                    const menuH = 380;
                    const menuW = 180;
                    const y = event.clientY + menuH > window.innerHeight ? Math.max(8, window.innerHeight - menuH - 8) : event.clientY;
                    const x = event.clientX + menuW > window.innerWidth ? Math.max(8, window.innerWidth - menuW - 8) : event.clientX;
                    setFileContextMenu({ x, y });
                  }}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragOverPath('');
                    setDragOverKind('');
                    if (draggingPath) {
                      updateDragHint(t('移动到 根目录'), event);
                    }
                  }}
                  onDrop={(event) => {
                    event.preventDefault();
                    if (event.dataTransfer.files && event.dataTransfer.files.length > 0) {
                      handleUpload(event.dataTransfer.files).catch((err) => setStatus(t('上传失败: {{error}}', { error: String(err) })));
                      return;
                    }
                    const from = event.dataTransfer.getData('text/plain');
                    if (from) {
                      if (fileFilter.trim()) {
                        setStatus(t('搜索过滤中无法拖拽移动。'));
                        return;
                      }
                      moveFileWithOrder(from, '').catch((err) => setStatus(t('移动失败: {{error}}', { error: String(err) })));
                    }
                    setDragHint(null);
                  }}
                >
                  {dragHint && draggingPath && (
                    <div className="drag-hint-overlay" style={{ left: dragHint.x, top: dragHint.y }}>
                      {dragHint.text}
                    </div>
                  )}
                  {inlineEdit && inlineEdit.kind !== 'rename' && inlineEdit.parent === '' && inlineInputRow(0)}
                  {renderTree(treeRoot.children)}
                </div>
                <div className="outline-panel">
                  <div className="outline-header" onClick={() => setOutlineCollapsed(!outlineCollapsed)} style={{ cursor: 'pointer' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" style={{ transform: outlineCollapsed ? 'rotate(-90deg)' : 'rotate(0)', transition: 'transform 0.2s ease' }}>
                        <path d="M2 3L5 6L8 3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                      </svg>
                      {t('Outline')}
                    </div>
                    <div className="muted">{mainFile || 'main.tex'}</div>
                  </div>
                  {!outlineCollapsed && (mainFile && mainFile.toLowerCase().endsWith('.tex') ? (
                    outlineItems.length > 0 ? (
                      <div className="outline-list">
                        {outlineItems.map((item, idx) => (
                          <button
                            key={`${item.pos}-${idx}`}
                            className={`outline-item level-${item.level}`}
                            onClick={() => {
                              const go = async () => {
                                if (mainFile && activePath !== mainFile) {
                                  await openFile(mainFile);
                                }
                                const view = cmViewRef.current;
                                if (!view) return;
                                const pos = Math.min(item.pos, view.state.doc.length);
                                view.dispatch({ selection: { anchor: pos, head: pos }, scrollIntoView: true });
                                view.focus();
                              };
                              go();
                            }}
                          >
                            <span className="outline-title">{item.title}</span>
                            <span className="outline-line">L{item.line}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <div className="muted outline-empty">{t('未发现 Section 标题。')}</div>
                    )
                  ) : (
                    <div className="muted outline-empty">{t('打开 .tex 文件以显示 Outline。')}</div>
                  ))}
                </div>
              </>
            ) : activeSidebar === 'collab' ? (
              <>
                <div className="panel-header">
                  <div>{t('协作')}</div>
                  <div className="panel-actions">
                    <div className="collab-status">
                      <span>{collabStatus === 'connected' ? t('已连接') : collabStatus === 'connecting' ? t('连接中...') : t('未连接')}</span>
                    </div>
                  </div>
                </div>
                <div className="collab-panel">
                  <div className="collab-row">
                    <input
                      className="input"
                      value={collabServer}
                      onChange={(e) => setCollabServerState(e.target.value)}
                      placeholder={t('协作服务器地址')}
                    />
                  </div>
                  <div className="collab-row">
                    <input
                      className="input"
                      value={collabName}
                      onChange={(e) => setCollabName(e.target.value)}
                      placeholder={t('显示名称')}
                    />
                    <button
                      className="ios-btn secondary"
                      onClick={() => setCollabEnabled((prev) => !prev)}
                      disabled={!activePath || !isTextPath(activePath)}
                    >
                      {collabEnabled ? t('断开') : t('连接')}
                    </button>
                  </div>
                  <div className="collab-row">
                    <button
                      className="ios-btn primary"
                      onClick={() => handleCreateInvite()}
                      disabled={collabInviteBusy || !projectId}
                    >
                      {collabInviteBusy ? t('生成中...') : t('生成邀请链接')}
                    </button>
                    <button
                      className="ios-btn secondary"
                      onClick={() => copyInviteLink()}
                      disabled={!collabInviteLink}
                    >
                      {t('复制')}
                    </button>
                  </div>
                  <div className="collab-row">
                    <input
                      className="input"
                      readOnly
                      value={collabInviteLink || ''}
                      placeholder={t('尚未生成邀请链接')}
                    />
                  </div>
                  <div className="collab-row">
                    <div className="muted">
                      {activePath ? t('当前文件: {{path}}', { path: activePath }) : t('未选择文件')}
                    </div>
                  </div>
                  <div className="collab-users">
                    {collabPeers.length === 0 ? (
                      <div className="muted">{t('暂无协作者在线')}</div>
                    ) : (
                      collabPeers.map((peer) => (
                        <div key={peer.id} className="collab-user">
                          <span className="dot" style={{ background: peer.color }} />
                          <span>{peer.name}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </>
            ) : activeSidebar === 'agent' ? (
              <>
                <div className="panel-header">
                  <div>{assistantMode === 'chat' ? t('Chat') : t('Agent')}</div>
                  <div className="panel-actions">
                    <div className="mode-toggle">
                      <button
                        className={`mode-btn ${assistantMode === 'chat' ? 'active' : ''}`}
                        onClick={() => setAssistantMode('chat')}
                      >
                        {t('Chat')}
                      </button>
                      <button
                        className={`mode-btn ${assistantMode === 'agent' ? 'active' : ''}`}
                        onClick={() => setAssistantMode('agent')}
                      >
                        {t('Agent')}
                      </button>
                    </div>
                  </div>
                </div>
                {assistantMode === 'chat' && (
                  <div className="context-tags">
                    <span className="context-tag">{t('只读当前文件')}</span>
                    {selectionText && <span className="context-tag">{t('只读选区')}</span>}
                    {compileLog && <span className="context-tag">{t('只读编译日志')}</span>}
                  </div>
                )}
                <div className="chat-messages">
                  {assistantMode === 'chat' && chatMessages.length === 0 && (
                    <div className="muted">{t('输入问题，进行只读对话。')}</div>
                  )}
                  {assistantMode === 'agent' && agentMessages.length === 0 && (
                    <div className="muted">{t('输入任务描述，生成修改建议。')}</div>
                  )}
                  {(assistantMode === 'chat' ? chatMessages : agentMessages).map((msg, idx) => (
                    <div key={idx} className={`chat-msg ${msg.role}`}>
                      <div className="role">{msg.role}</div>
                      <div className={`content ${msg.role === 'assistant' ? 'markdown-body' : ''}`}>
                        {msg.role === 'assistant' ? (
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
                        ) : (
                          msg.content
                        )}
                      </div>
                    </div>
                  ))}
                </div>
                <div className="chat-controls">
                  <div className="row">
                    {assistantMode === 'agent' ? (
                      <>
                        <div className="ios-select-wrapper">
                          <button
                            className="ios-select-trigger"
                            onClick={() => {
                              setTaskDropdownOpen(!taskDropdownOpen);
                              setModeDropdownOpen(false);
                            }}
                          >
                            <span>{DEFAULT_TASKS(t).find((item) => item.value === task)?.label || t('选择任务')}</span>
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={taskDropdownOpen ? 'rotate' : ''}>
                              <path d="M3 7L6 4L9 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                          </button>
                          {taskDropdownOpen && (
                            <div className="ios-dropdown">
                              {DEFAULT_TASKS(t).map((item) => (
                                <div
                                  key={item.value}
                                  className={`ios-dropdown-item ${task === item.value ? 'active' : ''}`}
                                  onClick={() => {
                                    setTask(item.value);
                                    setTaskDropdownOpen(false);
                                  }}
                                >
                                  {item.label}
                                  {task === item.value && (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                        <div style={{ position: 'relative', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
                          <div className="ios-select-wrapper">
                            <button
                              className="ios-select-trigger"
                              onClick={() => {
                                setModeDropdownOpen(!modeDropdownOpen);
                                setTaskDropdownOpen(false);
                              }}
                            >
                              <span>{mode === 'direct' ? t('Direct') : t('Tools')}</span>
                              <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={modeDropdownOpen ? 'rotate' : ''}>
                                <path d="M3 7L6 4L9 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                              </svg>
                            </button>
                            {modeDropdownOpen && (
                              <div className="ios-dropdown">
                                <div
                                  className={`ios-dropdown-item ${mode === 'direct' ? 'active' : ''}`}
                                  onClick={() => {
                                    setMode('direct');
                                    setModeDropdownOpen(false);
                                  }}
                                >
                                  {t('Direct')}
                                  {mode === 'direct' && (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </div>
                                <div
                                  className={`ios-dropdown-item ${mode === 'tools' ? 'active' : ''}`}
                                  onClick={() => {
                                    setMode('tools');
                                    setModeDropdownOpen(false);
                                  }}
                                >
                                  {t('Tools')}
                                  {mode === 'tools' && (
                                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                      <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                    </svg>
                                  )}
                                </div>
                              </div>
                            )}
                          </div>
                          <span className="info-icon">
                            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg">
                              <circle cx="8" cy="8" r="7" stroke="currentColor" strokeWidth="1.5" fill="none"/>
                              <path d="M8 7V11" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                              <circle cx="8" cy="5" r="0.5" fill="currentColor"/>
                            </svg>
                            <span className="tooltip">{t('Direct: 单轮生成 · Tools: 多轮工具调用/多文件修改')}</span>
                          </span>
                        </div>
                      </>
                    ) : (
                      <div className="muted">{t('Chat 模式仅对话，不会改动文件。')}</div>
                    )}
                  </div>
                  {assistantMode === 'agent' && task === 'translate' && (
                    <div className="row">
                      <div className="ios-select-wrapper">
                        <button
                          className="ios-select-trigger"
                          onClick={() => {
                            setTranslateScopeDropdownOpen(!translateScopeDropdownOpen);
                            setTranslateTargetDropdownOpen(false);
                          }}
                          >
                          <span>
                            {translateScope === 'selection' ? t('选区') : translateScope === 'file' ? t('当前文件') : t('整个项目')}
                          </span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={translateScopeDropdownOpen ? 'rotate' : ''}>
                            <path d="M3 7L6 4L9 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        {translateScopeDropdownOpen && (
                          <div className="ios-dropdown">
                            {[
                              { value: 'selection', label: t('选区') },
                              { value: 'file', label: t('当前文件') },
                              { value: 'project', label: t('整个项目') }
                            ].map((item) => (
                              <div
                                key={item.value}
                                className={`ios-dropdown-item ${translateScope === item.value ? 'active' : ''}`}
                                onClick={() => {
                                  setTranslateScope(item.value as 'selection' | 'file' | 'project');
                                  setTranslateScopeDropdownOpen(false);
                                }}
                              >
                                {item.label}
                                {translateScope === item.value && (
                                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                    <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                  </svg>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <div className="ios-select-wrapper">
                        <button
                          className="ios-select-trigger"
                          onClick={() => {
                            setTranslateTargetDropdownOpen(!translateTargetDropdownOpen);
                            setTranslateScopeDropdownOpen(false);
                          }}
                        >
                          <span>{translateTargetOptions.find((item) => item.value === translateTarget)?.label || translateTarget}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={translateTargetDropdownOpen ? 'rotate' : ''}>
                            <path d="M3 7L6 4L9 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        {translateTargetDropdownOpen && (
                          <div className="ios-dropdown">
                            {translateTargetOptions.map((lang) => (
                              <div
                                key={lang.value}
                                className={`ios-dropdown-item ${translateTarget === lang.value ? 'active' : ''}`}
                                onClick={() => {
                                  setTranslateTarget(lang.value);
                                  setTranslateTargetDropdownOpen(false);
                                }}
                              >
                                {lang.label}
                                {translateTarget === lang.value && (
                                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                                    <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                                  </svg>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                  )}
                  <textarea
                    className="chat-input"
                    value={prompt}
                    onChange={(e) => setPrompt(e.target.value)}
                    placeholder={assistantMode === 'chat' ? t('例如：帮我解释这一段的实验设计。') : t('例如：润色这个段落，使其更符合 ACL 风格。')}
                  />
                  <button onClick={sendPrompt} className="btn full">
                    {assistantMode === 'chat' ? t('发送') : t('生成建议')}
                  </button>
                  {selectionText && assistantMode === 'agent' && (
                    <div className="muted">{t('已选择 {{count}} 字符，将用于任务输入', { count: selectionText.length })}</div>
                  )}
                  {assistantMode === 'agent' && task === 'translate' && translateScope === 'selection' && !selectionText && (
                    <div className="muted">{t('翻译选区前请先选择文本。')}</div>
                  )}
                </div>
              </>
            ) : activeSidebar === 'vision' ? (
              <>
                <div className="panel-header">
                  <div>{t('图像识别')}</div>
                  <div className="panel-actions">
                    <button className="btn ghost" onClick={() => setVisionResult('')}>{t('清空结果')}</button>
                  </div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">{t('图像转 LaTeX')}</div>
                    <div className="field">
                      <label>{t('识别类型')}</label>
                      <div className="ios-select-wrapper">
                        <button className="ios-select-trigger" onClick={() => setVisionModeDropdownOpen(!visionModeDropdownOpen)}>
                          <span>{({'equation':t('公式'),'table':t('表格'),'figure':t('图像 + 图注'),'algorithm':t('算法'),'ocr':t('仅提取文字')} as Record<string,string>)[visionMode]}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={visionModeDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                        {visionModeDropdownOpen && (
                          <div className="ios-dropdown dropdown-down">
                            {([['equation',t('公式')],['table',t('表格')],['figure',t('图像 + 图注')],['algorithm',t('算法')],['ocr',t('仅提取文字')]] as [string,string][]).map(([val,lbl]) => (
                              <div key={val} className={`ios-dropdown-item ${visionMode === val ? 'active' : ''}`} onClick={() => { setVisionMode(val as 'equation'|'table'|'figure'|'algorithm'|'ocr'); setVisionResult(''); setVisionModeDropdownOpen(false); }}>
                                {lbl}
                                {visionMode === val && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="field">
                      <label>{t('上传图片')}</label>
                      <div
                        className={`image-drop-zone ${visionFile ? 'has-file' : ''}`}
                        onDragOver={(e) => { e.preventDefault(); e.currentTarget.classList.add('drag-over'); }}
                        onDragLeave={(e) => { e.currentTarget.classList.remove('drag-over'); }}
                        onDrop={(e) => {
                          e.preventDefault();
                          e.currentTarget.classList.remove('drag-over');
                          const file = e.dataTransfer.files?.[0];
                          if (file && file.type.startsWith('image/')) {
                            setVisionFile(file);
                            setVisionResult('');
                          }
                        }}
                        onPaste={(e) => {
                          const items = e.clipboardData?.items;
                          if (!items) return;
                          for (const item of items) {
                            if (item.type.startsWith('image/')) {
                              const file = item.getAsFile();
                              if (file) {
                                setVisionFile(file);
                                setVisionResult('');
                              }
                              break;
                            }
                          }
                        }}
                        tabIndex={0}
                      >
                        <input
                          type="file"
                          accept="image/*"
                          onChange={(e) => {
                            const file = e.target.files?.[0] || null;
                            setVisionFile(file);
                            setVisionResult('');
                          }}
                          style={{ display: 'none' }}
                          id="vision-file-input"
                        />
                        {visionFile ? (
                          <div className="drop-zone-preview">
                            <span className="file-name">{visionFile.name}</span>
                            <button className="remove-btn" onClick={(e) => { e.stopPropagation(); setVisionFile(null); setVisionPreviewUrl(''); }}>✕</button>
                          </div>
                        ) : (
                          <label htmlFor="vision-file-input" className="drop-zone-content">
                            <span className="drop-icon"><svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg></span>
                            <span className="drop-text">{t('点击选择、拖拽或粘贴图片')}</span>
                          </label>
                        )}
                      </div>
                    </div>
                    {visionPreviewUrl && (
                      <div className="vision-preview">
                        <img src={visionPreviewUrl} alt="preview" />
                      </div>
                    )}
                    <div className="field">
                      <label>{t('附加约束 (可选)')}</label>
                      <textarea
                        className="input"
                        value={visionPrompt}
                        onChange={(event) => setVisionPrompt(event.target.value)}
                        placeholder={t('例如：只输出 tabular，不要表格标题')}
                        rows={2}
                      />
                    </div>
                    <div className="vision-actions">
                      <button className="ios-btn secondary" onClick={handleVisionSubmit} disabled={visionBusy}>
                        {visionBusy ? t('识别中...') : t('开始识别')}
                      </button>
                      <button className="ios-btn primary" onClick={handleVisionInsert} disabled={!visionResult}>{t('插入到光标')}</button>
                    </div>
                    {visionResult && (
                      <div className="vision-result">
                        <div className="muted">{t('识别结果 (可编辑)：')}</div>
                        <textarea
                          className="input"
                          value={visionResult}
                          onChange={(event) => setVisionResult(event.target.value)}
                          rows={6}
                        />
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : activeSidebar === 'search' ? (
              <>
                <div className="panel-header">
                  <div>{t('论文检索')}</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">{t('arXiv 检索')}</div>
                    <div className="field">
                      <label>{t('关键词')}</label>
                      <input
                        className="input"
                        value={arxivQuery}
                        onChange={(event) => setArxivQuery(event.target.value)}
                        placeholder={t('例如: diffusion transformer compression')}
                      />
                    </div>
                    <div className="row">
                      <input
                        className="input small"
                        type="number"
                        min={1}
                        max={10}
                        value={arxivMaxResults}
                        onChange={(event) => setArxivMaxResults(Number(event.target.value) || 5)}
                      />
                      <button className="btn ghost" onClick={handleArxivSearch} disabled={arxivBusy}>
                        {arxivBusy ? t('检索中...') : useLlmSearch ? t('LLM 检索') : t('检索')}
                      </button>
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={useLlmSearch}
                        onChange={(event) => setUseLlmSearch(event.target.checked)}
                      />
                      {t('使用 Websearch 模型')}
                    </label>
                    {arxivStatus && <div className="muted">{arxivStatus}</div>}
                    {llmSearchOutput && (
                      <div className="vision-result">
                        <div className="muted">{t('LLM 原始输出')}</div>
                        <textarea
                          className="input"
                          value={llmSearchOutput}
                          onChange={(event) => setLlmSearchOutput(event.target.value)}
                          rows={5}
                        />
                      </div>
                    )}
                    {arxivResults.length > 0 && (
                      <div className="tool-list">
                        {arxivResults.map((paper) => (
                          <label key={paper.arxivId} className="tool-item">
                            <input
                              type="checkbox"
                              checked={Boolean(arxivSelected[paper.arxivId])}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setArxivSelected((prev) => ({ ...prev, [paper.arxivId]: checked }));
                              }}
                            />
                            <div>
                              <div className="tool-item-title">{paper.title}</div>
                              <div className="muted">{paper.authors?.join(', ') || t('Unknown authors')}</div>
                              <div className="muted">{paper.arxivId}</div>
                            </div>
                          </label>
                        ))}
                      </div>
                    )}
                    <div className="field">
                      <label>{t('Bib 文件')}</label>
                      <div className="ios-select-wrapper">
                        <button className="ios-select-trigger" onClick={() => setBibTargetDropdownOpen(!bibTargetDropdownOpen)}>
                          <span>{bibTarget || t('(新建/选择 Bib 文件)')}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={bibTargetDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                        {bibTargetDropdownOpen && (
                          <div className="ios-dropdown dropdown-down">
                            <div className={`ios-dropdown-item ${bibTarget === '' ? 'active' : ''}`} onClick={() => { setBibTarget(''); setBibTargetDropdownOpen(false); }}>
                              {t('(新建/选择 Bib 文件)')}
                              {bibTarget === '' && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                            </div>
                            {bibFiles.map((p) => (
                              <div key={p} className={`ios-dropdown-item ${bibTarget === p ? 'active' : ''}`} onClick={() => { setBibTarget(p); setBibTargetDropdownOpen(false); }}>
                                {p}
                                {bibTarget === p && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <button className="btn ghost" onClick={async () => {
                        const created = await createBibFile();
                        if (created) setBibTarget(created);
                      }}>{t('新建 Bib')}</button>
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={autoInsertCite}
                        onChange={(event) => setAutoInsertCite(event.target.checked)}
                      />
                      {t('自动插入引用到当前 TeX')}
                    </label>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={autoInsertToMain}
                        onChange={(event) => setAutoInsertToMain(event.target.checked)}
                      />
                      {t('AI 插入引用到指定 TeX')}
                    </label>
                    {autoInsertToMain && (
                      <div className="field">
                        <label>{t('引用插入目标')}</label>
                        <div className="ios-select-wrapper">
                          <button className="ios-select-trigger" onClick={() => setCiteTargetDropdownOpen(!citeTargetDropdownOpen)}>
                            <span>{citeTargetFile || texFiles[0] || 'main.tex'}</span>
                            <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={citeTargetDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                          </button>
                          {citeTargetDropdownOpen && (
                            <div className="ios-dropdown dropdown-down">
                              {texFiles.map((p) => (
                                <div key={p} className={`ios-dropdown-item ${citeTargetFile === p ? 'active' : ''}`} onClick={() => { setCiteTargetFile(p); setCiteTargetDropdownOpen(false); }}>
                                  {p}
                                  {citeTargetFile === p && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                    <div className="row">
                      <button className="btn" onClick={handleArxivApply} disabled={arxivBusy}>
                        {t('写入 Bib / 插入引用')}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : activeSidebar === 'websearch' ? (
              <>
                <div className="panel-header">
                  <div>{t('Websearch')}</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">{t('多点检索')}</div>
                    <div className="field">
                      <label>{t('Query')}</label>
                      <input
                        className="input"
                        value={websearchQuery}
                        onChange={(event) => setWebsearchQuery(event.target.value)}
                        placeholder={t('例如: diffusion editing for safety')}
                      />
                    </div>
                    <div className="row">
                      <button className="btn" onClick={runWebsearch} disabled={websearchBusy}>
                        {websearchBusy ? t('检索中...') : t('开始检索')}
                      </button>
                    </div>
                    <div className="websearch-log">
                      {websearchLog.length === 0 ? (
                        <div className="muted">{t('等待查询...')}</div>
                      ) : (
                        websearchLog.map((line, idx) => (
                          <div key={idx} className="websearch-line">{line}</div>
                        ))
                      )}
                    </div>
                    {websearchResults.length > 0 && (
                      <>
                        <div className="row">
                          <label className="checkbox-row">
                            <input
                              type="checkbox"
                              checked={websearchSelectedAll}
                              onChange={(event) => {
                                const checked = event.target.checked;
                                setWebsearchSelectedAll(checked);
                                const next: Record<string, boolean> = {};
                                websearchResults.forEach((item) => {
                                  next[item.id] = checked;
                                });
                                setWebsearchSelected(next);
                              }}
                            />
                            {t('全选')}
                          </label>
                          <button
                            className="btn ghost small"
                            onClick={() => {
                              const keys = websearchResults
                                .filter((item) => websearchSelected[item.id])
                                .map((item) => item.citeKey)
                                .filter(Boolean);
                              if (keys.length > 0) {
                                insertAtCursor(`\\cite{${keys.join(',')}}`);
                                appendLog(setWebsearchLog, t('已插入选中引用到光标。'));
                              }
                            }}
                          >
                            {t('插入选中引用')}
                          </button>
                        </div>
                        <div className="tool-list">
                          {websearchResults.map((paper) => (
                            <label key={paper.id} className="tool-item">
                              <input
                                type="checkbox"
                                checked={Boolean(websearchSelected[paper.id])}
                                onChange={(event) => {
                                  const checked = event.target.checked;
                                  setWebsearchSelected((prev) => ({ ...prev, [paper.id]: checked }));
                                }}
                              />
                              <div>
                                <div className="tool-item-title">{paper.title}</div>
                                {paper.summary && <div className="muted">{paper.summary}</div>}
                                {paper.url && <div className="muted">{paper.url}</div>}
                                {paper.citeKey && <div className="muted">{t('cite')}: {paper.citeKey}</div>}
                              </div>
                              <button
                                className="btn ghost small"
                                onClick={() => {
                                  if (paper.citeKey) {
                                    insertAtCursor(`\\cite{${paper.citeKey}}`);
                                    appendLog(setWebsearchLog, t('已插入: {{cite}}', { cite: paper.citeKey }));
                                  }
                                }}
                              >
                                {t('插入引用')}
                              </button>
                            </label>
                          ))}
                        </div>
                        <div className="vision-result">
                          <div className="muted">{t('逐条总结')}</div>
                          <div className="tool-list">
                            {websearchResults.map((paper) => (
                              <div key={paper.id} className="tool-item summary-item">
                                <div>
                                  <div className="tool-item-title">{paper.title}</div>
                                  {paper.citeKey && <div className="muted">{t('cite')}: {paper.citeKey}</div>}
                                </div>
                                <textarea
                                  className="input"
                                  value={websearchItemNotes[paper.id] ?? paper.summary ?? ''}
                                  onChange={(event) =>
                                    setWebsearchItemNotes((prev) => ({ ...prev, [paper.id]: event.target.value }))
                                  }
                                  rows={3}
                                />
                              </div>
                            ))}
                          </div>
                        </div>
                      </>
                    )}
                    {websearchParagraph && (
                      <div className="vision-result">
                        <div className="muted">{t('综合总结')}</div>
                        <textarea
                          className="input"
                          value={websearchParagraph}
                          onChange={(event) => setWebsearchParagraph(event.target.value)}
                          rows={6}
                        />
                      </div>
                    )}
                    <div className="field">
                      <label>{t('Bib 文件')}</label>
                      <div className="ios-select-wrapper">
                        <button className="ios-select-trigger" onClick={() => setWsBibDropdownOpen(!wsBibDropdownOpen)}>
                          <span>{websearchTargetBib || t('(新建/选择 Bib 文件)')}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={wsBibDropdownOpen ? 'rotate' : ''}><path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
                        </button>
                        {wsBibDropdownOpen && (
                          <div className="ios-dropdown dropdown-down">
                            <div className={`ios-dropdown-item ${!websearchTargetBib ? 'active' : ''}`} onClick={() => { setWebsearchTargetBib(''); setWsBibDropdownOpen(false); }}>
                              {t('(新建/选择 Bib 文件)')}
                              {!websearchTargetBib && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                            </div>
                            {bibFiles.map((p) => (
                              <div key={p} className={`ios-dropdown-item ${websearchTargetBib === p ? 'active' : ''}`} onClick={() => { setWebsearchTargetBib(p); setWsBibDropdownOpen(false); }}>
                                {p}
                                {websearchTargetBib === p && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                      <button className="btn ghost small" onClick={async () => {
                        const created = await createBibFile();
                        if (created) setWebsearchTargetBib(created);
                      }}>{t('新建 Bib')}</button>
                    </div>
                    <div className="field">
                      <label>{t('插入目标 TeX')}</label>
                      <div className="ios-select-wrapper">
                        <button className="ios-select-trigger" onClick={() => { setWsTexDropdownOpen(!wsTexDropdownOpen); setWsBibDropdownOpen(false); }}>
                          <span>{websearchTargetFile || '—'}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={wsTexDropdownOpen ? 'rotate' : ''}>
                            <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        {wsTexDropdownOpen && (
                          <div className="ios-dropdown dropdown-down">
                            {texFiles.map((p) => (
                              <div key={p} className={`ios-dropdown-item ${websearchTargetFile === p ? 'active' : ''}`} onClick={() => { setWebsearchTargetFile(p); setWsTexDropdownOpen(false); }}>
                                {p}
                                {websearchTargetFile === p && (
                                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="row">
                      <button className="btn" onClick={applyWebsearchInsert} disabled={websearchBusy}>
                        {t('一键写入 Bib + 插入总结')}
                      </button>
                    </div>
                  </div>
                </div>
              </>
            ) : activeSidebar === 'plot' ? (
              <>
                <div className="panel-header">
                  <div>{t('绘图')}</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">{t('表格 → 图表')}</div>
                    <div className="muted">{t('从选区表格生成图表（seaborn）')}</div>
                    <div className="field">
                      <label>{t('图表类型')}</label>
                      <div className="ios-select-wrapper">
                        <button className="ios-select-trigger" onClick={() => setPlotTypeDropdownOpen(!plotTypeDropdownOpen)}>
                          <span>{{ bar: t('Bar'), line: t('Line'), heatmap: t('Heatmap') }[plotType]}</span>
                          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={plotTypeDropdownOpen ? 'rotate' : ''}>
                            <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        </button>
                        {plotTypeDropdownOpen && (
                          <div className="ios-dropdown dropdown-down">
                            {([['bar', t('Bar')], ['line', t('Line')], ['heatmap', t('Heatmap')]] as [string, string][]).map(([val, label]) => (
                              <div key={val} className={`ios-dropdown-item ${plotType === val ? 'active' : ''}`} onClick={() => { setPlotType(val as 'bar' | 'line' | 'heatmap'); setPlotTypeDropdownOpen(false); }}>
                                {label}
                                {plotType === val && (
                                  <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                                )}
                              </div>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="field">
                      <label>{t('标题 (可选)')}</label>
                      <input
                        className="input"
                        value={plotTitle}
                        onChange={(event) => setPlotTitle(event.target.value)}
                        placeholder={t('Chart title')}
                      />
                    </div>
                    <div className="field">
                      <label>{t('文件名 (可选)')}</label>
                      <input
                        className="input"
                        value={plotFilename}
                        onChange={(event) => setPlotFilename(event.target.value)}
                        placeholder="plot.png"
                      />
                    </div>
                    <div className="field">
                      <label>{t('补充提示 (可选)')}</label>
                      <textarea
                        className="input"
                        value={plotPrompt}
                        onChange={(event) => setPlotPrompt(event.target.value)}
                        placeholder={t('例如：使用折线图，突出 Method A；加上 legend；设置 y 轴为 Accuracy')}
                        rows={2}
                      />
                    </div>
                    <div className="field">
                      <label>{t('Debug 重试次数')}</label>
                      <input
                        className="input"
                        type="number"
                        min={0}
                        max={5}
                        value={plotRetries}
                        onChange={(event) => setPlotRetries(Math.max(0, Math.min(5, Number(event.target.value) || 0)))}
                      />
                    </div>
                    <label className="checkbox-row">
                      <input
                        type="checkbox"
                        checked={plotAutoInsert}
                        onChange={(event) => setPlotAutoInsert(event.target.checked)}
                      />
                      {t('生成后插入 Figure')}
                    </label>
                    <div className="row">
                      <button className="btn" onClick={handlePlotGenerate} disabled={plotBusy}>
                        {plotBusy ? t('生成中...') : t('生成图表')}
                      </button>
                    </div>
                    {plotStatus && <div className="muted">{plotStatus}</div>}
                    {plotAssetPath && (
                      <div className="vision-result">
                        <div className="muted">{t('预览')}</div>
                        <img
                          src={`/api/projects/${projectId}/blob?path=${encodeURIComponent(plotAssetPath)}`}
                          alt={plotAssetPath}
                          style={{ width: '100%', borderRadius: '8px' }}
                        />
                        <div className="row">
                          <button className="btn ghost" onClick={() => insertFigureSnippet(plotAssetPath)}>{t('插入图模板')}</button>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </>
            ) : activeSidebar === 'review' ? (
              <>
                <div className="panel-header">
                  <div>{t('Review')}</div>
                </div>
                <div className="tools-body">
                  <div className="tool-section">
                    <div className="tool-title">{t('质量检查')}</div>
                    <div className="tool-desc">{t('AI 辅助检查论文质量，发现潜在问题')}</div>
                    <div className="review-buttons">
                      <button
                        className="review-btn"
                        onClick={async () => {
                          if (reviewReportBusy) return;
                          setReviewReportBusy(true);
                          setReviewReport(t('生成中...'));
                          setRightView('review');
                          try {
                            const res = await runAgent({
                              task: 'peer_review',
                              prompt: t('Read all .tex files in the project (start from the main file and any included sections). Use list_files and read_file tools to inspect content. Write a detailed reviewer-style report. Include: Summary, Strengths, Weaknesses, Questions, Missing Experiments, Writing/Clarity, Suggestions, Score (1-10), and Confidence. Output report text only; do not propose patches or code.'),
                              selection: '',
                              content: '',
                              mode: 'tools',
                              projectId,
                              activePath,
                              compileLog,
                              llmConfig,
                              interaction: 'agent',
                              history: []
                            });
                            setReviewReport(res.reply || t('无结果'));
                          } catch (err) {
                            setReviewReport(t('生成失败: {{error}}', { error: String(err) }));
                          } finally {
                            setReviewReportBusy(false);
                          }
                        }}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/></svg></span>
                        <span className="review-btn-label">{t('详细评审报告')}</span>
                        <span className="review-btn-desc">{t('阅读项目并输出完整审稿意见')}</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={async () => {
                          const res = await runAgent({
                            task: 'consistency_check',
                            prompt: t('Check terminology, notation, and consistency across the project. Return concise findings.'),
                            selection: '',
                            content: '',
                            mode: 'tools',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: t('一致性检查'), content: res.reply || t('无结果') }, ...prev]);
                          if (res.patches && res.patches.length > 0) {
                            const nextPending = res.patches.map((patch) => ({
                              filePath: patch.path,
                              original: files[patch.path] ?? '',
                              proposed: patch.content,
                              diff: patch.diff
                            }));
                            setPendingChanges(nextPending);
                            setRightView('diff');
                          }
                        }}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg></span>
                        <span className="review-btn-label">{t('一致性检查')}</span>
                        <span className="review-btn-desc">{t('检查术语、符号一致性')}</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={async () => {
                          const res = await runAgent({
                            task: 'missing_citations',
                            prompt: t('Find claims that likely need citations and list them.'),
                            selection: '',
                            content: '',
                            mode: 'tools',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: t('引用缺失'), content: res.reply || t('无结果') }, ...prev]);
                        }}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg></span>
                        <span className="review-btn-label">{t('引用缺失')}</span>
                        <span className="review-btn-desc">{t('查找需要引用的论述')}</span>
                      </button>
                      <button
                        className="review-btn"
                        onClick={async () => {
                          const res = await runAgent({
                            task: 'compile_summary',
                            prompt: t('Summarize compile log errors and suggested fixes.'),
                            selection: compileLog,
                            content: '',
                            mode: 'direct',
                            projectId,
                            activePath,
                            compileLog,
                            llmConfig,
                            interaction: 'agent',
                            history: []
                          });
                          setReviewNotes((prev) => [{ title: t('编译日志总结'), content: res.reply || t('无结果') }, ...prev]);
                        }}
                      >
                        <span className="review-btn-icon"><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/><polyline points="10 9 9 9 8 9"/></svg></span>
                        <span className="review-btn-label">{t('编译日志总结')}</span>
                        <span className="review-btn-desc">{t('总结错误并给出修复建议')}</span>
                      </button>
                    </div>
                  </div>
                  {reviewNotes.length > 0 && (
                    <div className="tool-section">
                      <div className="tool-title">{t('结果')}</div>
                      {reviewNotes.map((note, idx) => (
                        <div key={`${note.title}-${idx}`} className="review-item">
                          <div className="review-title">{note.title}</div>
                          <div className="review-content markdown-body">
                            <ReactMarkdown remarkPlugins={[remarkGfm]}>{note.content}</ReactMarkdown>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            ) : null}
          </aside>
        )}

        {sidebarOpen && (
          <div
            className="drag-handle vertical sidebar-handle"
            onMouseDown={(e) => startColumnDrag('left', e)}
          />
        )}

        <section className="panel editor-panel">
          <div className="panel-header">{t('Editor')}</div>
          <div className="breadcrumb-bar">
            <span className="breadcrumb-item">{projectName || t('Project')}</span>
            {breadcrumbParts.map((part, idx) => (
              <span key={`${part}-${idx}`} className="breadcrumb-item">{part}</span>
            ))}
            {currentHeading && (
              <span className="breadcrumb-item heading">{currentHeading.title}</span>
            )}
          </div>
          <div className="editor-toolbar">
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertSectionSnippet}>{t('Section')}</button>
              <button className="toolbar-btn" onClick={insertSubsectionSnippet}>{t('Subsection')}</button>
              <button className="toolbar-btn" onClick={insertSubsubsectionSnippet}>{t('Subsubsection')}</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertItemizeSnippet}>{t('Itemize')}</button>
              <button className="toolbar-btn" onClick={insertEnumerateSnippet}>{t('Enumerate')}</button>
              <button className="toolbar-btn" onClick={insertEquationSnippet}>{t('Equation')}</button>
              <button className="toolbar-btn" onClick={insertAlgorithmSnippet}>{t('Algorithm')}</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertFigureTemplate}>{t('Figure')}</button>
              <button className="toolbar-btn" onClick={insertTableSnippet}>{t('Table')}</button>
              <button className="toolbar-btn" onClick={insertListingSnippet}>{t('Listing')}</button>
            </div>
            <div className="toolbar-divider" />
            <div className="toolbar-group">
              <button className="toolbar-btn" onClick={insertCiteSnippet}>{t('Cite')}</button>
              <button className="toolbar-btn" onClick={insertRefSnippet}>{t('Ref')}</button>
              <button className="toolbar-btn" onClick={insertLabelSnippet}>{t('Label')}</button>
            </div>
            <div className="toolbar-spacer" />
            <div className="toolbar-group font-size-group">
              <button className="toolbar-btn icon-only" onClick={() => setEditorFontSize((s) => Math.max(8, s - 1))} title={t('放大')}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
              <span className="font-size-label">{editorFontSize}px</span>
              <button className="toolbar-btn icon-only" onClick={() => setEditorFontSize((s) => Math.min(24, s + 1))} title={t('放大')}>
                <svg width="14" height="14" viewBox="0 0 14 14" fill="none"><path d="M7 3v8M3 7h8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            </div>
          </div>
          <div
            className="editor-split"
            ref={editorSplitRef}
          >
            <div className="editor-area" ref={editorAreaRef}>
              <div ref={editorHostRef} className="editor-host" style={{ '--editor-font-size': `${editorFontSize}px` } as React.CSSProperties} />
              <div className="editor-hint muted">{t('快捷键: Option/Alt + / 或 Cmd/Ctrl + Space 补全；Cmd/Ctrl + / 注释；Cmd/Ctrl + F 搜索；Cmd/Ctrl + S 保存')}</div>
              {(inlineSuggestionText || isSuggesting) && suggestionPos && (
                <div
                  className={`suggestion-popover ${isSuggesting && !inlineSuggestionText ? 'loading' : ''}`}
                  style={{ left: suggestionPos.left, top: suggestionPos.top }}
                >
                  {isSuggesting && !inlineSuggestionText ? (
                    <div className="suggestion-loading">
                      <span className="spinner" />
                      {t('AI 补全中...')}
                    </div>
                  ) : (
                    <>
                      <div className="suggestion-preview">{inlineSuggestionText}</div>
                      <div className="row">
                        <button className="btn" onClick={() => acceptSuggestionRef.current()}>{t('接受')}</button>
                        <button className="btn ghost" onClick={() => clearSuggestionRef.current()}>{t('拒绝')}</button>
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          </div>
        </section>

        <div
          className="drag-handle vertical main-handle"
          onMouseDown={(e) => startColumnDrag('right', e)}
        />

        <section className="panel pdf-panel">
          <div className="panel-header">
            <div>{t('Preview')}</div>
            <div className="header-controls">
              <div className="ios-select-wrapper">
                <button
                  className="ios-select-trigger"
                  onClick={() => setRightViewDropdownOpen(!rightViewDropdownOpen)}
                >
                  <span>{RIGHT_VIEW_OPTIONS(t).find((item) => item.value === rightView)?.label || 'PDF'}</span>
                  <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={rightViewDropdownOpen ? 'rotate' : ''}>
                    <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                  </svg>
                </button>
                {rightViewDropdownOpen && (
                  <div className="ios-dropdown dropdown-down">
                    {RIGHT_VIEW_OPTIONS(t).map((item) => (
                      <div
                        key={item.value}
                        className={`ios-dropdown-item ${rightView === item.value ? 'active' : ''}`}
                        onClick={() => {
                          setRightView(item.value as 'pdf' | 'figures' | 'diff' | 'log' | 'toc' | 'review');
                          setRightViewDropdownOpen(false);
                        }}
                      >
                        {item.label}
                        {rightView === item.value && (
                          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                            <path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                          </svg>
                        )}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
          <div className="right-body">
            <div className="view-content">
              {rightView === 'pdf' && (
                <>
                  <div className="pdf-toolbar">
                    <div className="toolbar-group">
                      <button className="icon-btn" onClick={() => zoomPdf(-0.1)} disabled={!pdfUrl}>−</button>
                      <div className="zoom-label">{pdfScaleLabel}</div>
                      <button className="icon-btn" onClick={() => zoomPdf(0.1)} disabled={!pdfUrl}>＋</button>
                      <button className="btn ghost small" onClick={() => setPdfFitWidth(true)} disabled={!pdfUrl}>{t('适合宽度')}</button>
                      <button
                        className="btn ghost small"
                        onClick={() => {
                          setPdfFitWidth(false);
                          setPdfScale(1);
                        }}
                        disabled={!pdfUrl}
                      >
                        100%
                      </button>
                    </div>
                    <div className="toolbar-group">
                      <button className="btn ghost small" onClick={downloadPdf} disabled={!pdfUrl}>{t('下载 PDF')}</button>
                      <button
                        className={`btn ghost small ${pdfSpread ? 'active' : ''}`}
                        onClick={() => setPdfSpread((prev) => !prev)}
                        disabled={!pdfUrl}
                      >
                        {t('双页')}
                      </button>
                      <button
                        className={`btn ghost small ${pdfAnnotateMode ? 'active' : ''}`}
                        onClick={() => setPdfAnnotateMode((prev) => !prev)}
                        disabled={!pdfUrl}
                      >
                        {t('注释')}
                      </button>
                    </div>
                  </div>
                  {pdfUrl ? (
                    <PdfPreview
                      pdfUrl={pdfUrl}
                      scale={pdfScale}
                      fitWidth={pdfFitWidth}
                      spread={pdfSpread}
                      onFitScale={handleFitScale}
                      onOutline={handlePdfOutline}
                      annotations={pdfAnnotations}
                      annotateMode={pdfAnnotateMode}
                      onAddAnnotation={addPdfAnnotation}
                      containerRef={pdfContainerRef}
                      onTextClick={(text) => {
                        const view = cmViewRef.current;
                        if (!view) return;
                        const docText = view.state.doc.toString();
                        const needle = text.replace(/\s+/g, ' ').trim();
                        if (!needle) return;
                        const idx = docText.indexOf(needle);
                        if (idx >= 0) {
                          view.dispatch({
                            selection: { anchor: idx, head: idx + needle.length },
                            scrollIntoView: true
                          });
                          view.focus();
                        }
                      }}
                    />
                  ) : (
                    <div className="muted pdf-empty-message">{t('尚未生成 PDF')}</div>
                  )}
                  {pdfAnnotations.length > 0 && (
                    <div className="pdf-annotations">
                      <div className="muted">{t('注释')}</div>
                      <div className="annotation-list">
                        {pdfAnnotations.map((note) => (
                          <div key={note.id} className="annotation-item">
                            <button
                              className="annotation-link"
                              onClick={() => scrollToPdfPage(note.page)}
                            >
                              P{note.page}
                            </button>
                            <div className="annotation-text">{note.text}</div>
                            <button
                              className="annotation-remove"
                              onClick={() =>
                                setPdfAnnotations((prev) => prev.filter((item) => item.id !== note.id))
                              }
                            >
                              ✕
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </>
              )}
              {rightView === 'toc' && (
                <div className="toc-panel">
                  <div className="toc-title">{t('目录')}</div>
                  {pdfOutline.length === 0 ? (
                    <div className="muted">{t('暂无目录信息。')}</div>
                  ) : (
                    <div className="toc-list">
                      {pdfOutline.map((item, idx) => (
                        <button
                          key={`${item.title}-${idx}`}
                          className={`toc-item level-${item.level}`}
                          onClick={() => {
                            if (item.page) {
                              setRightView('pdf');
                              scrollToPdfPage(item.page);
                            }
                          }}
                        >
                          <span className="toc-title-text">{item.title}</span>
                          {item.page && <span className="toc-page">P{item.page}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              {rightView === 'figures' && (
                <div className="figure-panel-v2">
                  <div className="figure-topbar">
                    <div className="ios-select-wrapper" style={{ flex: 1 }}>
                      <button className="ios-select-trigger" onClick={() => setFigureDropdownOpen(!figureDropdownOpen)}>
                        <span>{selectedFigure || t('选择图片进行预览。')}</span>
                        <svg width="12" height="12" viewBox="0 0 12 12" fill="none" className={figureDropdownOpen ? 'rotate' : ''}>
                          <path d="M3 5L6 8L9 5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/>
                        </svg>
                      </button>
                      {figureDropdownOpen && (
                        <div className="ios-dropdown dropdown-down">
                          {figureFiles.map((item) => (
                            <div key={item.path} className={`ios-dropdown-item ${selectedFigure === item.path ? 'active' : ''}`} onClick={() => { setSelectedFigure(item.path); setFigureDropdownOpen(false); }}>
                              {item.path}
                              {selectedFigure === item.path && (
                                <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
                              )}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                    {selectedFigure && (
                      <button
                        className="figure-insert-btn"
                        onClick={() => insertFigureSnippet(selectedFigure)}
                      >
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12 5v14"/><path d="M5 12h14"/></svg>
                        {t('插入到光标')}
                      </button>
                    )}
                  </div>
                  <div className="figure-display">
                    {selectedFigure ? (
                      selectedFigure.toLowerCase().endsWith('.pdf') ? (
                        <object data={`/api/projects/${projectId}/blob?path=${encodeURIComponent(selectedFigure)}`} type="application/pdf" />
                      ) : (
                        <img src={`/api/projects/${projectId}/blob?path=${encodeURIComponent(selectedFigure)}`} alt={selectedFigure} />
                      )
                    ) : (
                      <div className="figure-empty">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
                        <span>{t('选择图片进行预览。')}</span>
                      </div>
                    )}
                  </div>
                </div>
              )}
              {rightView === 'diff' && (
                <div className="diff-panel">
                  <div className="diff-title">{t('Diff Preview ({{count}})', { count: pendingGrouped.length })}</div>
                  {pendingGrouped.length === 0 && <div className="muted">{t('暂无待确认修改。')}</div>}
                  {pendingGrouped.map((change) => (
                    (() => {
                      const rows = buildSplitDiff(change.original, change.proposed);
                      return (
                        <div key={change.filePath} className="diff-item">
                          <div className="diff-header">
                            <div className="diff-path">{change.filePath}</div>
                            <button className="btn ghost" onClick={() => setDiffFocus(change)}>{t('放大')}</button>
                          </div>
                          <SplitDiffView rows={rows} />
                          <div className="row">
                            <button className="btn" onClick={() => applyPending(change)}>{t('应用此修改')}</button>
                            <button className="btn ghost" onClick={() => discardPending(change)}>{t('放弃')}</button>
                          </div>
                        </div>
                      );
                    })()
                  ))}
                  {pendingGrouped.length > 1 && (
                    <div className="row">
                      <button className="btn" onClick={() => applyPending()}>{t('应用全部')}</button>
                      <button className="btn ghost" onClick={() => discardPending()}>{t('全部放弃')}</button>
                    </div>
                  )}
                </div>
              )}
              {rightView === 'log' && (
                <div className="log-panel">
                  <div className="log-title">
                    {t('Compile Log')}
                    <button className="btn ghost log-action" onClick={diagnoseCompile} disabled={diagnoseBusy}>
                      {diagnoseBusy ? (
                        <span className="suggestion-loading">
                          <span className="spinner" />
                          {t('诊断中...')}
                        </span>
                      ) : (
                        t('一键诊断')
                      )}
                    </button>
                  </div>
                  {compileErrors.length > 0 && (
                    <div className="log-errors">
                      {compileErrors.map((error, idx) => (
                        <button
                          key={`${error.message}-${idx}`}
                          className="error-item"
                          onClick={() => jumpToError(error)}
                        >
                          <span className="error-tag">!</span>
                          <span className="error-text">{error.message}</span>
                          {error.line && <span className="error-line">L{error.line}</span>}
                        </button>
                      ))}
                    </div>
                  )}
                  <pre className="log-content">{compileLog || t('暂无编译日志')}</pre>
                </div>
              )}
              {rightView === 'review' && (
                <div className="log-panel">
                  <div className="log-title">{t('评审报告')}</div>
                  <div className="log-content markdown-body">
                    {reviewReport ? (
                      <ReactMarkdown remarkPlugins={[remarkGfm]}>{reviewReport}</ReactMarkdown>
                    ) : (
                      t('暂无评审报告')
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      {/* Top-bar dropdown portals — rendered outside top-bar to escape backdrop-filter stacking context */}
      {(mainFileDropdownOpen || engineDropdownOpen || langDropdownOpen) && (
        <div className="topbar-dropdown-backdrop" onClick={() => { setMainFileDropdownOpen(false); setEngineDropdownOpen(false); setLangDropdownOpen(false); }} />
      )}
      {mainFileDropdownOpen && topBarDropdownRect && (
        <div className="ios-dropdown dropdown-fixed" style={{ top: topBarDropdownRect.top, left: topBarDropdownRect.left, minWidth: topBarDropdownRect.width }}>
          {(texFiles.length > 0 ? texFiles : ['main.tex']).map((p) => (
            <div key={p} className={`ios-dropdown-item ${mainFile === p ? 'active' : ''}`} onClick={() => { setMainFile(p); setMainFileDropdownOpen(false); }}>
              {p}
              {mainFile === p && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
          ))}
        </div>
      )}
      {engineDropdownOpen && topBarDropdownRect && (
        <div className="ios-dropdown dropdown-fixed" style={{ top: topBarDropdownRect.top, left: topBarDropdownRect.left, minWidth: topBarDropdownRect.width }}>
          {([['pdflatex','pdfLaTeX'],['xelatex','XeLaTeX'],['lualatex','LuaLaTeX'],['latexmk','Latexmk'],['tectonic','Tectonic']] as [string,string][]).map(([val, lbl]) => (
            <div key={val} className={`ios-dropdown-item ${compileEngine === val ? 'active' : ''}`} onClick={() => { setSettings((prev) => ({ ...prev, compileEngine: val as CompileEngine })); setEngineDropdownOpen(false); }}>
              {lbl}
              {compileEngine === val && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
          ))}
        </div>
      )}
      {langDropdownOpen && topBarDropdownRect && (
        <div className="ios-dropdown dropdown-fixed" style={{ top: topBarDropdownRect.top, left: topBarDropdownRect.left, minWidth: topBarDropdownRect.width }}>
          {[['zh-CN', t('中文')], ['en-US', t('English')]].map(([val, lbl]) => (
            <div key={val} className={`ios-dropdown-item ${i18n.language === val ? 'active' : ''}`} onClick={() => { i18n.changeLanguage(val); setLangDropdownOpen(false); }}>
              {lbl}
              {i18n.language === val && <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3 8L6.5 11.5L13 5" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>}
            </div>
          ))}
        </div>
      )}

      {fileContextMenu && (
        <div className="ctx-menu-backdrop" onClick={() => setFileContextMenu(null)} onContextMenu={(e) => { e.preventDefault(); setFileContextMenu(null); }}>
          <div className="ctx-menu" style={{ left: fileContextMenu.x, top: fileContextMenu.y }} onClick={(e) => e.stopPropagation()}>
            <div className="ctx-menu-group">{t('创建')}</div>
            <button className="ctx-menu-item" onClick={() => { beginInlineCreate('new-file'); setFileContextMenu(null); }}>{t('新建文件')}</button>
            <button className="ctx-menu-item" onClick={() => { beginInlineCreate('new-folder'); setFileContextMenu(null); }}>{t('新建文件夹')}</button>
            <button className="ctx-menu-item" onClick={() => { createBibFile(); setFileContextMenu(null); }}>{t('新建 Bib')}</button>
            <div className="ctx-menu-sep" />
            <div className="ctx-menu-group">{t('上传')}</div>
            <button className="ctx-menu-item" onClick={() => { fileInputRef.current?.click(); setFileContextMenu(null); }}>{t('上传文件')}</button>
            <button className="ctx-menu-item" onClick={() => { folderInputRef.current?.click(); setFileContextMenu(null); }}>{t('上传文件夹')}</button>
            <div className="ctx-menu-sep" />
            <button className="ctx-menu-item" onClick={() => { setAllFolders(true); setFileContextMenu(null); }}>{t('展开全部')}</button>
            <button className="ctx-menu-item" onClick={() => { setAllFolders(false); setFileContextMenu(null); }}>{t('收起全部')}</button>
            <button className="ctx-menu-item" onClick={() => { beginInlineRename(); setFileContextMenu(null); }}>{t('重命名')}</button>
            <button className="ctx-menu-item" onClick={() => { refreshTree(); setFileContextMenu(null); }}>{t('刷新')}</button>
          </div>
        </div>
      )}
      {settingsOpen && (
        <div className="modal-backdrop" onClick={() => setSettingsOpen(false)}>
          <div className="modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('Workspace Settings')}</div>
              <button className="icon-btn" onClick={() => setSettingsOpen(false)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="field">
                <label>{t('LLM Endpoint')}</label>
                <input
                  className="input"
                  value={llmEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmEndpoint: e.target.value }))}
                  placeholder="https://api.openai.com/v1/chat/completions"
                />
                <div className="muted">{t('支持 OpenAI 兼容的 base_url，例如 https://api.apiyi.com/v1')}</div>
              </div>
              <div className="field">
                <label>{t('LLM Model')}</label>
                <input
                  className="input"
                  value={llmModel}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmModel: e.target.value }))}
                  placeholder="gpt-4o-mini"
                />
              </div>
              <div className="field">
                <label>{t('LLM API Key')}</label>
                <input
                  className="input"
                  value={llmApiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, llmApiKey: e.target.value }))}
                  placeholder="sk-..."
                  type="password"
                />
                {!llmApiKey && (
                  <div className="muted">{t('未配置 API Key 时将使用后端环境变量。')}</div>
                )}
              </div>
              <div className="field">
                <label>{t('Search LLM Endpoint (可选)')}</label>
                <input
                  className="input"
                  value={searchEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, searchEndpoint: e.target.value }))}
                  placeholder="https://api.apiyi.com/v1"
                />
                <div className="muted">{t('仅用于“检索/websearch”任务，留空则复用 LLM Endpoint。')}</div>
              </div>
              <div className="field">
                <label>{t('Search LLM Model (可选)')}</label>
                <input
                  className="input"
                  value={searchModel}
                  onChange={(e) => setSettings((prev) => ({ ...prev, searchModel: e.target.value }))}
                  placeholder="claude-sonnet-4-5-20250929-all"
                />
              </div>
              <div className="field">
                <label>{t('Search LLM API Key (可选)')}</label>
                <input
                  className="input"
                  value={searchApiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, searchApiKey: e.target.value }))}
                  placeholder="sk-..."
                  type="password"
                />
              </div>
              <div className="field">
                <label>{t('VLM Endpoint (可选)')}</label>
                <input
                  className="input"
                  value={visionEndpoint}
                  onChange={(e) => setSettings((prev) => ({ ...prev, visionEndpoint: e.target.value }))}
                  placeholder="https://api.apiyi.com/v1"
                />
                <div className="muted">{t('仅用于图像识别，留空则复用 LLM Endpoint。')}</div>
              </div>
              <div className="field">
                <label>{t('VLM Model (可选)')}</label>
                <input
                  className="input"
                  value={visionModel}
                  onChange={(e) => setSettings((prev) => ({ ...prev, visionModel: e.target.value }))}
                  placeholder="gpt-4o"
                />
              </div>
              <div className="field">
                <label>{t('VLM API Key (可选)')}</label>
                <input
                  className="input"
                  value={visionApiKey}
                  onChange={(e) => setSettings((prev) => ({ ...prev, visionApiKey: e.target.value }))}
                  placeholder="sk-..."
                  type="password"
                />
              </div>
            </div>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setSettingsOpen(false)}>{t('关闭')}</button>
              <button className="btn" onClick={() => setSettingsOpen(false)}>{t('完成')}</button>
            </div>
          </div>
        </div>
      )}
      {diffFocus && (
        <div className="modal-backdrop" onClick={() => setDiffFocus(null)}>
          <div className="modal diff-modal" onClick={(event) => event.stopPropagation()}>
            <div className="modal-header">
              <div>{t('Diff')} · {diffFocus.filePath}</div>
              <button className="icon-btn" onClick={() => setDiffFocus(null)}>✕</button>
            </div>
            <div className="modal-body diff-modal-body">
              <SplitDiffView rows={buildSplitDiff(diffFocus.original, diffFocus.proposed)} />
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
