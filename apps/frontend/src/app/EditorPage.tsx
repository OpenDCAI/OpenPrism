import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, Dispatch, MouseEvent, SetStateAction, RefObject, MutableRefObject, DragEvent, KeyboardEvent as ReactKeyboardEvent } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { basicSetup } from 'codemirror';
import { latex, latexCompletionSource as packageCompletionSource } from 'codemirror-lang-latex';
import { forceLinting, linter } from '@codemirror/lint';
import { buildProjectIndex, projectCompletionSource, projectReferenceLinter, type ProjectIndex } from '../latex/projectIndex';
import { Compartment, EditorState, Prec, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, DecorationSet, WidgetType, keymap, gutter, GutterMarker } from '@codemirror/view';
import { search, searchKeymap } from '@codemirror/search';
import { autocompletion } from '@codemirror/autocomplete';
import { toggleComment } from '@codemirror/commands';
import { foldKeymap, foldService, indentOnInput, HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { tags as hlTags } from '@lezer/highlight';
import { GlobalWorkerOptions, getDocument, renderTextLayer } from 'pdfjs-dist';
import pdfWorker from 'pdfjs-dist/build/pdf.worker.min?url';
import 'pdfjs-dist/web/pdf_viewer.css';
import {
  arxivBibtex,
  arxivSearch,
  createFolder as createFolderApi,
  compileProject,
  getAllFiles,
  getCollabServer,
  getFile,
  cancelJob,
  createCommentThread,
  deleteComment,
  deleteThread,
  editComment,
  listComments,
  replyToThread,
  setThreadResolved,
  jobProgress,
  getProjectTree,
  fetchVersionPdf,
  restoreVersion,
  restoreVersionFile,
  getWorkspaceLlm,
  getCollabToken,
  blobUrl,
  listProjects,
  renamePath,
  deleteFile,
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
import type { ArxivPaper, CommentThreadMeta, PdfFocus, RestoreVersionResult } from '../api/client';
import { getInviteToken, tokenForUrl } from '../api/auth';
import { createTwoFilesPatch } from 'diff';
import { merge3 } from './merge3';
import { SplitDiffView, buildSplitDiff } from './SplitDiff';
import type { CompileOutcome } from '../latex/engine';
import * as Y from 'yjs';
import { Awareness } from 'y-protocols/awareness';
import { yCollab } from 'y-codemirror.next';
import { CollabProvider } from '../collab/provider';
import ZoteroPanel from './ZoteroPanel';
import VersionsPanel from './VersionsPanel';
import { parseCompileErrors } from './compileLog';
import type { CompileError } from './compileLog';
import AiCommandBar from './AiCommandBar';
import InviteLinks from './InviteLinks';
import CommentsPanel from './CommentsPanel';
import type { PendingComment } from './CommentsPanel';
import { contextOf, locate } from './commentAnchor';
import { commentClicks, commentMarksField, setCommentMarks } from './commentMarks';
import {
  AppTopBar,
  Avatar,
  Badge,
  Button,
  CrumbSep,
  EmptyState,
  FieldError,
  Icon,
  IconButton,
  Menu,
  MenuButton,
  Modal,
  PanelHeader,
  SegmentedControl,
  Select
} from '@design';
import type { IconName, MenuEntry, SegmentOption } from '@design';
import './editor-shell.css';
import { dropLegacyLlmDefaults } from './llmDefaults';

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
  /** Set when the file changed after this was proposed and the change no longer applies cleanly. */
  stale?: boolean;
}

/** The smallest single replacement that turns `a` into `b` (common prefix and suffix kept), as one editor transaction. */
function minimalChange(a: string, b: string) {
  let start = 0;
  const max = Math.min(a.length, b.length);
  while (start < max && a.charCodeAt(start) === b.charCodeAt(start)) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a.charCodeAt(endA - 1) === b.charCodeAt(endB - 1)) { endA--; endB--; }
  return { from: start, to: endA, insert: b.slice(start, endB) };
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

type LeftView = 'files' | 'outline' | 'search';
type RightTool = 'agent' | 'vision' | 'search' | 'zotero' | 'versions' | 'comments' | 'websearch' | 'plot' | 'review' | 'collab';
type ViewMode = 'editor' | 'split' | 'pdf';

const EDITOR_LAYOUT_KEY = 'openprism-editor-layout-v1';
const NARROW_RIGHT_QUERY = '(max-width: 1279px)';
const NARROW_LEFT_QUERY = '(max-width: 767px)';
/** [min, max, default] widths in px for the side panels. */
const PANEL_LIMITS: Record<'left' | 'right', [number, number, number]> = {
  left: [200, 480, 264],
  right: [280, 560, 380]
};

interface EditorLayout {
  leftOpen: boolean;
  leftView: LeftView;
  leftWidth: number;
  rightOpen: boolean;
  rightTool: RightTool;
  rightWidth: number;
  /** Editor share of the centre area when split (0.2–0.8). */
  split: number;
  viewMode: ViewMode;
}

function loadEditorLayout(): EditorLayout {
  const fallback: EditorLayout = {
    leftOpen: true,
    leftView: 'files',
    leftWidth: PANEL_LIMITS.left[2],
    rightOpen: true,
    rightTool: 'agent',
    rightWidth: PANEL_LIMITS.right[2],
    split: 0.5,
    viewMode: 'split'
  };
  let layout = fallback;
  try {
    const raw = window.localStorage.getItem(EDITOR_LAYOUT_KEY);
    if (raw) layout = { ...fallback, ...(JSON.parse(raw) as Partial<EditorLayout>) };
  } catch {
    layout = fallback;
  }
  if (window.matchMedia(NARROW_RIGHT_QUERY).matches) layout.rightOpen = false;
  if (window.matchMedia(NARROW_LEFT_QUERY).matches) {
    layout.leftOpen = false;
    if (layout.viewMode === 'split') layout.viewMode = 'editor';
  }
  return layout;
}

function saveEditorLayout(layout: EditorLayout) {
  try {
    window.localStorage.setItem(EDITOR_LAYOUT_KEY, JSON.stringify(layout));
  } catch {
    /* storage unavailable */
  }
}

function fileIconName(path: string): IconName {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tex') || lower.endsWith('.cls') || lower.endsWith('.sty')) return 'file-text';
  if (lower.endsWith('.bib')) return 'book';
  if (/\.(png|jpe?g|gif|svg|pdf|eps|webp)$/.test(lower)) return 'file-image';
  return 'file';
}

function fileIconClass(path: string) {
  const lower = path.toLowerCase();
  if (lower.endsWith('.tex') || lower.endsWith('.cls') || lower.endsWith('.sty')) return 'ft-tex';
  if (lower.endsWith('.bib')) return 'ft-bib';
  if (/\.(png|jpe?g|gif|svg|pdf|eps|webp)$/.test(lower)) return 'ft-img';
  return 'ft-other';
}

const SETTINGS_KEY = 'openprism-settings-v1';
const DEFAULT_SETTINGS: AppSettings = {
  llmEndpoint: '',
  llmApiKey: '',
  llmModel: '',
  searchEndpoint: '',
  searchApiKey: '',
  searchModel: '',
  visionEndpoint: '',
  visionApiKey: '',
  visionModel: '',
  compileEngine: 'pdflatex'
};

const COLLAB_NAME_KEY = 'openprism-collab-name';
const COLLAB_COLORS = ['#b0442a', '#2f6fb4', '#2f9b74', '#b48a2f', '#6b2fb4', '#b42f6d', '#2f8fb4'];

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
    return dropLegacyLlmDefaults({
      ...DEFAULT_SETTINGS,
      ...parsed,
      compileEngine
    });
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

// A file that can be compiled on its own (as opposed to a section pulled in with \input).
function isRootDocument(text: string) {
  return /^[ \t]*\\documentclass\b/m.test(text);
}

const mainFileKey = (projectId: string) => `openprism-main-file:${projectId}`;

// What fontspec prints under pdfLaTeX: "requires either XeTeX or\n(fontspec)   LuaTeX."
const NEEDS_UNICODE_ENGINE = /requires either XeTeX or[\s\S]{0,60}LuaTeX/i;

/** One compile result per target, so switching files shows that file's own PDF and log. */
interface CompiledView { url: string; log: string; engine: string }

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

type Directive = { kind: 'include' | 'graphic' | 'graphicspath'; raw: string; pos: number };

/** \input / \include / \includegraphics / \graphicspath in source order (comments ignored). */
function scanDirectives(text: string): Directive[] {
  const out: Directive[] = [];
  let offset = 0;
  for (const line of text.split(/\r?\n/)) {
    const clean = stripLineComment(line);
    const regex = /\\(input|include|includegraphics|graphicspath)\*?\b\s*(?:\[[^\]]*\])?\s*\{((?:[^{}]|\{[^{}]*\})*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(clean))) {
      const kind = match[1] === 'input' || match[1] === 'include' ? 'include' : match[1] === 'graphicspath' ? 'graphicspath' : 'graphic';
      out.push({ kind, raw: match[2].trim(), pos: offset + match.index });
    }
    offset += line.length + 1;
  }
  return out;
}

