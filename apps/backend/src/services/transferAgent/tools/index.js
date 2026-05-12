/**
 * Agent tools registry.
 *
 * Creates all tools bound to a specific job context (workspace roots, jobId).
 * Returns an array of DynamicStructuredTool instances ready for bind_tools().
 */

import { createReadFileTool } from './readFile.js';
import { createWriteFileTool } from './writeFile.js';
import { createApplyDiffTool } from './applyDiff.js';
import { createGrepFileTool } from './grepFile.js';
import { createListProjectTreeTool } from './listProjectTree.js';
import { createCopyAssetTool } from './copyAsset.js';
import { createRaiseQuestionTool } from './raiseQuestion.js';
import { createMeasureFiguresTool } from './measureFigures.js';
import { createCompileProjectTool } from './compileProject.js';

/**
 * @param {object} ctx
 * @param {string} ctx.sourceReadRoot  — absolute path to source project
 * @param {string} ctx.workspaceRoot   — absolute path to target workspace
 * @param {string} ctx.jobId           — transfer job ID (for snapshots)
 * @param {string} [ctx.targetProjectId] — for compileProject
 * @param {string} [ctx.targetMainFile]  — for compileProject
 * @param {string} [ctx.engine]          — user-selected LaTeX engine
 * @param {object} [ctx.llmConfig]       — for compile log summarization
 * @returns {import('@langchain/core/tools').DynamicStructuredTool[]}
 */
export function createAllTools(ctx) {
  return [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createApplyDiffTool(ctx),
    createGrepFileTool(ctx),
    createListProjectTreeTool(ctx),
    createCopyAssetTool(ctx),
    createRaiseQuestionTool(ctx),
    createMeasureFiguresTool(ctx),
    createCompileProjectTool(ctx),
  ];
}

/**
 * Create a subset of tools (read-only) for Planner and Reviewer nodes.
 * These nodes should NOT write files or apply diffs.
 */
export function createReadOnlyTools(ctx) {
  return [
    createReadFileTool(ctx),
    createGrepFileTool(ctx),
    createListProjectTreeTool(ctx),
    createRaiseQuestionTool(ctx),
    createCompileProjectTool(ctx),
  ];
}

/**
 * Create the full tool set for the Generator node.
 * Generator can read, write, diff, copy, and grep.
 */
export function createGeneratorTools(ctx) {
  return [
    createReadFileTool(ctx),
    createWriteFileTool(ctx),
    createApplyDiffTool(ctx),
    createGrepFileTool(ctx),
    createListProjectTreeTool(ctx),
    createCopyAssetTool(ctx),
    createMeasureFiguresTool(ctx),
    createCompileProjectTool(ctx),
  ];
}

/**
 * Create tools for the Reviewer node.
 * Reviewer can read, grep, list, but also raiseQuestion for user confirmations.
 */
export function createReviewerTools(ctx) {
  return [
    createReadFileTool(ctx),
    createGrepFileTool(ctx),
    createListProjectTreeTool(ctx),
    createRaiseQuestionTool(ctx),
    createCompileProjectTool(ctx),
  ];
}
