import { Annotation } from '@langchain/langgraph';

const replace = (_, b) => b;
const appendList = (a, b) => [...(a || []), ...(Array.isArray(b) ? b : [b])];

export const TransferState = Annotation.Root({
  // --- Inputs ---
  sourceProjectId: Annotation({ reducer: replace }),
  sourceMainFile: Annotation({ reducer: replace }),
  targetProjectId: Annotation({ reducer: replace }),
  targetMainFile: Annotation({ reducer: replace }),
  targetTemplateId: Annotation({ reducer: replace }),
  engine: Annotation({ reducer: replace, default: () => 'pdflatex' }),
  maxCompileLoops: Annotation({ reducer: replace, default: () => 5 }),
  maxLayoutLoops: Annotation({ reducer: replace, default: () => 3 }),
  layoutCheck: Annotation({ reducer: replace, default: () => false }),
  llmConfig: Annotation({ reducer: replace }),
  jobId: Annotation({ reducer: replace }),

  /** 'legacy' | 'neurips' — selects LangGraph topology */
  transferGraphKind: Annotation({ reducer: replace, default: () => 'legacy' }),

  // --- Workspace roots (explicit tool boundary) ---
  workspaceRoot: Annotation({ reducer: replace }),
  sourceReadRoot: Annotation({ reducer: replace }),

  // --- Intake (POST /transfer/start); no network tools ---
  transferIntake: Annotation({
    reducer: replace,
    default: () => ({
      venue: '',
      doubleBlind: true,
      preprint: false,
      outputNotes: '',
    }),
  }),

  // --- Source analysis ---
  sourceProjectRoot: Annotation({ reducer: replace }),
  sourceOutline: Annotation({ reducer: replace }),
  sourceFullContent: Annotation({ reducer: replace }),
  sourceAssets: Annotation({ reducer: replace }),
  sourceProfile: Annotation({ reducer: replace }),

  // --- Target analysis ---
  targetProjectRoot: Annotation({ reducer: replace }),
  targetOutline: Annotation({ reducer: replace }),
  targetPreamble: Annotation({ reducer: replace }),
  targetTemplateContent: Annotation({ reducer: replace }),

  // --- Transfer plan ---
  transferPlan: Annotation({ reducer: replace }),

  // --- Human QA ---
  pendingQA: Annotation({ reducer: replace }),
  userConfirmations: Annotation({ reducer: replace, default: () => ({}) }),

  // --- UI / progress (API surfaces these) ---
  lastCompletedNode: Annotation({ reducer: replace, default: () => '' }),
  currentPhase: Annotation({ reducer: replace, default: () => '' }),
  /** Next node name when graph paused (interrupt-before); filled by route on GraphInterrupt */
  interruptedBeforeNode: Annotation({ reducer: replace, default: () => '' }),
  completedNodes: Annotation({ reducer: appendList, default: () => [] }),
  progressLogEntries: Annotation({ reducer: appendList, default: () => [] }),

  // --- Compile loop ---
  compileResult: Annotation({ reducer: replace }),
  compileAttempt: Annotation({ reducer: replace, default: () => 0 }),
  verifyBuildResult: Annotation({ reducer: replace }),
  lastGoodPhase: Annotation({ reducer: replace }),
  buildFailureReason: Annotation({ reducer: replace }),

  // --- Layout check ---
  pageImages: Annotation({ reducer: replace }),
  layoutCheckResult: Annotation({ reducer: replace }),
  layoutAttempt: Annotation({ reducer: replace, default: () => 0 }),

  // --- Figure measurement (normalizeFigures) ---
  figureMeasurement: Annotation({ reducer: replace }),

  // --- MinerU pipeline ---
  transferMode: Annotation({ reducer: replace, default: () => 'legacy' }),
  mineruConfig: Annotation({ reducer: replace }),
  sourcePdfPath: Annotation({ reducer: replace }),
  sourceMarkdown: Annotation({ reducer: replace }),
  sourceImages: Annotation({ reducer: replace }),
  mineruOutputDir: Annotation({ reducer: replace }),

  // --- Agentic loop (neurips-agent graph) ---
  /** LLM message history for the agentic loop (accumulated across iterations) */
  agentMessages: Annotation({ reducer: appendList, default: () => [] }),
  /** Current Planner→Generator→Reviewer iteration (0-based) */
  currentIteration: Annotation({ reducer: replace, default: () => 0 }),
  /** Maximum allowed iterations before forced finalize */
  maxIterations: Annotation({ reducer: replace, default: () => 5 }),
  /** Structured migration plan produced by Planner */
  migrationPlan: Annotation({ reducer: replace }),
  /** Review result from Reviewer: { verdict: 'pass'|'revise', issues: [], suggestions: [] } */
  reviewResult: Annotation({ reducer: replace }),
  /** Current agent phase: 'planning' | 'generating' | 'reviewing' | 'finalized' */
  agentPhase: Annotation({ reducer: replace, default: () => 'planning' }),

  // --- Final output ---
  finalPdf: Annotation({ reducer: replace }),
  status: Annotation({ reducer: replace, default: () => 'pending' }),
  error: Annotation({ reducer: replace }),
  progressLog: Annotation({ reducer: appendList, default: () => [] }),
  bundleNotes: Annotation({ reducer: replace }),
});