function resolveTexPath(raw: string, from: string, known: Set<string>) {
  let name = raw.replace(/^\.\//, '').replace(/^\//, '');
  if (!name) return null;
  if (!name.toLowerCase().endsWith('.tex')) name = `${name}.tex`;
  const base = getParentPath(from);
  // LaTeX resolves against the compile directory (the project root); fall back to the including file's folder.
  for (const candidate of [name, base ? `${base}/${name}` : name]) {
    if (known.has(candidate)) return candidate;
  }
  return null;
}

function resolveFigurePath(raw: string, dirs: string[], known: Set<string>) {
  const name = raw.replace(/^\.\//, '');
  for (const dir of ['', ...dirs]) {
    const base = dir ? `${dir.replace(/^\.\//, '').replace(/\/+$/, '')}/${name}` : name;
    for (const ext of ['', ...FIGURE_EXTS]) {
      if (known.has(base + ext) && isFigureFile(base + ext)) return base + ext;
    }
  }
  return null;
}

interface DocumentTree {
  tex: string; // the .tex file this describes (the one being edited)
  root: string; // the document that gets compiled for it
  outline: (OutlineItem & { file: string })[];
  figures: string[];
}

/** Headings and figures of one .tex file, with its \input / \include files expanded in place. */
async function buildDocumentTree(
  tex: string,
  readText: (path: string) => Promise<string | undefined>,
  known: Set<string>
) {
  const outline: DocumentTree['outline'] = [];
  const graphics: string[] = [];
  const dirs: string[] = [];
  const files: string[] = [];
  const seen = new Set<string>();
  const visit = async (file: string, depth: number) => {
    if (seen.has(file) || depth > 6) return;
    seen.add(file);
    files.push(file);
    const text = await readText(file);
    if (text === undefined) return;
    const events: { pos: number; heading?: OutlineItem; directive?: Directive }[] = [
      ...parseOutline(text).map((heading) => ({ pos: heading.pos, heading })),
      ...scanDirectives(text).map((directive) => ({ pos: directive.pos, directive }))
    ].sort((a, b) => a.pos - b.pos);
    for (const event of events) {
      if (event.heading) {
        outline.push({ ...event.heading, file });
      } else if (event.directive?.kind === 'include') {
        const target = resolveTexPath(event.directive.raw, file, known);
        if (target) await visit(target, depth + 1);
      } else if (event.directive?.kind === 'graphic') {
        graphics.push(event.directive.raw);
      } else if (event.directive?.kind === 'graphicspath') {
        for (const m of event.directive.raw.matchAll(/\{([^{}]*)\}/g)) dirs.push(m[1]);
      }
    }
  };
  await visit(tex, 0);
  const figures: string[] = [];
  for (const raw of graphics) {
    const found = resolveFigurePath(raw, dirs, known);
    if (found && !figures.includes(found)) figures.push(found);
  }
  return { outline, figures, files };
}

/** The PDF's own bookmarks, flattened, with the page each points to. */
async function readPdfOutline(pdf: any, untitled: string) {
  const items: { title: string; page?: number; level: number }[] = [];
  const walk = async (entries: any[] | null, level: number) => {
    for (const entry of entries ?? []) {
      let page: number | undefined;
      try {
        const dest = typeof entry.dest === 'string' ? await pdf.getDestination(entry.dest) : entry.dest;
        if (Array.isArray(dest) && dest.length > 0) page = (await pdf.getPageIndex(dest[0])) + 1;
      } catch {
        page = undefined;
      }
      items.push({ title: entry.title || untitled, page, level });
      if (entry.items?.length) await walk(entry.items, level + 1);
    }
  };
  await walk(await pdf.getOutline(), 1);
  return items;
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

/* ── LaTeX environment scope colorization ── */
const SCOPE_COLORS = [
  'rgba(180, 74, 47, 0.5)',
  'rgba(59, 130, 186, 0.5)',
  'rgba(76, 159, 88, 0.5)',
  'rgba(180, 137, 47, 0.5)',
  'rgba(142, 68, 173, 0.5)',
  'rgba(211, 84, 0, 0.5)',
];

function computeEnvDepths(doc: { lines: number; line: (n: number) => { text: string } }): number[] {
  const depths: number[] = [];
  let depth = 0;
  for (let i = 1; i <= doc.lines; i++) {
    const clean = stripLatexComment(doc.line(i).text);
    ENV_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    const events: { pos: number; delta: number }[] = [];
    while ((match = ENV_RE.exec(clean)) !== null) {
      events.push({ pos: match.index, delta: match[1] === 'begin' ? 1 : -1 });
    }
    events.sort((a, b) => a.pos - b.pos);
    let lineDepth = depth;
    for (const ev of events) {
      if (ev.delta < 0) { depth--; lineDepth = Math.min(lineDepth, depth); }
      else { depth++; }
    }
    depths.push(Math.max(0, lineDepth));
  }
  return depths;
}

const envDepthField = StateField.define<number[]>({
  create(state) { return computeEnvDepths(state.doc); },
  update(value, tr) {
    if (tr.docChanged) return computeEnvDepths(tr.state.doc);
    return value;
  },
});

class ScopeMarker extends GutterMarker {
  constructor(readonly depth: number) { super(); }
  toDOM() {
    const wrap = document.createElement('div');
    wrap.className = 'cm-scope-marker';
    for (let i = 0; i < this.depth; i++) {
      const bar = document.createElement('span');
      bar.className = 'cm-scope-bar';
      bar.style.backgroundColor = SCOPE_COLORS[i % SCOPE_COLORS.length];
      wrap.appendChild(bar);
    }
    return wrap;
  }
}

const scopeGutter = gutter({
  class: 'cm-scope-gutter',
  lineMarker(view, line) {
    const depths = view.state.field(envDepthField);
    const lineNo = view.state.doc.lineAt(line.from).number;
    const d = depths[lineNo - 1] || 0;
    return d > 0 ? new ScopeMarker(d) : null;
  },
});

const editorTheme = EditorView.theme(
  {
    '&': {
      height: '100%',
      background: 'transparent'
    },
    '.cm-scroller': {
      fontFamily: 'var(--font-mono)',
      fontSize: 'var(--editor-font-size, 13px)',
      lineHeight: '1.6'
    },
    '.cm-content': {
      padding: '16px'
    },
    '.cm-gutters': {
      background: 'transparent',
      border: 'none',
      color: 'var(--text-3)'
    },
    '.cm-lineNumbers .cm-gutterElement': {
      padding: '0 8px 0 12px'
    },
    '.cm-activeLine': {
      background: 'color-mix(in srgb, var(--accent) 6%, transparent)'
    },
    '.cm-activeLineGutter': {
      background: 'transparent'
    },
    '.cm-selectionBackground': {
      background: 'var(--sel)'
    },
    // Popups (completion list, lint and hover tooltips) are drawn by CodeMirror with its light defaults; bind them to tokens.
    '.cm-tooltip': {
      background: 'var(--surface)',
      color: 'var(--text)',
      border: '1px solid var(--border-strong)',
      borderRadius: 'var(--r-md, 8px)',
      boxShadow: 'var(--shadow-2)',
      overflow: 'hidden'
    },
    '.cm-tooltip .cm-tooltip-arrow:before, .cm-tooltip .cm-tooltip-arrow:after': { display: 'none' },
    '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-mono)', maxHeight: '16em' },
    '.cm-tooltip-autocomplete > ul > li': { padding: '2px 8px', color: 'var(--text)' },
    '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--sel)', color: 'var(--text)' },
    '.cm-completionDetail': { color: 'var(--text-3)', fontStyle: 'normal', marginLeft: '0.8em' },
    '.cm-completionMatchedText': { color: 'var(--accent)', textDecoration: 'none', fontWeight: '600' },
    '.cm-completionInfo': {
      background: 'var(--surface)',
      color: 'var(--text-2)',
      border: '1px solid var(--border-strong)'
    },
    '.cm-tooltip-lint': { padding: '0' },
    '.cm-diagnostic': { color: 'var(--text)', padding: '6px 10px' },
    '.cm-diagnostic-warning': { borderLeft: '4px solid var(--warning)' },
    '.cm-diagnostic-error': { borderLeft: '4px solid var(--danger)' },
    '.cm-panels': { background: 'var(--surface-2)', color: 'var(--text)', borderColor: 'var(--border)' }
  },
  { dark: false }
);

/** LaTeX token colours, bound to design tokens so they follow light/dark themes. */
const latexHighlight = HighlightStyle.define([
  { tag: hlTags.comment, color: 'var(--code-comment)', fontStyle: 'italic' },
  { tag: hlTags.keyword, color: 'var(--code-cmd)' },
  { tag: hlTags.definitionKeyword, color: 'var(--code-kw)', fontWeight: '600' },
  { tag: hlTags.heading, color: 'var(--code-kw)', fontWeight: '700' },
  { tag: hlTags.className, color: 'var(--code-kw)' },
  { tag: hlTags.labelName, color: 'var(--code-math)' },
  { tag: hlTags.quote, color: 'var(--code-math)' },
  { tag: [hlTags.number, hlTags.variableName], color: 'var(--code-math)' },
  { tag: [hlTags.processingInstruction, hlTags.operator], color: 'var(--code-cmd)' },
  { tag: hlTags.string, color: 'var(--text-2)' },
  { tag: hlTags.meta, color: 'var(--text-2)' },
  { tag: hlTags.strong, fontWeight: '700' },
  { tag: hlTags.emphasis, fontStyle: 'italic' },
  { tag: hlTags.invalid, color: 'var(--danger, var(--code-kw))' },
  { tag: hlTags.bracket, color: 'var(--text-3)' }
]);

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
  containerRef: externalRef,
  focusRef,
  scrollAtCompileRef
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
  /** Where to scroll once this PDF has rendered (set by a compile that knew the caret's position); cleared after use. */
  focusRef?: MutableRefObject<PdfFocus | null>;
  /** The scroll position when the compile started. If the reader has moved since, their position wins over the focus. */
  scrollAtCompileRef?: MutableRefObject<number>;
}) {
  const { t } = useTranslation();
  const localRef = useRef<HTMLDivElement | null>(null);
  const containerRef = externalRef || localRef;
  /** The reader's last scroll position (and the content height it was measured against) while a finished PDF was showing. */
  const lastView = useRef({ top: 0, height: 0 });
  const viewSettled = useRef(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const onScroll = () => {
      if (viewSettled.current) lastView.current = { top: container.scrollTop, height: container.scrollHeight };
    };
    container.addEventListener('scroll', onScroll, { passive: true });
    return () => container.removeEventListener('scroll', onScroll);
  }, [containerRef]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container || !pdfUrl) return;
    let cancelled = false;
    // Re-rendering empties the container, which would throw the reader back to the top. Use the last position the
    // reader had while a finished PDF was showing: by the time this body runs, the previous run's cleanup has already
    // emptied the container, so reading it now would always give 0.
    const previousTop = lastView.current.top;
    const previousRatio = lastView.current.height > 0 ? previousTop / lastView.current.height : 0;
    viewSettled.current = false;
    container.innerHTML = '';
    container.style.paddingBottom = '';

    /** After the pages are in the DOM: go to the compile's focus, or put the reader back where they were. */
    const restorePosition = (pageScale: number) => {
      const focus = focusRef?.current ?? null;
      if (focusRef) focusRef.current = null;
      const readerMoved = scrollAtCompileRef ? Math.abs(previousTop - scrollAtCompileRef.current) > 4 : false;
      const visible = container.clientHeight > 0;
      const wrapper = focus && container.querySelector<HTMLElement>(`.pdf-page[data-page-number="${focus.page}"]`);
      if (focus && wrapper && visible && !readerMoved) {
        const pageTop = wrapper.getBoundingClientRect().top - container.getBoundingClientRect().top + container.scrollTop;
        // PDF points at scale 1 are CSS pixels, so y * scale is the offset into the page; leave some context above it.
        const wanted = Math.max(0, pageTop + focus.y * pageScale - container.clientHeight * 0.3);
        // Near the end of the document the position may lie beyond what can be scrolled to (the rest of the last page
        // is often blank); add just enough room after the last page to reach it.
        const reachable = container.scrollHeight - container.clientHeight;
        if (wanted > reachable) container.style.paddingBottom = `${Math.ceil(wanted - reachable)}px`;
        container.scrollTop = wanted;
      } else if (previousRatio > 0) {
        container.scrollTop = previousRatio * container.scrollHeight;
      }
      lastView.current = { top: container.scrollTop, height: container.scrollHeight };
      viewSettled.current = true;
    };

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
        restorePosition(baseScale);

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
  /** The project's workspace provider, when the user's AI requests will use it (see the AI settings notice). */
  const [workspaceProvider, setWorkspaceProvider] = useState<{ model: string } | null>(null);
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
  /** Whether this user may change the project (the tree endpoint says so); the AI edit bar needs it, and a real account. */
  const [canWrite, setCanWrite] = useState(false);
  const [aiBar, setAiBar] = useState<{ open: boolean; busy: boolean; progress: string; error: string; note: string }>(
    { open: false, busy: false, progress: '', error: '', note: '' }
  );
  const aiRunRef = useRef(0);
  const aiAbortRef = useRef<AbortController | null>(null);
  const aiJobRef = useRef<{ id: string; timer: number } | null>(null);
  const openAiBarRef = useRef<() => boolean>(() => false);
  // Comments: every thread of the project, what the caller may do, and a selection waiting for its first comment.
  const [commentThreads, setCommentThreads] = useState<CommentThreadMeta[]>([]);
  const [commentRights, setCommentRights] = useState({ canComment: false, canModerate: false });
  const [pendingComment, setPendingComment] = useState<PendingComment | null>(null);
  const [focusedThread, setFocusedThread] = useState<string | null>(null);
  const [commentError, setCommentError] = useState('');
  const startCommentRef = useRef<() => boolean>(() => false);
  const openThreadRef = useRef<(id: string) => void>(() => {});
  const [compileLog, setCompileLog] = useState('');
  const [pdfUrl, setPdfUrl] = useState('');
  /** An older version's PDF shown in place of the current build; `backUrl` is the build to return to. */
  const [versionView, setVersionView] = useState<{ id: string; number: number; url: string; backUrl: string } | null>(null);
  const [versionsRefresh, setVersionsRefresh] = useState(0);
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
  const [initialLayout] = useState(loadEditorLayout);
  const [leftView, setLeftView] = useState<LeftView>(initialLayout.leftView);
  const [leftOpen, setLeftOpen] = useState(initialLayout.leftOpen);
  const [activeSidebar, setActiveSidebar] = useState<RightTool>(initialLayout.rightTool);
  const [rightOpen, setRightOpen] = useState(initialLayout.rightOpen);
  /** sidebar/right: panel widths in px. editor: editor share of the centre (ratio). */
  const [columnSizes, setColumnSizes] = useState({ sidebar: initialLayout.leftWidth, editor: initialLayout.split, right: initialLayout.rightWidth });
  const [viewMode, setViewMode] = useState<ViewMode>(initialLayout.viewMode);
  const [narrowLeft, setNarrowLeft] = useState(() => window.matchMedia(NARROW_LEFT_QUERY).matches);
  const [narrowRight, setNarrowRight] = useState(() => window.matchMedia(NARROW_RIGHT_QUERY).matches);
  const [projectSearch, setProjectSearch] = useState('');
  const [searchCorpus, setSearchCorpus] = useState<Record<string, string> | null>(null);
  const [searchLoading, setSearchLoading] = useState(false);
  const [editorSplit, setEditorSplit] = useState(0.7);
  const [selectedPath, setSelectedPath] = useState('');
  const [openFolders, setOpenFolders] = useState<Record<string, boolean>>({});
  const [dragOverPath, setDragOverPath] = useState('');
  const [dragOverKind, setDragOverKind] = useState<'file' | 'folder' | ''>('');
  const [draggingPath, setDraggingPath] = useState('');
  const [dragHint, setDragHint] = useState<{ text: string; x: number; y: number } | null>(null);
  const [mainFile, setMainFile] = useState('');
  const [fileFilter, setFileFilter] = useState('');
  const [inlineEdit, setInlineEdit] = useState<InlineEdit | null>(null);
  const [fileContextMenu, setFileContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [outlineCollapsed, setOutlineCollapsed] = useState(false);
  const [editorFontSize, setEditorFontSize] = useState(13);
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
  const [currentTex, setCurrentTex] = useState(''); // the last .tex file opened: outline, PDF and figures follow it
  const [docTree, setDocTree] = useState<DocumentTree | null>(null);
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
  /** Labels, bibliography keys and file paths of the whole project; feeds completion and the \ref/\cite check. */
  const projectIndexRef = useRef<ProjectIndex | null>(null);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const editorSplitRef = useRef<HTMLDivElement | null>(null);
  const centerRef = useRef<HTMLElement | null>(null);
  const pdfContainerRef = useRef<HTMLDivElement | null>(null);
  /** Where the caret's source line landed in the newly compiled PDF; consumed once by PdfPreview when it renders. */
  const pdfFocusRef = useRef<PdfFocus | null>(null);
  const compiledViewsRef = useRef(new Map<string, CompiledView>());
  const viewTargetRef = useRef('');
  const filesRef = useRef<Record<string, string>>({});
  const engineOverridesRef = useRef(new Map<string, CompileEngine>()); // per file; the engine setting stays the user's
  /** The preview's scroll position when the compile started: if it has changed by the time the PDF arrives, the reader scrolled. */
  const pdfScrollAtCompileRef = useRef(0);
  const fileTreeRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const folderInputRef = useRef<HTMLInputElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const collabProviderRef = useRef<CollabProvider | null>(null);
  const collabDocRef = useRef<{ doc: Y.Doc; text: Y.Text; awareness: Awareness } | null>(null);
  const collabActiveRef = useRef(false);
  const collabColorRef = useRef<string>(pickCollabColor(collabName));
  const collabCompartment = useMemo(() => new Compartment(), []);
  const readOnlyCompartment = useMemo(() => new Compartment(), []);
  const canWriteRef = useRef(false); // read when the editor view is (re)created

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
    if (!collabEnabled) {
      collabActiveRef.current = false;
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
        getWorkspaceLlm(current.workspaceId)
          .then((llm) => setWorkspaceProvider(llm.ok && llm.configured && llm.canUse ? { model: llm.model || '' } : null))
          .catch(() => setWorkspaceProvider(null));
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
      collabActiveRef.current = false;
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
      collabActiveRef.current = false;
      if (collabProviderRef.current) {
        collabProviderRef.current.disconnect();
        collabProviderRef.current = null;
      }
      collabDocRef.current = null;
      view.dispatch({ effects: collabCompartment.reconfigure([]) });
      setCollabStatus('disconnected');
      setCollabPeers([]);
      setStatus(t('协作暂不支持该文件类型。'));
      return;
    }
    const currentDoc = view.state.doc.toString();
    if (currentDoc.length > 0) {
      suppressDirtyRef.current = true;
      view.dispatch({ changes: { from: 0, to: currentDoc.length, insert: '' } });
    }
    setEditorValue('');
    setIsDirty(false);

    const ydoc = new Y.Doc();
    const ytext = ydoc.getText('content');
    const awareness = new Awareness(ydoc);
    awareness.setLocalStateField('user', {
      name: collabName,
      color: collabColorRef.current
    });
    const provider = new CollabProvider({
      serverUrl: normalizeServerUrl(collabServer) || (typeof window === 'undefined' ? '' : window.location.origin),
      token: tokenForUrl, // read on every (re)connect, so a refreshed account token is picked up
      projectId,
      filePath: activePath,
      doc: ydoc,
      awareness,
      onStatus: setCollabStatus,
      onError: (error) => setStatus(t('协作连接失败: {{error}}', { error }))
    });
    collabProviderRef.current = provider;
    collabDocRef.current = { doc: ydoc, text: ytext, awareness };
    view.dispatch({ effects: collabCompartment.reconfigure(yCollab(ytext, awareness)) });
    collabActiveRef.current = true;
    provider.connect();

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
      collabActiveRef.current = false;
      awareness.off('update', updatePeers);
      provider.disconnect();
      collabProviderRef.current = null;
      collabDocRef.current = null;
      ydoc.destroy();
      view.dispatch({ effects: collabCompartment.reconfigure([]) });
      setCollabPeers([]);
    };
  }, [activePath, collabCompartment, collabEnabled, collabName, collabServer, collabToken, projectId, t]);

  const showingVersion = versionView && versionView.url === pdfUrl ? versionView : null;
  useEffect(() => {
    // Anything else replacing the preview (a compile, another file's build) ends the version view.
    if (versionView && pdfUrl !== versionView.url) {
      URL.revokeObjectURL(versionView.url);
      setVersionView(null);
    }
  }, [pdfUrl, versionView]);

  const viewVersionPdf = async (version: { id: string; number: number } | null) => {
    if (!version) {
      if (showingVersion) setPdfUrl(showingVersion.backUrl);
      return;
    }
    try {
      const blob = await fetchVersionPdf(projectId, version.id);
      const url = URL.createObjectURL(blob);
      const backUrl = showingVersion ? showingVersion.backUrl : pdfUrl;
      if (showingVersion) URL.revokeObjectURL(showingVersion.url);
      setVersionView({ id: version.id, number: version.number, url, backUrl });
      setPdfUrl(url);
      setRightView('pdf');
    } catch (err) {
      setStatus(t('Could not open version #{{n}}: {{error}}', { n: version.number, error: String((err as Error).message || err) }));
    }
  };

  /**
   * Restore a version. A REST write behind an open live room is overwritten by the room's next save, so this tab leaves
   * its own room first (the server drops idle rooms); other people's open files make the server answer 409. Afterwards
   * the editor reloads from the server and rejoins.
   */
  const restoreVersionInEditor = async (version: { id: string; number: number }): Promise<RestoreVersionResult> => {
    const wasLive = collabEnabled && collabActiveRef.current;
    if (wasLive) {
      await flushCollabFile(projectId, activePath).catch(() => undefined);
      setCollabEnabled(false);
      await new Promise((resolve) => setTimeout(resolve, 500)); // let the socket close reach the server
    }
    try {
      const res = await restoreVersion(projectId, version.id);
      if (res.ok && res.restored) {
        if (showingVersion) setPdfUrl(showingVersion.backUrl);
        setFiles({});
        const items = await refreshTree(true, true); // opens the main file itself if the open one no longer exists
        if (activePath && items.some((item) => item.path === activePath)) await openFile(activePath, true).catch(() => undefined);
        setVersionsRefresh((n) => n + 1);
        setStatus(t('Restored version #{{from}} as version #{{n}}', { from: version.number, n: res.versionNumber }));
      }
      return res;
    } finally {
      if (wasLive) setCollabEnabled(true);
    }
  };

  /** Restore one file from a version. Only this tab's own room for that file needs leaving (see restoreVersionInEditor). */
  const restoreFileInEditor = async (version: { id: string; number: number }, path: string): Promise<RestoreVersionResult> => {
    const wasLive = collabEnabled && collabActiveRef.current && activePath === path;
    if (wasLive) {
      await flushCollabFile(projectId, activePath).catch(() => undefined);
      setCollabEnabled(false);
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    try {
      const res = await restoreVersionFile(projectId, version.id, path);
      if (res.ok && res.restored) {
        setFiles((prev) => {
          const next = { ...prev };
          delete next[path];
          return next;
        });
        await refreshTree(true, true);
        if (activePath === path) await openFile(path, true).catch(() => undefined);
        setStatus(t('Restored {{path}} from version #{{n}}', { path, n: version.number }));
      }
      return res;
    } finally {
      if (wasLive) setCollabEnabled(true);
    }
  };

  const refreshTree = async (keepActive = true, fresh = false) => {
    if (!projectId) return [];
    const res = await getProjectTree(projectId);
    setTree(res.items);
    setFileOrder(res.fileOrder || {});
    setCanWrite(res.canWrite !== false);
    if (!keepActive || !activePath || !res.items.find((item) => item.path === activePath)) {
      const main = res.items.find((item) => item.path.endsWith('main.tex'))?.path;
      const next = main || res.items.find((item) => item.type === 'file')?.path || '';
      if (next) {
        await openFile(next, fresh);
      }
    }
    return res.items;
  };

  /** Re-read every text file so \ref/\cite completion and checks see labels and bib keys from the whole project. */
  useEffect(() => {
    if (!projectId || isSaving) return;
    const timer = window.setTimeout(() => {
      getAllFiles(projectId)
        .then(({ files: list }) => {
          const texts: Record<string, string> = {};
          list.forEach((file) => {
            if (file.encoding !== 'base64' && isTextPath(file.path)) texts[file.path] = file.content;
          });
          projectIndexRef.current = buildProjectIndex(texts, list.map((file) => file.path));
          cmViewRef.current && forceLinting(cmViewRef.current);
        })
        .catch(() => {});
    }, 400);
    return () => window.clearTimeout(timer);
  }, [projectId, tree, isSaving]);

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
        const programmatic = suppressDirtyRef.current;
        setEditorValue(value);
        if (!programmatic && !collabActiveRef.current) {
          setIsDirty(true);
        } else {
          suppressDirtyRef.current = false;
        }
        const path = activePathRef.current;
        if (path && (!programmatic || collabActiveRef.current)) {
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
        // Cross-file checks (\ref/\cite against the whole project) are done by projectReferenceLinter below.
        latex({
          enableAutocomplete: false,
          linter: { checkMissingReferences: false, checkDuplicateLabels: false, checkCitesWithoutBibliography: false }
        }),
        envDepthField,
        scopeGutter,
        indentOnInput(),
        foldService.of(latexFoldService),
        EditorView.lineWrapping,
        editorTheme,
        syntaxHighlighting(latexHighlight),
        collabCompartment.of([]),
        commentMarksField,
        commentClicks((id) => openThreadRef.current(id)),
        readOnlyCompartment.of(canWriteRef.current ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)]),
        ghostField,
        search(),
        autocompletion({
          override: [
            projectCompletionSource(() => projectIndexRef.current, () => activePathRef.current),
            packageCompletionSource(true)
          ],
          icons: true
        }),
        linter((view) => projectReferenceLinter(() => projectIndexRef.current, () => activePathRef.current)(view.state), { delay: 500 }),
        updateListener,
        keymapExtension,
        // Ctrl/Cmd+Enter compiles. CodeMirror's default keymap (inside basicSetup, so ahead of keymapExtension) binds
        // the same key to "insert blank line", which is why this one is Prec.highest and handles the key itself.
        Prec.highest(keymap.of([
          { key: 'Mod-Enter', run: () => { void compileRef.current(); return true; } },
          { key: 'Mod-k', run: () => openAiBarRef.current() },
          { key: 'Mod-Alt-m', run: () => startCommentRef.current() }
        ]))
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

  /** `fresh` skips the in-memory copy (after the server changed files behind the editor's back, e.g. a restore). */
  const openFile = async (filePath: string, fresh = false) => {
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
    if (!fresh && Object.prototype.hasOwnProperty.call(files, filePath)) {
      const cached = files[filePath] ?? '';
      const collabTextFile = collabEnabled && isTextPath(filePath);
      setEditorValue(collabTextFile ? '' : cached);
      setIsDirty(false);
      if (!collabTextFile) {
        setEditorDoc(cached);
      }
      return cached;
    }
    const data = await getFile(projectId, filePath);
    setFiles((prev) => ({ ...prev, [filePath]: data.content }));
    const collabTextFile = collabEnabled && isTextPath(filePath);
    setEditorValue(collabTextFile ? '' : data.content);
    setIsDirty(false);
    if (!collabTextFile) {
      setEditorDoc(data.content);
    }
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
        const { doc, text } = collabDocRef.current;
        doc.transact(() => {
          text.delete(0, text.length);
          text.insert(0, content);
        });
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
    if (collabActiveRef.current || collabEnabled) return;
    setEditorDoc(editorValue);
  }, [editorValue, setEditorDoc, collabEnabled]);

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
        if (!collabActiveRef.current) {
          setEditorDoc(content);
        }
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
        projectId,
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
            projectId,
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
        projectId,
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
        projectId,
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
        if (!collabActiveRef.current) {
          setEditorDoc(nextContent);
        }
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

  const handleDeleteFile = async () => {
    if (!projectId) return;
    const target = selectedPath || activePath;
    if (!target) return;

    const confirmMessage = t('确定要删除 "{name}" 吗？此操作不可恢复。', { name: target.split('/').pop() || target });
    if (!window.confirm(confirmMessage)) return;

    try {
      const result = await deleteFile(projectId, target);
      if (result.ok) {
        // If deleted file was the active file, clear it
        if (target === activePath) {
          setActivePath('');
        }
        // Refresh the file tree
        refreshTree();
      } else {
        alert(result.error || t('删除失败'));
      }
    } catch (err) {
      console.error('Delete error:', err);
      alert(t('删除失败') + ': ' + String(err));
    }
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

  filesRef.current = files;
  useEffect(() => {
    if (activePath.toLowerCase().endsWith('.tex')) setCurrentTex(activePath);
  }, [activePath]);

  const knownPaths = useMemo(() => new Set(tree.filter((item) => item.type === 'file').map((item) => item.path)), [tree]);
  const liveTex = activePath === currentTex ? editorValue : null; // unsaved text of the file being edited
  useEffect(() => {
    if (!currentTex) {
      setDocTree(null);
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(async () => {
      const readText = async (path: string) => {
        if (path === currentTex && liveTex !== null) return liveTex;
        const cached = filesRef.current[path];
        if (cached !== undefined) return cached;
        try {
          const data = await getFile(projectId, path);
          setFiles((prev) => ({ ...prev, [path]: data.content }));
          return data.content;
        } catch {
          return undefined;
        }
      };
      const built = await buildDocumentTree(currentTex, readText, knownPaths);
      let root = currentTex;
      if (!isRootDocument((await readText(currentTex)) ?? '')) {
        // A section: its PDF is the document that includes it (the most recently compiled one, else the main file).
        const owners: string[] = [];
        for (const candidate of texFiles) {
          if (candidate === currentTex || !isRootDocument((await readText(candidate)) ?? '')) continue;
          if ((await buildDocumentTree(candidate, readText, knownPaths)).files.includes(currentTex)) owners.push(candidate);
        }
        const compiled = [...compiledViewsRef.current.keys()].reverse().find((key) => owners.includes(key));
        root = compiled ?? (owners.includes(mainFile) ? mainFile : owners[0]) ?? mainFile;
      }
      if (!cancelled) setDocTree({ tex: currentTex, root, outline: built.outline, figures: built.figures });
    }, 300);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [currentTex, liveTex, knownPaths, texFiles, mainFile, projectId]);

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
      let remembered: string | null = null;
      try { remembered = window.localStorage.getItem(mainFileKey(projectId)); } catch { /* storage unavailable */ }
      const preferred = (remembered && texFiles.includes(remembered) ? remembered : null)
        || texFiles.find((path) => path.endsWith('main.tex')) || texFiles[0];
      setMainFile(preferred);
    }
  }, [texFiles, mainFile, projectId]);

  const viewTarget = !currentTex
    ? mainFile
    : docTree?.tex === currentTex
      ? docTree.root
      : liveTex !== null && isRootDocument(liveTex) ? currentTex : mainFile;
  viewTargetRef.current = viewTarget;
  useEffect(() => {
    const shown = compiledViewsRef.current.get(viewTarget);
    pdfFocusRef.current = null;
    setPdfUrl(shown?.url ?? '');
    setCompileLog(shown?.log ?? '');
    setEngineName(shown?.engine ?? '');
  }, [viewTarget]);

  const chooseMainFile = useCallback((path: string) => {
    setMainFile(path);
    try { window.localStorage.setItem(mainFileKey(projectId), path); } catch { /* storage unavailable */ }
  }, [projectId]);

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
              <Icon name="chevron-down" className={`tree-caret ${isOpen ? '' : 'is-closed'}`} />
              <Icon name="folder" className="tree-icon ft-dir" />
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
          <Icon name={fileIconName(node.path)} className={`tree-icon ${fileIconClass(node.path)}`} />
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
      );
    });

  const compile = async () => {
    if (!projectId) return;
    // Where the reader is right now, before any await: if the preview has moved by the time the PDF arrives, the
    // reader scrolled it themselves and must not be pulled to the caret's position.
    pdfScrollAtCompileRef.current = pdfContainerRef.current?.scrollTop ?? 0;
    setIsCompiling(true);
    setStatus(t('编译中...'));
    // Compile the open file if it is a complete document; a section (\input'd file) compiles via the main file.
    const target = viewTarget;
    const views = compiledViewsRef.current;
    const stillViewing = () => viewTargetRef.current === target; // the reader may have switched files meanwhile
    let failedVersion = 0; // a failed compile saved as a version, reported in the status bar
    try {
      // The server compiles what is saved; autosave waits 1.5 s, so write the open file now.
      if (!collabActiveRef.current && isDirty && activePath) {
        await writeFile(projectId, activePath, editorValue);
        setIsDirty(false);
      }
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
      if (!fileMap[target]) {
        throw new Error(t('主文件不存在: {{file}}', { file: target }));
      }
      // Compiling reads the saved project, so in a live session save it first: otherwise the last words typed are
      // missing from the PDF and the caret's line number may no longer match what was compiled.
      if (collabActiveRef.current && activePath) {
        await flushCollabFile(projectId, activePath).catch(() => undefined);
      }
      const view = cmViewRef.current;
      const focus = view && activePath && isTextPath(activePath)
        ? { file: activePath, line: view.state.doc.lineAt(view.state.selection.main.head).number }
        : undefined;
      let engine = engineOverridesRef.current.get(target) ?? compileEngine;
      let res = await compileProject({ projectId, mainFile: target, engine, focus }, (message) => setStatus(message));
      // fontspec and friends cannot run under pdfLaTeX/latexmk; rebuild once with XeLaTeX and remember it for this file.
      if (!res.pdf && (engine === 'pdflatex' || engine === 'latexmk') && NEEDS_UNICODE_ENGINE.test(res.log || '')) {
        engine = 'xelatex';
        setStatus(t('Needs XeLaTeX, recompiling…'));
        res = await compileProject({ projectId, mainFile: target, engine, focus }, (message) => setStatus(message));
        if (res.pdf) engineOverridesRef.current.set(target, engine);
      }
      if (!res.ok || !res.pdf) {
        if (res.versionCreated && res.versionNumber) failedVersion = res.versionNumber;
        const detail = [res.error, res.log].filter(Boolean).join('\n');
        throw new Error(detail || t('后端编译失败'));
      }
      const result: CompileOutcome = {
        pdf: Uint8Array.from(atob(res.pdf), (c) => c.charCodeAt(0)),
        log: res.log || '',
        status: res.status ?? 0,
        engine
      };

      const meta = [
        t('Engine: {{engine}}', { engine }),
        t('Main file: {{file}}', { file: target })
      ].filter(Boolean).join('\n');
      const log = `${meta}\n\n${result.log || t('No log')}`.trim();

      const blob = new Blob([result.pdf], { type: 'application/pdf' });
      const nextUrl = URL.createObjectURL(blob);
      const previous = views.get(target);
      if (previous?.url) URL.revokeObjectURL(previous.url);
      views.delete(target); // keeps the map in order of last compile
      views.set(target, { url: nextUrl, log, engine });
      if (stillViewing()) {
        setEngineName(engine);
        setCompileLog(log);
        pdfFocusRef.current = res.focus ?? null; // read by PdfPreview when this PDF finishes rendering
        setPdfUrl(nextUrl);
        setRightView('pdf');
      }
      const saved = res.versionCreated && res.versionNumber ? ` · ${t('Saved as version #{{n}}', { n: res.versionNumber })}` : '';
      setStatus(`${t('编译完成 ({{engine}})', { engine: result.engine })}${saved}`);
      setVersionsRefresh((n) => n + 1);
    } catch (err) {
      console.error('Compilation error:', err);
      const log = t('编译错误: {{error}}', { error: String(err) });
      views.set(target, { url: views.get(target)?.url ?? '', log, engine: views.get(target)?.engine ?? '' });
      if (stillViewing()) {
        setCompileLog(log);
        setRightView('log'); // otherwise the previous PDF stays up and looks like this compile's result
      }
      // the note goes first: the error that follows can be a whole log, cut off by the status bar
      const saved = failedVersion ? `${t('Saved as version #{{n}} (failed)', { n: failedVersion })} · ` : '';
      setStatus(`${saved}${t('编译失败: {{error}}', { error: String(err) })}`);
      if (failedVersion) setVersionsRefresh((n) => n + 1);
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

  // Only the figures the .tex file being edited actually includes (through its \input files too).
  const figureFiles = useMemo(
    () => (docTree && docTree.tex === currentTex ? docTree.figures : []).map((path) => ({ path })),
    [docTree, currentTex]
  );

  useEffect(() => {
    // Follow the current .tex file; a figure picked in the file tree is kept until the list changes.
    setSelectedFigure((prev) => (figureFiles.some((item) => item.path === prev) ? prev : figureFiles[0]?.path ?? ''));
  }, [figureFiles]);

  useEffect(() => {
    setPdfAnnotations([]);
    if (!pdfUrl) {
      setPdfOutline([]);
      return;
    }
    // Read the bookmarks here, not in the preview, so the contents follow the file even while the preview is hidden.
    let cancelled = false;
    const task = getDocument(pdfUrl);
    task.promise
      .then(async (pdf) => {
        const items = await readPdfOutline(pdf, t('(untitled)'));
        if (!cancelled) setPdfOutline(items);
      })
      .catch(() => {
        if (!cancelled) setPdfOutline([]);
      });
    return () => {
      cancelled = true;
      void task.destroy();
    };
  }, [pdfUrl, t]);

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

  /** Switch to the PDF and scroll to a page. The preview mounts only now, so wait for its pages to exist. */
  const goToPdfPage = useCallback((page: number) => {
    setRightView('pdf');
    const started = performance.now();
    const attempt = () => {
      const target = pdfContainerRef.current?.querySelector(`.pdf-page[data-page-number="${page}"]`) as HTMLElement | null;
      if (target) {
        target.scrollIntoView({ block: 'start' });
      } else if (performance.now() - started < 5000) {
        requestAnimationFrame(attempt);
      }
    };
    requestAnimationFrame(attempt);
  }, []);

  const scrollToPdfPage = useCallback((page: number) => {
    const container = pdfContainerRef.current;
    if (!container || !page) return;
    const target = container.querySelector(`.pdf-page[data-page-number="${page}"]`) as HTMLElement | null;
    if (target) {
      target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
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

  /** What a proposal would write now: as proposed when the file is unchanged since, rebased when the change still applies
   * cleanly to the newer text, otherwise null (stale: never overwrite what changed meanwhile). */
  const resolveProposal = async (item: PendingChange): Promise<{ current: string; text: string } | null> => {
    let current = '';
    const view = cmViewRef.current;
    if (item.filePath === activePath && view) {
      current = view.state.doc.toString();
    } else {
      try {
        current = (await getFile(projectId, item.filePath)).content ?? '';
      } catch {
        current = ''; // a file the proposal creates
      }
    }
    if (current === item.original) return { current, text: item.proposed };
    const merged = merge3(item.original, current, item.proposed);
    return merged === null ? null : { current, text: merged };
  };

  const applyPending = async (change?: PendingChange) => {
    const list = change ? [change] : pendingChanges;
    const done = new Set<string>();
    const stale = new Set<string>();
    let wroteOtherFile = false;
    for (const item of list) {
      const resolved = await resolveProposal(item);
      if (!resolved) {
        stale.add(item.filePath);
        continue;
      }
      const view = cmViewRef.current;
      if (item.filePath === activePath && view) {
        // One transaction through the editor: a single Undo reverts it, and in a live session it travels through the
        // shared document instead of replacing the file underneath other people.
        const edit = minimalChange(resolved.current, resolved.text);
        if (edit.from !== edit.to || edit.insert) {
          view.dispatch({ changes: edit, userEvent: 'input.ai', scrollIntoView: true });
        }
      } else {
        await writeFile(projectId, item.filePath, resolved.text);
        wroteOtherFile = true;
      }
      setFiles((prev) => ({ ...prev, [item.filePath]: resolved.text }));
      done.add(item.filePath);
    }
    if (wroteOtherFile) await refreshTree(true);
    setPendingChanges((prev) =>
      prev.filter((item) => !done.has(item.filePath)).map((item) => (stale.has(item.filePath) ? { ...item, stale: true } : item))
    );
    if (diffFocus && done.has(diffFocus.filePath)) setDiffFocus(null);
    if (stale.size > 0) {
      setStatus(t('{{count}} change(s) no longer apply because the file changed. Ask again.', { count: stale.size }));
    } else {
      setStatus(t('已应用修改'));
    }
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

  useEffect(() => () => {
    if (aiJobRef.current) window.clearInterval(aiJobRef.current.timer); // leaving the editor ends the progress polling
  }, []);

  // People who cannot write (viewers, viewer links) get a read-only editor; the server drops their edits anyway.
  useEffect(() => {
    canWriteRef.current = canWrite;
    cmViewRef.current?.dispatch({
      effects: readOnlyCompartment.reconfigure(canWrite ? [] : [EditorState.readOnly.of(true), EditorView.editable.of(false)])
    });
  }, [canWrite, readOnlyCompartment]);

  const loadComments = useCallback(async () => {
    if (!projectId) return;
    try {
      const res = await listComments(projectId);
      setCommentThreads(res.threads);
      setCommentRights({ canComment: res.canComment, canModerate: res.canModerate });
      setCommentError('');
    } catch (err) {
      setCommentError(err instanceof Error ? err.message : String(err));
    }
  }, [projectId]);

  useEffect(() => {
    void loadComments();
  }, [loadComments, activePath]);

  // While the Comments tool is open, pick up other people's comments without a reload.
  useEffect(() => {
    if (!(rightOpen && activeSidebar === 'comments')) return;
    const timer = window.setInterval(() => void loadComments(), 15_000);
    return () => window.clearInterval(timer);
  }, [rightOpen, activeSidebar, loadComments]);

  // Draw the open file's unresolved threads, placed against the live text (it may be ahead of what the server has).
  // Between placements the highlights follow edits by themselves (commentMarks maps them); placing again shortly after
  // typing stops also catches text that came back (undo, a collaborator) and a file that has just loaded.
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const view = cmViewRef.current;
      if (!view) return;
      const text = view.state.doc.toString();
      const marks = commentThreads
        .filter((th) => th.path === activePath && !th.resolved)
        .map((th) => ({ id: th.id, at: locate(text, th.quote, th.prefix, th.suffix, th.anchor?.from ?? th.hint.from) }))
        .filter((m): m is { id: string; at: { from: number; to: number } } => m.at !== null)
        .map((m) => ({ id: m.id, ...m.at }));
      view.dispatch({ effects: setCommentMarks.of(marks) });
    }, 300);
    return () => window.clearTimeout(timer);
  }, [commentThreads, activePath, editorValue]);

  const replaceThread = (thread: CommentThreadMeta | null, id: string) =>
    setCommentThreads((cur) => (thread ? cur.map((th) => (th.id === id ? thread : th)) : cur.filter((th) => th.id !== id)));

  startCommentRef.current = () => {
    const view = cmViewRef.current;
    if (!view || !activePath || !commentRights.canComment) return false;
    const sel = view.state.selection.main;
    if (sel.empty) {
      setStatus(t('Select the text you want to comment on first.'));
      return true;
    }
    const text = view.state.doc.toString();
    const to = Math.min(sel.to, sel.from + 2000);
    setPendingComment({ path: activePath, from: sel.from, to, quote: text.slice(sel.from, to), ...contextOf(text, sel.from, to) });
    openRightTool('comments');
    return true;
  };

  openThreadRef.current = (id: string) => {
    setFocusedThread(id);
    openRightTool('comments');
  };

  const jumpToThread = async (thread: CommentThreadMeta) => {
    if (thread.path !== activePath) await openFile(thread.path);
    const view = cmViewRef.current;
    if (!view) return;
    const at = locate(view.state.doc.toString(), thread.quote, thread.prefix, thread.suffix, thread.anchor?.from ?? thread.hint.from);
    if (!at) return;
    view.dispatch({ selection: { anchor: at.from, head: at.to }, scrollIntoView: true });
    view.focus();
    setFocusedThread(thread.id);
  };

  openAiBarRef.current = () => {
    if (!canWrite || getInviteToken() || !activePath) return false;
    setAiBar((bar) => ({ ...bar, open: true, error: '' }));
    return true;
  };

  /** Stop following the running request and tell the server to stop working on it. */
  const stopAiJob = (cancel: boolean) => {
    const job = aiJobRef.current;
    aiJobRef.current = null;
    if (!job) return;
    window.clearInterval(job.timer);
    if (cancel) void cancelJob(job.id).catch(() => {}); // the request was aborted anyway; this stops the worker
  };

  const closeAiBar = () => {
    aiRunRef.current += 1; // a request still running is abandoned
    aiAbortRef.current?.abort();
    stopAiJob(true);
    setAiBar({ open: false, busy: false, progress: '', error: '', note: '' });
    cmViewRef.current?.focus();
  };

  const cancelAiRun = () => {
    aiRunRef.current += 1;
    aiAbortRef.current?.abort();
    stopAiJob(true);
    setAiBar((bar) => ({ ...bar, busy: false, progress: '', note: t('Cancelled.') }));
  };

  const runAiEdit = async (prompt: string) => {
    const view = cmViewRef.current;
    if (!view || !activePath) return;
    const run = ++aiRunRef.current;
    const controller = new AbortController();
    aiAbortRef.current = controller;
    setAiBar((bar) => ({ ...bar, busy: true, error: '', note: '', progress: t('Saving…') }));
    try {
      // The server reads files from storage: make sure it has what is on screen (this flushes a live document too).
      await (saveActiveFileRef.current() as unknown as Promise<unknown>);
      const state = view.state;
      const head = state.selection.main.head;
      const line = state.doc.lineAt(head);
      const sel = state.selection.main;
      setAiBar((bar) => ({ ...bar, progress: t('Asking the AI…') }));
      const jobId = crypto.randomUUID();
      const timer = window.setInterval(() => {
        jobProgress(jobId).then((job) => {
          const last = job.progressLog[job.progressLog.length - 1];
          if (last && aiRunRef.current === run) setAiBar((bar) => (bar.busy ? { ...bar, progress: last } : bar));
        }).catch(() => {}); // not created yet, or already gone
      }, 1000);
      aiJobRef.current = { id: jobId, timer };
      const res = await runAgent({
        jobId,
        task: 'edit',
        prompt,
        selection: '',
        content: '',
        mode: 'tools',
        projectId,
        activePath,
        llmConfig,
        interaction: 'agent',
        editContext: {
          activeFile: activePath,
          mainFile: mainFile || undefined,
          cursor: { line: line.number, col: head - line.from + 1 },
          selection: sel.empty ? null : { text: state.sliceDoc(sel.from, sel.to) },
          content: state.doc.toString()
        }
      }, controller.signal);
      stopAiJob(false);
      if (run !== aiRunRef.current) return; // cancelled or closed meanwhile: drop the late answer
      if (!res.ok && !res.reply && res.error) throw new Error(res.error);
      if (res.patches && res.patches.length > 0) {
        setPendingChanges(res.patches.map((patch) => ({
          filePath: patch.path,
          original: patch.original ?? files[patch.path] ?? '',
          proposed: patch.content,
          diff: patch.diff
        })));
        setAiBar({ open: false, busy: false, progress: '', error: '', note: '' });
        showPreviewView('diff');
        setStatus(t('Review the AI proposal and apply it.'));
        view.focus();
      } else {
        setAiBar((bar) => ({ ...bar, busy: false, progress: '', note: res.reply || t('The AI proposed no changes.') }));
      }
    } catch (err) {
      if (run !== aiRunRef.current) return;
      stopAiJob(false);
      setAiBar((bar) => ({ ...bar, busy: false, progress: '', error: err instanceof Error ? err.message : String(err) }));
    }
  };

  const startColumnDrag = useCallback(
    (side: 'left' | 'right' | 'split', event: MouseEvent) => {
      event.preventDefault();
      const startX = event.clientX;
      const { sidebar, editor, right } = columnSizes;
      const handle = event.currentTarget as HTMLElement;
      handle.classList.add('is-dragging');
      document.body.classList.add('ed-resizing');

      const onMove = (moveEvent: globalThis.MouseEvent) => {
        const dx = moveEvent.clientX - startX;
        if (side === 'left') {
          const [min, max] = PANEL_LIMITS.left;
          setColumnSizes({ sidebar: Math.min(max, Math.max(min, sidebar + dx)), editor, right });
        } else if (side === 'right') {
          const [min, max] = PANEL_LIMITS.right;
          setColumnSizes({ sidebar, editor, right: Math.min(max, Math.max(min, right - dx)) });
        } else {
          const rect = centerRef.current?.getBoundingClientRect();
          if (!rect || rect.width === 0) return;
          const ratio = (moveEvent.clientX - rect.left) / rect.width;
          setColumnSizes({ sidebar, editor: Math.min(0.8, Math.max(0.2, ratio)), right });
        }
      };

      const onUp = () => {
        handle.classList.remove('is-dragging');
        document.body.classList.remove('ed-resizing');
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

  /* ===================================================================
     Shell: collapsible / resizable panels, view mode, shortcuts
     =================================================================== */
  const compileRef = useRef(compile);
  compileRef.current = compile;

  useEffect(() => {
    saveEditorLayout({
      leftOpen,
      leftView,
      leftWidth: columnSizes.sidebar,
      rightOpen,
      rightTool: activeSidebar,
      rightWidth: columnSizes.right,
      split: columnSizes.editor,
      viewMode
    });
  }, [leftOpen, leftView, rightOpen, activeSidebar, columnSizes, viewMode]);

  useEffect(() => {
    const mqRight = window.matchMedia(NARROW_RIGHT_QUERY);
    const mqLeft = window.matchMedia(NARROW_LEFT_QUERY);
    const onRight = () => {
      setNarrowRight(mqRight.matches);
      if (mqRight.matches) setRightOpen(false);
    };
    const onLeft = () => {
      setNarrowLeft(mqLeft.matches);
      if (mqLeft.matches) setLeftOpen(false);
    };
    mqRight.addEventListener('change', onRight);
    mqLeft.addEventListener('change', onLeft);
    return () => {
      mqRight.removeEventListener('change', onRight);
      mqLeft.removeEventListener('change', onLeft);
    };
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (event.key === 'Escape' && !mod) {
        if (narrowLeft) setLeftOpen(false);
        if (narrowRight) setRightOpen(false);
        return;
      }
      if (!mod) return;
      if (event.code === 'KeyB' && event.altKey) {
        event.preventDefault();
        setRightOpen((prev) => !prev);
      } else if (event.code === 'KeyB') {
        event.preventDefault();
        setLeftOpen((prev) => !prev);
      } else if (event.key === 'Enter') {
        if (event.defaultPrevented) return; // the editor already handled it (and compiled)
        event.preventDefault();
        void compileRef.current();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [narrowLeft, narrowRight]);

  /* project-wide search (left panel) */
  useEffect(() => {
    if (!leftOpen || leftView !== 'search' || searchCorpus || !projectId) return;
    let cancelled = false;
    setSearchLoading(true);
    getAllFiles(projectId)
      .then(({ files: list }) => {
        if (cancelled) return;
        const map: Record<string, string> = {};
        list.forEach((file) => {
          if (file.encoding !== 'base64' && isTextPath(file.path)) map[file.path] = file.content;
        });
        setSearchCorpus(map);
      })
      .catch(() => {
        if (!cancelled) setSearchCorpus({});
      })
      .finally(() => {
        if (!cancelled) setSearchLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [leftOpen, leftView, searchCorpus, projectId]);

  const searchResults = useMemo(() => {
    const query = projectSearch.trim().toLowerCase();
    if (!query) return [] as { path: string; hits: { line: number; text: string }[] }[];
    const corpus: Record<string, string> = { ...(searchCorpus || {}) };
    Object.entries(files).forEach(([path, content]) => {
      if (isTextPath(path)) corpus[path] = content;
    });
    return Object.keys(corpus)
      .sort()
      .map((path) => {
        const hits: { line: number; text: string }[] = [];
        corpus[path]!.split('\n').forEach((text, idx) => {
          if (text.toLowerCase().includes(query)) hits.push({ line: idx + 1, text: text.trim() });
        });
        return { path, hits };
      })
      .filter((group) => group.hits.length > 0);
  }, [projectSearch, searchCorpus, files]);

  const goToLine = async (path: string, line: number) => {
    if (activePath !== path) await openFile(path);
    const view = cmViewRef.current;
    if (!view) return;
    const target = view.state.doc.line(Math.max(1, Math.min(line, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: target.from, head: target.to }, scrollIntoView: true });
    view.focus();
    if (narrowLeft) setLeftOpen(false);
  };

  const highlightMatch = (text: string, query: string) => {
    const q = query.trim();
    if (!q) return text;
    const idx = text.toLowerCase().indexOf(q.toLowerCase());
    if (idx < 0) return text;
    return (
      <>
        {text.slice(0, idx)}
        <mark>{text.slice(idx, idx + q.length)}</mark>
        {text.slice(idx + q.length)}
      </>
    );
  };

  const toggleLeftView = (view: LeftView) => {
    if (leftOpen && leftView === view) {
      setLeftOpen(false);
    } else {
      setLeftView(view);
      setLeftOpen(true);
    }
  };

  const toggleRightTool = (tool: RightTool) => {
    if (rightOpen && activeSidebar === tool) {
      setRightOpen(false);
    } else {
      setActiveSidebar(tool);
      setRightOpen(true);
    }
  };

  const openRightTool = (tool: RightTool) => {
    setActiveSidebar(tool);
    setRightOpen(true);
  };

  const showPreviewView = (view: 'pdf' | 'figures' | 'diff' | 'log' | 'toc' | 'review') => {
    setRightView(view);
    if (viewMode === 'editor') setViewMode('split');
  };

  const nudgeColumn = (side: 'left' | 'right', event: ReactKeyboardEvent<HTMLDivElement>) => {
    const [min, max, def] = PANEL_LIMITS[side];
    const key = side === 'left' ? 'sidebar' : 'right';
    const dir = side === 'left' ? 1 : -1;
    let next: number | null = null;
    if (event.key === 'ArrowRight') next = columnSizes[key] + 16 * dir;
    else if (event.key === 'ArrowLeft') next = columnSizes[key] - 16 * dir;
    else if (event.key === 'Home') next = min;
    else if (event.key === 'End') next = max;
    else if (event.key === 'Enter') next = def;
    if (next === null) return;
    event.preventDefault();
    const value = Math.min(max, Math.max(min, next));
    setColumnSizes((prev) => ({ ...prev, [key]: value }));
  };

  const resetColumn = (side: 'left' | 'right' | 'split') => {
    if (side === 'split') setColumnSizes((prev) => ({ ...prev, editor: 0.5 }));
    else setColumnSizes((prev) => ({ ...prev, [side === 'left' ? 'sidebar' : 'right']: PANEL_LIMITS[side][2] }));
  };

  const LEFT_VIEWS: { id: LeftView; label: string; icon: IconName }[] = [
    { id: 'files', label: t('Files'), icon: 'folder' },
    { id: 'outline', label: t('Outline'), icon: 'outline' },
    { id: 'search', label: t('Search project'), icon: 'search' }
  ];

  const RIGHT_TOOLS: { id: RightTool; label: string; icon: IconName }[] = [
    { id: 'agent', label: t('Assistant'), icon: 'sparkles' },
    { id: 'review', label: t('Review'), icon: 'review' },
    { id: 'search', label: t('论文检索'), icon: 'book-open' },
    { id: 'zotero', label: t('Zotero'), icon: 'quote' },
    { id: 'comments', label: t('Comments'), icon: 'comment' },
    { id: 'versions', label: t('Versions'), icon: 'history' },
    { id: 'websearch', label: t('Websearch'), icon: 'globe' },
    { id: 'vision', label: t('图像识别'), icon: 'scan' },
    { id: 'plot', label: t('绘图'), icon: 'bar-chart' },
    { id: 'collab', label: t('协作'), icon: 'users' }
  ];

  const ENGINE_LABELS: Record<CompileEngine, string> = {
    pdflatex: 'pdfLaTeX',
    xelatex: 'XeLaTeX',
    lualatex: 'LuaLaTeX',
    latexmk: 'Latexmk',
    tectonic: 'Tectonic'
  };

  const projectMenuItems = (): MenuEntry[] => [
    { label: t('All projects'), icon: 'layout-grid', onSelect: () => navigate('/projects') },
    { type: 'sep' },
    { type: 'label', label: t('Main file') },
    ...(texFiles.length > 0 ? texFiles : ['main.tex']).map<MenuEntry>((path) => ({
      label: path,
      checked: mainFile === path,
      onSelect: () => chooseMainFile(path)
    })),
    { type: 'sep' },
    { label: t('保存'), icon: 'save', kbd: 'Ctrl S', onSelect: () => void saveActiveFile() },
    { label: t('下载 PDF'), icon: 'download', disabled: !pdfUrl, onSelect: () => downloadPdf() },
    { label: t('Share…'), icon: 'share', onSelect: () => openRightTool('collab') },
    { label: t('AI & search settings'), icon: 'settings', onSelect: () => setSettingsOpen(true) }
  ];

  const compileMenuItems = (): MenuEntry[] => [
    { type: 'label', label: t('Engine') },
    ...(Object.keys(ENGINE_LABELS) as CompileEngine[]).map<MenuEntry>((engine) => ({
      label: ENGINE_LABELS[engine],
      checked: compileEngine === engine,
      onSelect: () => setSettings((prev) => ({ ...prev, compileEngine: engine }))
    })),
    { type: 'sep' },
    { label: t('Compile now'), icon: 'play', kbd: 'Ctrl Enter', disabled: isCompiling, onSelect: () => void compile() },
    { label: t('Compile Log'), icon: 'terminal', onSelect: () => showPreviewView('log') },
    { label: t('下载 PDF'), icon: 'download', disabled: !pdfUrl, onSelect: () => downloadPdf() }
  ];

  const compileState: 'running' | 'error' | 'ok' | 'idle' = isCompiling ? 'running' : compileErrors.length > 0 ? 'error' : pdfUrl ? 'ok' : 'idle';
  const compileBadge = {
    running: { tone: 'op-badge-info', icon: 'loader' as IconName, text: t('编译中...') },
    error: { tone: 'op-badge-danger', icon: 'alert-circle' as IconName, text: t('{{count}} errors', { count: compileErrors.length }) },
    ok: { tone: 'op-badge-success', icon: 'check-circle' as IconName, text: t('Compiled') },
    idle: { tone: '', icon: 'info' as IconName, text: t('Not compiled') }
  }[compileState];

  const previewOptions: SegmentOption<'pdf' | 'figures' | 'diff' | 'log' | 'toc' | 'review'>[] = [
    { value: 'pdf', label: 'PDF', icon: 'file-text' },
    { value: 'toc', label: t('目录'), icon: 'outline' },
    { value: 'figures', label: t('Figures'), icon: 'image' },
    { value: 'diff', label: pendingGrouped.length > 0 ? `${t('Diff')} · ${pendingGrouped.length}` : t('Diff'), icon: 'diff' },
    { value: 'log', label: t('Log'), icon: 'terminal' },
    { value: 'review', label: t('评审报告'), icon: 'review' }
  ];

  const insertMenuItems = (): MenuEntry[] => [
    ...(canWrite && !getInviteToken() ? [{ label: t('Ask AI…'), icon: 'wand', onSelect: () => { openAiBarRef.current(); } } as MenuEntry, { type: 'sep' } as MenuEntry] : []),
    { type: 'label', label: t('Structure') },
    { label: t('Section'), icon: 'heading', onSelect: insertSectionSnippet },
    { label: t('Subsection'), icon: 'heading', onSelect: insertSubsectionSnippet },
    { label: t('Subsubsection'), icon: 'heading', onSelect: insertSubsubsectionSnippet },
    { type: 'sep' },
    { label: t('Itemize'), icon: 'list', onSelect: insertItemizeSnippet },
    { label: t('Enumerate'), icon: 'list-ordered', onSelect: insertEnumerateSnippet },
    { label: t('Equation'), icon: 'sigma', onSelect: insertEquationSnippet },
    { label: t('Algorithm'), icon: 'code', onSelect: insertAlgorithmSnippet },
    { type: 'sep' },
    { label: t('Figure'), icon: 'image', onSelect: insertFigureTemplate },
    { label: t('Table'), icon: 'table', onSelect: insertTableSnippet },
    { label: t('Listing'), icon: 'terminal', onSelect: insertListingSnippet }
  ];

  const overlayOpen = (narrowLeft && leftOpen) || (narrowRight && rightOpen);

  return (
    <div className="app-shell ed-app">
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
      <AppTopBar
        crumbs={
          <>
            <CrumbSep />
            <MenuButton className="op-crumb" items={projectMenuItems} menuLabel={t('Project')} minWidth={260}>
              <span className="op-truncate">{projectName || t('Project')}</span>
              <Icon name="chevron-down" />
            </MenuButton>
            {activePath && (
              <>
                <CrumbSep className="op-hide-md" />
                <span className="op-crumb-file op-hide-md" title={activePath}>{activePath}</span>
              </>
            )}
          </>
        }
        actions={
          <>
            <button
              type="button"
              className={`op-badge ${compileBadge.tone}`}
              onClick={() => showPreviewView('log')}
              aria-label={`${compileBadge.text} — ${t('Compile Log')}`}
              data-tip={t('Compile Log')}
            >
              <Icon name={compileBadge.icon} className={compileState === 'running' ? 'op-spin' : ''} />
              <span className="op-hide-sm">{compileBadge.text}</span>
            </button>
            {collabPeers.length > 0 && (
              <span className="op-avatar-stack op-hide-sm" aria-label={t('{{count}} collaborators online', { count: collabPeers.length })}>
                {collabPeers.slice(0, 3).map((peer) => (
                  <Avatar key={peer.id} name={peer.name} color={peer.color} online />
                ))}
              </span>
            )}
            <Button size="sm" icon="share" onClick={() => openRightTool('collab')} aria-label={t('Share')}>
              <span className="op-hide-sm">{t('Share')}</span>
            </Button>
            <div className="op-btn-group">
              <Button variant="primary" size="sm" icon="play" loading={isCompiling} onClick={() => void compile()} data-tip={t('Compile · Ctrl Enter')}>
                <span className="op-hide-sm">{t('编译 PDF')}</span>
              </Button>
              <MenuButton
                className="op-btn op-btn-primary op-btn-sm"
                items={compileMenuItems}
                align="end"
                menuLabel={t('Compile options')}
                aria-label={t('Compile options')}
                minWidth={220}
              >
                <Icon name="chevron-down" />
              </MenuButton>
            </div>
          </>
        }
      />

      <main className={`ed-shell ${narrowLeft ? 'ov-left' : ''} ${narrowRight ? 'ov-right' : ''}`}>
        <nav className="op-rail op-rail-left" aria-label={t('Left panel views')}>
          {LEFT_VIEWS.map((view) => (
            <button
              key={view.id}
              type="button"
              className="op-rail-btn"
              aria-pressed={leftOpen && leftView === view.id}
              aria-label={view.label}
              data-tip={view.label}
              data-tip-pos="right"
              onClick={() => toggleLeftView(view.id)}
            >
              <Icon name={view.icon} />
            </button>
          ))}
          <div className="op-rail-spacer" />
          <button
            type="button"
            className="op-rail-btn"
            aria-label={t('Toggle left panel (Ctrl B)')}
            data-tip={t('Toggle panel · Ctrl B')}
            data-tip-pos="right"
            onClick={() => setLeftOpen((prev) => !prev)}
          >
            <Icon name="panel-left" />
          </button>
        </nav>

        {leftOpen && (
          <aside
            className="ed-side ed-side-left"
            style={{ '--w': `${columnSizes.sidebar}px` } as CSSProperties}
            aria-label={t('Left panel')}
          >
            {leftView === 'files' ? (
              <>
                <PanelHeader
                  title={t('Files')}
                  onCollapse={() => setLeftOpen(false)}
                  collapseLabel={t('Collapse panel')}
                  actions={
                    <>
                      <IconButton icon="file-plus" label={t('新建文件')} onClick={() => beginInlineCreate('new-file')} />
                      <IconButton icon="folder-plus" label={t('新建文件夹')} onClick={() => beginInlineCreate('new-folder')} />
                      <IconButton icon="upload" label={t('上传文件')} onClick={() => fileInputRef.current?.click()} />
                      <IconButton icon="refresh" label={t('刷新')} onClick={() => void refreshTree()} />
                    </>
                  }
                />
                <div className="ed-panel-body ed-files">
                  <div className="panel-search">
                    <input
                      className="op-input"
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
                </div>
              </>
            ) : leftView === 'outline' ? (
              <>
                <PanelHeader title={t('Outline')} onCollapse={() => setLeftOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-panel-body">
                  {currentTex && <div className="ed-panel-note">{currentTex}</div>}
                  {currentTex ? (
                    docTree && docTree.outline.length > 0 ? (
                      <div className="outline-list">
                        {docTree.outline.map((item, idx) => (
                          <button
                            key={`${item.file}-${item.pos}-${idx}`}
                            className={`outline-item level-${item.level}`}
                            onClick={() => {
                              const go = async () => {
                                if (activePath !== item.file) {
                                  await openFile(item.file);
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
                            <span className="outline-line">{item.file === currentTex ? `L${item.line}` : `${item.file.split('/').pop()}:${item.line}`}</span>
                          </button>
                        ))}
                      </div>
                    ) : (
                      <EmptyState icon="outline" title={t('未发现 Section 标题。')} />
                    )
                  ) : (
                    <EmptyState icon="outline" title={t('打开 .tex 文件以显示 Outline。')} />
                  )}
                </div>
              </>
            ) : (
              <>
                <PanelHeader title={t('Search project')} onCollapse={() => setLeftOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-search-box">
                  <div className="ed-input-group">
                    <Icon name="search" />
                    <input
                      className="op-input"
                      type="search"
                      autoFocus
                      value={projectSearch}
                      onChange={(event) => setProjectSearch(event.target.value)}
                      placeholder={t('Search all files')}
                      aria-label={t('Search all files')}
                    />
                  </div>
                </div>
                <div className="ed-panel-body">
                  {!projectSearch.trim() ? (
                    <EmptyState icon="search" title={t('Search this project')}>{t('Find text in every .tex and .bib file.')}</EmptyState>
                  ) : searchLoading && !searchCorpus ? (
                    <div className="ed-panel-note">{t('Loading files…')}</div>
                  ) : searchResults.length === 0 ? (
                    <EmptyState icon="search" title={t('No matches for “{{query}}”', { query: projectSearch.trim() })}>{t('Check the spelling or try a shorter phrase.')}</EmptyState>
                  ) : (
                    <div className="ed-search-results">
                      <div className="ed-panel-note">
                        {t('{{count}} results in {{files}} files', {
                          count: searchResults.reduce((sum, group) => sum + group.hits.length, 0),
                          files: searchResults.length
                        })}
                      </div>
                      {searchResults.map((group) => (
                        <div key={group.path}>
                          <div className="ed-result-file">
                            <Icon name={fileIconName(group.path)} className={fileIconClass(group.path)} />
                            <span className="op-truncate">{group.path}</span>
                          </div>
                          {group.hits.slice(0, 50).map((hit) => (
                            <button
                              key={`${group.path}:${hit.line}`}
                              type="button"
                              className="ed-result-row"
                              onClick={() => void goToLine(group.path, hit.line)}
                            >
                              <span className="ed-result-line">{hit.line}</span>
                              <span className="op-truncate">{highlightMatch(hit.text, projectSearch)}</span>
                            </button>
                          ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </>
            )}
          </aside>
        )}
        {leftOpen && !narrowLeft && (
          <div
            className="ed-resizer"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t('Resize left panel')}
            aria-valuenow={columnSizes.sidebar}
            aria-valuemin={PANEL_LIMITS.left[0]}
            aria-valuemax={PANEL_LIMITS.left[1]}
            onMouseDown={(event) => startColumnDrag('left', event)}
            onKeyDown={(event) => nudgeColumn('left', event)}
            onDoubleClick={() => resetColumn('left')}
          />
        )}

        <section
          className={`ed-center mode-${viewMode}`}
          ref={centerRef}
          style={{ '--split': `${Math.round(columnSizes.editor * 1000) / 10}%` } as CSSProperties}
          aria-label={t('Editor and preview')}
        >
          <div className="ed-center-bar">
            <Icon name={activePath ? fileIconName(activePath) : 'file'} className={activePath ? fileIconClass(activePath) : ''} />
            <span className="op-truncate ed-center-file">{activePath || t('未选择文件')}</span>
            {currentHeading && <span className="op-truncate ed-center-heading op-hide-sm">{currentHeading.title}</span>}
            <div className="op-fill" />
            <SegmentedControl
              label={t('View mode')}
              value={viewMode}
              onChange={setViewMode}
              options={[
                { value: 'editor', label: t('Editor'), icon: 'file-text' },
                { value: 'split', label: t('Split'), icon: 'columns' },
                { value: 'pdf', label: 'PDF', icon: 'eye' }
              ]}
            />
          </div>
          <div className="ed-panes">
            <section className="ed-pane editor-panel" aria-label={t('Editor')}>
              <div className="ed-toolbar">
                <MenuButton className="op-btn op-btn-ghost op-btn-sm" items={insertMenuItems} menuLabel={t('Insert')} aria-label={t('Insert')}>
                  <Icon name="plus" />
                  <span className="ed-toolbar-label">{t('Insert')}</span>
                  <Icon name="chevron-down" />
                </MenuButton>
                <Button variant="ghost" size="sm" icon="quote" onClick={insertCiteSnippet} aria-label={t('Cite')}>
                  <span className="ed-toolbar-label">{t('Cite')}</span>
                </Button>
                <Button variant="ghost" size="sm" icon="link" onClick={insertRefSnippet} aria-label={t('Ref')}>
                  <span className="ed-toolbar-label">{t('Ref')}</span>
                </Button>
                <Button variant="ghost" size="sm" icon="hash" onClick={insertLabelSnippet} aria-label={t('Label')}>
                  <span className="ed-toolbar-label">{t('Label')}</span>
                </Button>
                <span className="ed-toolbar-sep" aria-hidden="true" />
                {commentRights.canComment && (
                  <Button variant="ghost" size="sm" icon="comment" onClick={() => startCommentRef.current()} aria-label={t('Comment')}
                    title={`${t('Comment on the selection')} (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘⌥' : 'Ctrl+Alt+'}M)`}>
                    <span className="ed-toolbar-label">{t('Comment')}</span>
                  </Button>
                )}
                {canWrite && !getInviteToken() && (
                  <Button variant="ghost" size="sm" icon="wand" onClick={() => openAiBarRef.current()} aria-label={t('Ask AI')} title={`${t('Ask AI')} (${/Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl+'}K)`}>
                    <span className="ed-toolbar-label">{t('Ask AI')}</span>
                  </Button>
                )}
                <Button variant="ghost" size="sm" icon="sparkles" onClick={() => openRightTool('agent')} aria-label={t('Assistant')}>
                  <span className="ed-toolbar-label">{t('Assistant')}</span>
                </Button>
                <div className="op-fill" />
                <IconButton icon="minus" label={t('Smaller text')} onClick={() => setEditorFontSize((s) => Math.max(8, s - 1))} />
                <span className="ed-font-size" aria-live="polite">{editorFontSize}px</span>
                <IconButton icon="plus" label={t('Larger text')} tipPos="bottom-end" onClick={() => setEditorFontSize((s) => Math.min(24, s + 1))} />
              </div>
              <div
                className="editor-split"
                ref={editorSplitRef}
              >
                <div className="editor-area" ref={editorAreaRef}>
                  {aiBar.open && (
                    <AiCommandBar
                      onSubmit={(prompt) => void runAiEdit(prompt)}
                      onCancel={cancelAiRun}
                      onClose={closeAiBar}
                      busy={aiBar.busy}
                      progress={aiBar.progress}
                      error={aiBar.error}
                      note={aiBar.note}
                      hasSelection={selectionRange[0] !== selectionRange[1]}
                    />
                  )}
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
                            <button className="op-btn op-btn-primary" onClick={() => acceptSuggestionRef.current()}>{t('接受')}</button>
                            <button className="op-btn op-btn-secondary op-btn-sm" onClick={() => clearSuggestionRef.current()}>{t('拒绝')}</button>
                          </div>
                        </>
                      )}
                    </div>
                  )}
                </div>
              </div>
            </section>
            {viewMode === 'split' && (
              <div
                className="ed-resizer ed-split-resizer"
                role="separator"
                aria-orientation="vertical"
                aria-label={t('Resize editor and preview')}
                onMouseDown={(event) => startColumnDrag('split', event)}
                onDoubleClick={() => resetColumn('split')}
              />
            )}
            <section className="ed-pane pdf-panel" aria-label={t('Preview')}>
              <div className="op-panel-header ed-preview-header">
                <SegmentedControl label={t('Preview')} value={rightView} onChange={setRightView} options={previewOptions} />
              </div>
              <div className="right-body">
                <div className="view-content">
                  {rightView === 'pdf' && (
                    <>
                      <div className="pdf-toolbar">
                        <div className="toolbar-group">
                          <IconButton icon="zoom-out" label={t('缩小')} onClick={() => zoomPdf(-0.1)} disabled={!pdfUrl} />
                          <div className="zoom-label">{pdfScaleLabel}</div>
                          <IconButton icon="zoom-in" label={t('放大')} onClick={() => zoomPdf(0.1)} disabled={!pdfUrl} />
                          <button className="op-btn op-btn-ghost op-btn-sm" onClick={() => setPdfFitWidth(true)} disabled={!pdfUrl}>{t('适合宽度')}</button>
                          <button
                            className="op-btn op-btn-ghost op-btn-sm"
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
                          <IconButton icon="download" label={t('下载 PDF')} tipPos="bottom-end" onClick={downloadPdf} disabled={!pdfUrl} />
                          <button
                            className="op-btn op-btn-ghost op-btn-sm"
                            aria-pressed={pdfSpread}
                            onClick={() => setPdfSpread((prev) => !prev)}
                            disabled={!pdfUrl}
                          >
                            {t('双页')}
                          </button>
                          <button
                            className="op-btn op-btn-ghost op-btn-sm"
                            aria-pressed={pdfAnnotateMode}
                            onClick={() => setPdfAnnotateMode((prev) => !prev)}
                            disabled={!pdfUrl}
                          >
                            {t('注释')}
                          </button>
                        </div>
                      </div>
                      {showingVersion && (
                        <div className="version-banner" role="status" data-testid="version-banner">
                          <Icon name="history" />
                          <span>{t('Version #{{n}}, not the current build', { n: showingVersion.number })}</span>
                          <Button size="sm" variant="secondary" data-testid="version-back" onClick={() => void viewVersionPdf(null)}>
                            {t('Back to current build')}
                          </Button>
                        </div>
                      )}
                      {pdfUrl ? (
                        <PdfPreview
                          pdfUrl={pdfUrl}
                          scale={pdfScale}
                          fitWidth={pdfFitWidth}
                          spread={pdfSpread}
                          onFitScale={handleFitScale}
                          annotations={pdfAnnotations}
                          annotateMode={pdfAnnotateMode}
                          onAddAnnotation={addPdfAnnotation}
                          containerRef={pdfContainerRef}
                          focusRef={pdfFocusRef}
                          scrollAtCompileRef={pdfScrollAtCompileRef}
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
                        <EmptyState icon="file-text" title={t('尚未生成 PDF')} action={<Button size="sm" icon="play" onClick={compile} loading={isCompiling}>{t('编译 PDF')}</Button>}>{t('Compile to see the PDF here.')}</EmptyState>
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
                                <IconButton
                                  icon="x"
                                  label={t('删除')}
                                  className="annotation-remove"
                                  onClick={() =>
                                    setPdfAnnotations((prev) => prev.filter((item) => item.id !== note.id))
                                  }
                                />
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
                                if (item.page) goToPdfPage(item.page);
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
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <Select
                            ariaLabel={t('选择图片进行预览。')}
                            value={selectedFigure}
                            placeholder={t('选择图片进行预览。')}
                            options={(selectedFigure && !figureFiles.some((item) => item.path === selectedFigure) ? [{ path: selectedFigure }, ...figureFiles] : figureFiles).map((item) => ({ value: item.path, label: item.path }))}
                            onChange={(v) => setSelectedFigure(v)}
                          />
                        </div>
                        {selectedFigure && (
                          <button
                            type="button"
                            className="op-btn op-btn-primary op-btn-sm"
                            onClick={() => insertFigureSnippet(selectedFigure)}
                          >
                            <Icon name="plus" />
                            {t('插入到光标')}
                          </button>
                        )}
                      </div>
                      <div className="figure-display">
                        {selectedFigure ? (
                          selectedFigure.toLowerCase().endsWith('.pdf') ? (
                            <object data={blobUrl(projectId, selectedFigure)} type="application/pdf" />
                          ) : (
                            <img src={blobUrl(projectId, selectedFigure)} alt={selectedFigure} />
                          )
                        ) : (
                          <EmptyState icon="image" title={t('选择图片进行预览。')} />
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
                                <IconButton icon="maximize" label={t('放大')} tipPos="bottom-end" onClick={() => setDiffFocus(change)} />
                              </div>
                              <SplitDiffView rows={rows} />
                              <div className="row">
                                {change.stale && <FieldError message={t('The file changed after this was proposed, so it no longer applies. Ask again.')} />}
                                <button className="op-btn op-btn-primary" disabled={change.stale} onClick={() => applyPending(change)}>{t('应用此修改')}</button>
                                <button className="op-btn op-btn-secondary op-btn-sm" onClick={() => discardPending(change)}>{t('放弃')}</button>
                              </div>
                            </div>
                          );
                        })()
                      ))}
                      {pendingGrouped.length > 1 && (
                        <div className="row">
                          <button className="op-btn op-btn-primary" onClick={() => applyPending()}>{t('应用全部')}</button>
                          <button className="op-btn op-btn-secondary op-btn-sm" onClick={() => discardPending()}>{t('全部放弃')}</button>
                        </div>
                      )}
                    </div>
                  )}
                  {rightView === 'log' && (
                    <div className="log-panel">
                      <div className="log-title">
                        {t('Compile Log')}
                        <button className="op-btn op-btn-secondary op-btn-sm" onClick={diagnoseCompile} disabled={diagnoseBusy}>
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
                        <div className="log-errors-head">{t('{{count}} errors', { count: compileErrors.length })}</div>
                      )}
                      {compileErrors.length > 0 && (
                        <div className="log-errors">
                          {compileErrors.map((error, idx) => (
                            <button
                              key={`${error.message}-${idx}`}
                              className="error-item"
                              onClick={() => jumpToError(error)}
                            >
                              <Icon name="alert-circle" className="error-tag" />
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
          </div>
        </section>

        {rightOpen && !narrowRight && (
          <div
            className="ed-resizer"
            role="separator"
            tabIndex={0}
            aria-orientation="vertical"
            aria-label={t('Resize right panel')}
            aria-valuenow={columnSizes.right}
            aria-valuemin={PANEL_LIMITS.right[0]}
            aria-valuemax={PANEL_LIMITS.right[1]}
            onMouseDown={(event) => startColumnDrag('right', event)}
            onKeyDown={(event) => nudgeColumn('right', event)}
            onDoubleClick={() => resetColumn('right')}
          />
        )}
        {rightOpen && (
          <aside
            className="ed-side ed-side-right"
            style={{ '--w': `${columnSizes.right}px` } as CSSProperties}
            aria-label={t('Right panel')}
          >
            {activeSidebar === 'collab' ? (
              <>
                <PanelHeader
                  title={t('协作')}
                  side="right"
                  onCollapse={() => setRightOpen(false)}
                  collapseLabel={t('Collapse panel')}
                  actions={
                    <Badge
                      tone={collabStatus === 'connected' ? 'success' : collabStatus === 'connecting' ? 'info' : 'neutral'}
                      icon={collabStatus === 'connecting' ? 'loader' : collabStatus === 'connected' ? 'check-circle' : 'info'}
                      spin={collabStatus === 'connecting'}
                    >
                      {collabStatus === 'connected' ? t('已连接') : collabStatus === 'connecting' ? t('连接中...') : t('未连接')}
                    </Badge>
                  }
                />
                <div className="ed-panel-body">
                  <div className="collab-panel">
                    <div className="collab-row">
                      <input
                        className="op-input"
                        value={collabServer}
                        onChange={(e) => setCollabServerState(e.target.value)}
                        placeholder={t('协作服务器地址')}
                      />
                    </div>
                    <div className="collab-row">
                      <input
                        className="op-input"
                        value={collabName}
                        onChange={(e) => setCollabName(e.target.value)}
                        placeholder={t('显示名称')}
                      />
                      <button
                        className="op-btn op-btn-secondary"
                        onClick={() => setCollabEnabled((prev) => !prev)}
                        disabled={!activePath || !isTextPath(activePath)}
                      >
                        {collabEnabled ? t('断开') : t('连接')}
                      </button>
                    </div>
                    {canWrite && !getInviteToken() && projectId && (
                      <InviteLinks
                        projectId={projectId}
                        linkFor={(token) => `${(normalizeServerUrl(collabServer) || window.location.origin).replace(/\/$/, '')}/collab?token=${encodeURIComponent(token)}`}
                        onCreated={() => setCollabEnabled(true)}
                        onStatus={setStatus}
                      />
                    )}
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
                </div>
              </>
            ) : activeSidebar === 'agent' ? (
              <>
                <PanelHeader title={t('Assistant')} side="right" onCollapse={() => setRightOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-tool-top">
                  <SegmentedControl
                    block
                    label={t('Assistant mode')}
                    value={assistantMode}
                    onChange={setAssistantMode}
                    options={[
                      { value: 'chat', label: t('Chat'), icon: 'chat' },
                      { value: 'agent', label: t('Agent'), icon: 'bot' }
                    ]}
                  />
                </div>
                <div className="ed-agent">
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
                    <div className="row chat-control-row">
                      {assistantMode === 'agent' ? (
                        <>
                          <Select size="sm" ariaLabel={t('选择任务')} value={task} options={DEFAULT_TASKS(t)} onChange={(v) => setTask(v)} />
                          <div className="agent-mode-wrap">
                            <Select
                              size="sm"
                              ariaLabel={t('Agent')}
                              value={mode}
                              options={[{ value: 'direct', label: t('Direct') }, { value: 'tools', label: t('Tools') }]}
                              onChange={(v) => setMode(v)}
                            />
                            <span className="info-icon" tabIndex={0} aria-label={t('Direct: 单轮生成 · Tools: 多轮工具调用/多文件修改')}>
                              <Icon name="info" />
                              <span className="tooltip">{t('Direct: 单轮生成 · Tools: 多轮工具调用/多文件修改')}</span>
                            </span>
                          </div>
                        </>
                      ) : (
                        <div className="muted">{t('Chat 模式仅对话，不会改动文件。')}</div>
                      )}
                    </div>
                    {assistantMode === 'agent' && task === 'translate' && (
                      <div className="row chat-control-row">
                        <Select
                          size="sm"
                          ariaLabel={t('翻译')}
                          value={translateScope}
                          options={[
                            { value: 'selection', label: t('选区') },
                            { value: 'file', label: t('当前文件') },
                            { value: 'project', label: t('整个项目') }
                          ]}
                          onChange={(v) => setTranslateScope(v)}
                        />
                        <Select size="sm" ariaLabel={t('翻译')} value={translateTarget} options={translateTargetOptions} onChange={(v) => setTranslateTarget(v)} />
                      </div>
                    )}
                    <textarea
                      className="op-textarea chat-input"
                      value={prompt}
                      onChange={(e) => setPrompt(e.target.value)}
                      placeholder={assistantMode === 'chat' ? t('例如：帮我解释这一段的实验设计。') : t('例如：润色这个段落，使其更符合 ACL 风格。')}
                    />
                    <button onClick={sendPrompt} className="op-btn op-btn-primary op-btn-block">
                      {assistantMode === 'chat' ? t('发送') : t('生成建议')}
                    </button>
                    {selectionText && assistantMode === 'agent' && (
                      <div className="muted">{t('已选择 {{count}} 字符，将用于任务输入', { count: selectionText.length })}</div>
                    )}
                    {assistantMode === 'agent' && task === 'translate' && translateScope === 'selection' && !selectionText && (
                      <div className="muted">{t('翻译选区前请先选择文本。')}</div>
                    )}
                  </div>
                </div>
              </>
            ) : activeSidebar === 'vision' ? (
              <>
                <PanelHeader
                  title={t('图像识别')}
                  side="right"
                  onCollapse={() => setRightOpen(false)}
                  collapseLabel={t('Collapse panel')}
                  actions={<Button variant="ghost" size="sm" onClick={() => setVisionResult('')} disabled={!visionResult}>{t('清空结果')}</Button>}
                />
                <div className="ed-panel-body">
                  <div className="tools-body">
                    <div className="tool-section">
                      <div className="tool-title">{t('图像转 LaTeX')}</div>
                      <div className="field">
                        <label>{t('识别类型')}</label>
                        <Select
                          ariaLabel={t('识别类型')}
                          value={visionMode}
                          options={[
                            { value: 'equation', label: t('公式') },
                            { value: 'table', label: t('表格') },
                            { value: 'figure', label: t('图像 + 图注') },
                            { value: 'algorithm', label: t('算法') },
                            { value: 'ocr', label: t('仅提取文字') }
                          ]}
                          onChange={(v) => {
                            setVisionMode(v);
                            setVisionResult('');
                          }}
                        />
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
                              <IconButton icon="x" label={t('移除')} onClick={(e) => { e.stopPropagation(); setVisionFile(null); setVisionPreviewUrl(''); }} />
                            </div>
                          ) : (
                            <label htmlFor="vision-file-input" className="drop-zone-content">
                              <span className="drop-icon"><Icon name="image" size={24} /></span>
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
                          className="op-input"
                          value={visionPrompt}
                          onChange={(event) => setVisionPrompt(event.target.value)}
                          placeholder={t('例如：只输出 tabular，不要表格标题')}
                          rows={2}
                        />
                      </div>
                      <div className="vision-actions">
                        <button className="op-btn op-btn-secondary" onClick={handleVisionSubmit} disabled={visionBusy}>
                          {visionBusy ? t('识别中...') : t('开始识别')}
                        </button>
                        <button className="op-btn op-btn-primary" onClick={handleVisionInsert} disabled={!visionResult}>{t('插入到光标')}</button>
                      </div>
                      {visionResult && (
                        <div className="vision-result">
                          <div className="muted">{t('识别结果 (可编辑)：')}</div>
                          <textarea
                            className="op-input"
                            value={visionResult}
                            onChange={(event) => setVisionResult(event.target.value)}
                            rows={6}
                          />
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : activeSidebar === 'search' ? (
              <>
                <PanelHeader title={t('论文检索')} side="right" onCollapse={() => setRightOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-panel-body">
                  <div className="tools-body">
                    <div className="tool-section">
                      <div className="tool-title">{t('arXiv 检索')}</div>
                      <div className="field">
                        <label>{t('关键词')}</label>
                        <input
                          className="op-input"
                          value={arxivQuery}
                          onChange={(event) => setArxivQuery(event.target.value)}
                          placeholder={t('例如: diffusion transformer compression')}
                        />
                      </div>
                      <div className="row">
                        <input
                          className="op-input ed-input-narrow"
                          type="number"
                          min={1}
                          max={10}
                          value={arxivMaxResults}
                          onChange={(event) => setArxivMaxResults(Number(event.target.value) || 5)}
                        />
                        <button className="op-btn op-btn-secondary op-btn-sm" onClick={handleArxivSearch} disabled={arxivBusy}>
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
                            className="op-input"
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
                        <Select
                          ariaLabel={t('Bib 文件')}
                          value={bibTarget}
                          options={[{ value: '', label: t('(新建/选择 Bib 文件)') }, ...bibFiles.map((p) => ({ value: p, label: p }))]}
                          onChange={(v) => setBibTarget(v)}
                        />
                        <button className="op-btn op-btn-secondary op-btn-sm" onClick={async () => {
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
                          <Select
                            ariaLabel={t('引用插入目标')}
                            value={citeTargetFile || texFiles[0] || ''}
                            placeholder="main.tex"
                            options={texFiles.map((p) => ({ value: p, label: p }))}
                            onChange={(v) => setCiteTargetFile(v)}
                          />
                        </div>
                      )}
                      <div className="row">
                        <button className="op-btn op-btn-primary" onClick={handleArxivApply} disabled={arxivBusy}>
                          {t('写入 Bib / 插入引用')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : activeSidebar === 'zotero' ? (
              <>
                <PanelHeader title={t('Zotero')} side="right" onCollapse={() => setRightOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-panel-body">
                  <div className="tools-body">
                    <ZoteroPanel
                      projectId={projectId}
                      onInsertCite={(keys) => insertAtCursor(`\\cite{${keys.join(',')}}`)}
                      onAppendLive={async (file, text) => {
                        const live = collabDocRef.current;
                        if (!collabActiveRef.current || !live || file !== activePath) return false;
                        live.doc.transact(() => live.text.insert(live.text.length, `${live.text.toString().endsWith('\n') ? '' : '\n'}\n${text}`));
                        return true;
                      }}
                      onFileChanged={(file) => {
                        void refreshTree();
                        if (file === activePath) void openFile(file);
                      }}
                    />
                  </div>
                </div>
              </>
            ) : activeSidebar === 'comments' ? (
              <>
                <PanelHeader title={t('Comments')} side="right" onCollapse={() => setRightOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-panel-body">
                  <div className="tools-body">
                    <CommentsPanel
                      threads={commentThreads}
                      activePath={activePath}
                      canComment={commentRights.canComment}
                      canModerate={commentRights.canModerate}
                      pending={pendingComment}
                      focusedId={focusedThread}
                      error={commentError}
                      onCreate={async (pending, body) => {
                        const thread = await createCommentThread(projectId, { ...pending, body });
                        setCommentThreads((cur) => [...cur, thread]);
                        setPendingComment(null);
                        setFocusedThread(thread.id);
                      }}
                      onCancelPending={() => setPendingComment(null)}
                      onReply={async (id, body) => replaceThread(await replyToThread(projectId, id, body), id)}
                      onResolve={async (id, resolved) => replaceThread(await setThreadResolved(projectId, id, resolved), id)}
                      onDeleteThread={async (id) => {
                        await deleteThread(projectId, id);
                        replaceThread(null, id);
                      }}
                      onEditComment={async (id, cid, body) => replaceThread(await editComment(projectId, id, cid, body), id)}
                      onDeleteComment={async (id, cid) => replaceThread(await deleteComment(projectId, id, cid), id)}
                      onJump={(thread) => void jumpToThread(thread)}
                    />
                  </div>
                </div>
              </>
            ) : activeSidebar === 'versions' ? (
              <>
                <PanelHeader title={t('Versions')} side="right" onCollapse={() => setRightOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-panel-body">
                  <div className="tools-body">
                    <VersionsPanel
                      projectId={projectId}
                      refreshKey={versionsRefresh}
                      viewingId={showingVersion?.id ?? null}
                      onViewPdf={(version) => void viewVersionPdf(version)}
                      onDeleted={(id) => {
                        if (showingVersion?.id === id) void viewVersionPdf(null);
                      }}
                      onRestore={restoreVersionInEditor}
                      onRestoreFile={restoreFileInEditor}
                      currentPdf={(showingVersion ? showingVersion.backUrl : pdfUrl) || null}
                    />
                  </div>
                </div>
              </>
            ) : activeSidebar === 'websearch' ? (
              <>
                <PanelHeader title={t('Websearch')} side="right" onCollapse={() => setRightOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-panel-body">
                  <div className="tools-body">
                    <div className="tool-section">
                      <div className="tool-title">{t('多点检索')}</div>
                      <div className="field">
                        <label>{t('Query')}</label>
                        <input
                          className="op-input"
                          value={websearchQuery}
                          onChange={(event) => setWebsearchQuery(event.target.value)}
                          placeholder={t('例如: diffusion editing for safety')}
                        />
                      </div>
                      <div className="row">
                        <button className="op-btn op-btn-primary" onClick={runWebsearch} disabled={websearchBusy}>
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
                              className="op-btn op-btn-ghost op-btn-sm"
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
                                  className="op-btn op-btn-ghost op-btn-sm"
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
                                    className="op-input"
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
                            className="op-input"
                            value={websearchParagraph}
                            onChange={(event) => setWebsearchParagraph(event.target.value)}
                            rows={6}
                          />
                        </div>
                      )}
                      <div className="field">
                        <label>{t('Bib 文件')}</label>
                        <Select
                          ariaLabel={t('Bib 文件')}
                          value={websearchTargetBib}
                          options={[{ value: '', label: t('(新建/选择 Bib 文件)') }, ...bibFiles.map((p) => ({ value: p, label: p }))]}
                          onChange={(v) => setWebsearchTargetBib(v)}
                        />
                        <button className="op-btn op-btn-ghost op-btn-sm" onClick={async () => {
                          const created = await createBibFile();
                          if (created) setWebsearchTargetBib(created);
                        }}>{t('新建 Bib')}</button>
                      </div>
                      <div className="field">
                        <label>{t('插入目标 TeX')}</label>
                        <Select
                          ariaLabel={t('插入目标 TeX')}
                          value={websearchTargetFile}
                          placeholder="—"
                          options={texFiles.map((p) => ({ value: p, label: p }))}
                          onChange={(v) => setWebsearchTargetFile(v)}
                        />
                      </div>
                      <div className="row">
                        <button className="op-btn op-btn-primary" onClick={applyWebsearchInsert} disabled={websearchBusy}>
                          {t('一键写入 Bib + 插入总结')}
                        </button>
                      </div>
                    </div>
                  </div>
                </div>
              </>
            ) : activeSidebar === 'plot' ? (
              <>
                <PanelHeader title={t('绘图')} side="right" onCollapse={() => setRightOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-panel-body">
                  <div className="tools-body">
                    <div className="tool-section">
                      <div className="tool-title">{t('表格 → 图表')}</div>
                      <div className="muted">{t('从选区表格生成图表（seaborn）')}</div>
                      <div className="field">
                        <label>{t('图表类型')}</label>
                        <Select
                          ariaLabel={t('图表类型')}
                          value={plotType}
                          options={[
                            { value: 'bar', label: t('Bar') },
                            { value: 'line', label: t('Line') },
                            { value: 'heatmap', label: t('Heatmap') }
                          ]}
                          onChange={(v) => setPlotType(v)}
                        />
                      </div>
                      <div className="field">
                        <label>{t('标题 (可选)')}</label>
                        <input
                          className="op-input"
                          value={plotTitle}
                          onChange={(event) => setPlotTitle(event.target.value)}
                          placeholder={t('Chart title')}
                        />
                      </div>
                      <div className="field">
                        <label>{t('文件名 (可选)')}</label>
                        <input
                          className="op-input"
                          value={plotFilename}
                          onChange={(event) => setPlotFilename(event.target.value)}
                          placeholder="plot.png"
                        />
                      </div>
                      <div className="field">
                        <label>{t('补充提示 (可选)')}</label>
                        <textarea
                          className="op-input"
                          value={plotPrompt}
                          onChange={(event) => setPlotPrompt(event.target.value)}
                          placeholder={t('例如：使用折线图，突出 Method A；加上 legend；设置 y 轴为 Accuracy')}
                          rows={2}
                        />
                      </div>
                      <div className="field">
                        <label>{t('Debug 重试次数')}</label>
                        <input
                          className="op-input"
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
                        <button className="op-btn op-btn-primary" onClick={handlePlotGenerate} disabled={plotBusy}>
                          {plotBusy ? t('生成中...') : t('生成图表')}
                        </button>
                      </div>
                      {plotStatus && <div className="muted">{plotStatus}</div>}
                      {plotAssetPath && (
                        <div className="vision-result">
                          <div className="muted">{t('预览')}</div>
                          <img
                            src={blobUrl(projectId, plotAssetPath)}
                            alt={plotAssetPath}
                            style={{ width: '100%', borderRadius: '8px' }}
                          />
                          <div className="row">
                            <button className="op-btn op-btn-secondary op-btn-sm" onClick={() => insertFigureSnippet(plotAssetPath)}>{t('插入图模板')}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                </div>
              </>
            ) : (
              <>
                <PanelHeader title={t('Review')} side="right" onCollapse={() => setRightOpen(false)} collapseLabel={t('Collapse panel')} />
                <div className="ed-panel-body">
                                  <div className="tools-body">
                                    <div className="tool-section">
                                      <div className="tool-title">{t('质量检查')}</div>
                                      <div className="tool-desc">{t('AI 辅助检查论文质量，发现潜在问题')}</div>
                                      <div className="review-buttons">
                                        <button
                                          type="button" className="review-btn"
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
                                          <span className="review-btn-icon"><Icon name="file-text" size={20} /></span>
                                          <span className="review-btn-label">{t('详细评审报告')}</span>
                                          <span className="review-btn-desc">{t('阅读项目并输出完整审稿意见')}</span>
                                        </button>
                                        <button
                                          type="button" className="review-btn"
                                          onClick={async () => {
                                            const res = await runAgent({
                                              task: 'consistency_check',
                                              prompt: `Read all .tex files in the project using list_files and read_file tools. Perform a thorough consistency check across the entire paper. Check the following dimensions:

                  1. **Terminology consistency**: Identify terms that refer to the same concept but use different wording (e.g., "feature extraction" vs "feature engineering", "model" vs "network" vs "architecture" used interchangeably).

                  2. **Notation consistency**: Check if mathematical symbols and notation are used consistently (e.g., bold for vectors vs non-bold, x vs X for the same variable, inconsistent subscript/superscript conventions).

                  3. **Data and results consistency**: Verify that numbers, statistics, and experimental results mentioned in the abstract, introduction, method, and conclusion sections are consistent with those in tables and figures.

                  4. **Logic and claim consistency**: Check if claims made in the introduction/conclusion are actually supported by the experiments. Flag contradictions between sections.

                  5. **Reference consistency**: Check for undefined abbreviations, references to figures/tables/sections that don't exist, or mislabeled cross-references.

                  6. **Tense and style consistency**: Flag inconsistent use of tense (e.g., mixing past and present when describing experiments) or perspective (e.g., "we" vs "the authors" vs passive voice).

                  For each issue found, report in this format:

                  ---
                  **[Category]** Terminology / Notation / Data / Logic / Reference / Style
                  **[Location]** file and approximate line or section
                  **[Issue]** Describe the inconsistency
                  **[Suggestion]** How to fix it
                  ---

                  Here are examples of good findings:

                  Example 1:
                  **[Terminology]**
                  **[Location]** sections/method.tex, Section 3.1 vs sections/experiments.tex, Section 4
                  **[Issue]** The method section calls the module "Spatial Attention Block" but the experiments section refers to it as "Spatial Attention Module".
                  **[Suggestion]** Unify to one term throughout the paper, e.g., "Spatial Attention Module".

                  Example 2:
                  **[Data]**
                  **[Location]** sections/abstract.tex vs sections/experiments.tex, Table 2
                  **[Issue]** The abstract claims "93.2% accuracy on CIFAR-10" but Table 2 reports 92.8%.
                  **[Suggestion]** Update the abstract to match the actual result in Table 2.

                  Example 3:
                  **[Logic]**
                  **[Location]** sections/introduction.tex, paragraph 3 vs sections/conclusion.tex, paragraph 1
                  **[Issue]** The introduction states the method "does not require pre-training" but the conclusion mentions "after pre-training on ImageNet".
                  **[Suggestion]** Clarify whether pre-training is used and make both sections consistent.

                  Example 4:
                  **[Notation]**
                  **[Location]** sections/method.tex, Eq. (3) vs Eq. (7)
                  **[Issue]** Eq. (3) uses bold lowercase h for hidden states, but Eq. (7) uses non-bold italic h for the same variable.
                  **[Suggestion]** Use bold h consistently for hidden state vectors.

                  Be thorough. Read ALL .tex files before reporting. Group findings by category. If no issues are found in a category, state that explicitly.`,
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
                                          <span className="review-btn-icon"><Icon name="check-circle" size={20} /></span>
                                          <span className="review-btn-label">{t('一致性检查')}</span>
                                          <span className="review-btn-desc">{t('检查术语、符号一致性')}</span>
                                        </button>
                                        <button
                                          type="button" className="review-btn"
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
                                          <span className="review-btn-icon"><Icon name="book-open" size={20} /></span>
                                          <span className="review-btn-label">{t('引用缺失')}</span>
                                          <span className="review-btn-desc">{t('查找需要引用的论述')}</span>
                                        </button>
                                        <button
                                          type="button" className="review-btn"
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
                                          <span className="review-btn-icon"><Icon name="terminal" size={20} /></span>
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
                </div>
              </>
            )}
          </aside>
        )}

        <nav className="op-rail op-rail-right" aria-label={t('Right panel tools')}>
          {RIGHT_TOOLS.map((tool) => (
            <button
              key={tool.id}
              type="button"
              className="op-rail-btn"
              aria-pressed={rightOpen && activeSidebar === tool.id}
              aria-label={tool.label}
              data-tip={tool.label}
              data-tip-pos="left"
              onClick={() => toggleRightTool(tool.id)}
            >
              <Icon name={tool.icon} />
              {tool.id === 'collab' && collabPeers.length > 0 && <span className="op-rail-dot ed-rail-dot-online" aria-hidden="true" />}
            </button>
          ))}
          <div className="op-rail-spacer" />
          <button
            type="button"
            className="op-rail-btn"
            aria-label={t('Toggle right panel (Ctrl Alt B)')}
            data-tip={t('Toggle panel · Ctrl Alt B')}
            data-tip-pos="left"
            onClick={() => setRightOpen((prev) => !prev)}
          >
            <Icon name="panel-right" />
          </button>
        </nav>

        {overlayOpen && (
          <div
            className="ed-scrim"
            onClick={() => {
              if (narrowLeft) setLeftOpen(false);
              if (narrowRight) setRightOpen(false);
            }}
          />
        )}
      </main>

      <footer className="ed-statusbar">
        <span className="op-truncate ed-status-text" aria-live="polite">{status}</span>
        <div className="op-fill" />
        <button
          type="button"
          className={`ed-save ${isSaving ? 'saving' : isDirty ? 'dirty' : 'saved'} ${savePulse ? 'pulse' : ''}`}
          onClick={() => void saveActiveFile()}
          aria-label={t('保存')}
        >
          <Icon name={isSaving ? 'loader' : isDirty ? 'pencil' : 'cloud-check'} className={isSaving ? 'op-spin' : ''} />
          {isSaving ? t('保存中...') : isDirty ? t('未保存') : t('已保存')}
        </button>
        <span className="op-hide-sm">{ENGINE_LABELS[compileEngine] || compileEngine}</span>
        <span className="op-hide-sm">{t('Engine')}: {engineName || t('未初始化')}</span>
        <IconButton icon="panel-left" label={t('Toggle left panel (Ctrl B)')} aria-pressed={leftOpen} tipPos="bottom-end" onClick={() => setLeftOpen((prev) => !prev)} tip={false} />
        <IconButton icon="panel-right" label={t('Toggle right panel (Ctrl Alt B)')} aria-pressed={rightOpen} onClick={() => setRightOpen((prev) => !prev)} tip={false} />
      </footer>

      {fileContextMenu && (
        <Menu
          point={fileContextMenu}
          label={t('Files')}
          onClose={() => setFileContextMenu(null)}
          items={[
            { type: 'label', label: t('创建') },
            { label: t('新建文件'), icon: 'file-plus', onSelect: () => beginInlineCreate('new-file') },
            { label: t('新建文件夹'), icon: 'folder-plus', onSelect: () => beginInlineCreate('new-folder') },
            { label: t('新建 Bib'), icon: 'book', onSelect: () => void createBibFile() },
            { type: 'sep' },
            { type: 'label', label: t('上传') },
            { label: t('上传文件'), icon: 'upload', onSelect: () => fileInputRef.current?.click() },
            { label: t('上传文件夹'), icon: 'folder-up', onSelect: () => folderInputRef.current?.click() },
            { type: 'sep' },
            { label: t('展开全部'), icon: 'chevron-down', onSelect: () => setAllFolders(true) },
            { label: t('收起全部'), icon: 'chevron-right', onSelect: () => setAllFolders(false) },
            { label: t('重命名'), icon: 'pencil', onSelect: () => beginInlineRename() },
            { label: t('刷新'), icon: 'refresh', onSelect: () => void refreshTree() },
            { type: 'sep' },
            { label: t('删除'), icon: 'trash', danger: true, onSelect: () => void handleDeleteFile() }
          ]}
        />
      )}
      {settingsOpen && (
        <Modal
          title={t('AI & search settings')}
          description={t('Model endpoints and keys are stored in this browser only.')}
          size="lg"
          closeLabel={t('关闭')}
          onClose={() => setSettingsOpen(false)}
          footer={
            <>
              <Button variant="ghost" onClick={() => setSettingsOpen(false)}>{t('关闭')}</Button>
              <Button variant="primary" onClick={() => setSettingsOpen(false)}>{t('完成')}</Button>
            </>
          }
        >
          <div className="ed-settings">
            {workspaceProvider && (
              <div className="muted" role="note" data-testid="workspace-provider-notice">
                {t('This workspace provides the AI provider{{model}}. Your own key is not used for its projects.', { model: workspaceProvider.model ? ` (${workspaceProvider.model})` : '' })}
              </div>
            )}
            <div className="field">
              <label>{t('LLM Endpoint')}</label>
              <input
                className="op-input"
                value={llmEndpoint}
                onChange={(e) => setSettings((prev) => ({ ...prev, llmEndpoint: e.target.value }))}
                placeholder={t('Server default')}
              />
              <div className="muted">{t('支持 OpenAI 兼容的 base_url，例如 https://api.apiyi.com/v1')}</div>
            </div>
            <div className="field">
              <label>{t('LLM Model')}</label>
              <input
                className="op-input"
                value={llmModel}
                onChange={(e) => setSettings((prev) => ({ ...prev, llmModel: e.target.value }))}
                placeholder={t('Server default')}
              />
            </div>
            <div className="field">
              <label>{t('LLM API Key')}</label>
              <input
                className="op-input"
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
                className="op-input"
                value={searchEndpoint}
                onChange={(e) => setSettings((prev) => ({ ...prev, searchEndpoint: e.target.value }))}
                placeholder="https://api.apiyi.com/v1"
              />
              <div className="muted">{t('仅用于“检索/websearch”任务，留空则复用 LLM Endpoint。')}</div>
            </div>
            <div className="field">
              <label>{t('Search LLM Model (可选)')}</label>
              <input
                className="op-input"
                value={searchModel}
                onChange={(e) => setSettings((prev) => ({ ...prev, searchModel: e.target.value }))}
                placeholder="claude-sonnet-4-5-20250929-all"
              />
            </div>
            <div className="field">
              <label>{t('Search LLM API Key (可选)')}</label>
              <input
                className="op-input"
                value={searchApiKey}
                onChange={(e) => setSettings((prev) => ({ ...prev, searchApiKey: e.target.value }))}
                placeholder="sk-..."
                type="password"
              />
            </div>
            <div className="field">
              <label>{t('VLM Endpoint (可选)')}</label>
              <input
                className="op-input"
                value={visionEndpoint}
                onChange={(e) => setSettings((prev) => ({ ...prev, visionEndpoint: e.target.value }))}
                placeholder="https://api.apiyi.com/v1"
              />
              <div className="muted">{t('仅用于图像识别，留空则复用 LLM Endpoint。')}</div>
            </div>
            <div className="field">
              <label>{t('VLM Model (可选)')}</label>
              <input
                className="op-input"
                value={visionModel}
                onChange={(e) => setSettings((prev) => ({ ...prev, visionModel: e.target.value }))}
                placeholder="gpt-4o"
              />
            </div>
            <div className="field">
              <label>{t('VLM API Key (可选)')}</label>
              <input
                className="op-input"
                value={visionApiKey}
                onChange={(e) => setSettings((prev) => ({ ...prev, visionApiKey: e.target.value }))}
                placeholder="sk-..."
                type="password"
              />
            </div>
          </div>
        </Modal>
      )}
      {diffFocus && (
        <Modal title={`${t('Diff')} · ${diffFocus.filePath}`} size="xl" closeLabel={t('关闭')} onClose={() => setDiffFocus(null)}>
          <div className="diff-modal-body">
            <SplitDiffView rows={buildSplitDiff(diffFocus.original, diffFocus.proposed)} />
          </div>
        </Modal>
      )}
    </div>
  );
}
