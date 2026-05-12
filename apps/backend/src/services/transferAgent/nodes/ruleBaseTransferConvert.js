import path from 'path';
import { NeuripsPhase, progressUpdate } from '../progressMeta.js';
import { runConversion } from '../rulebasetransfer/pipeline.js';
import { DATA_DIR, TEMPLATE_DIR } from '../../../config/constants.js';

export async function ruleBaseTransferConvert(state) {
  const sourceDir = path.join(DATA_DIR, state.sourceProjectId);
  const targetTemplateDir = path.join(TEMPLATE_DIR, state.targetTemplateId);
  const outputDir = path.join(DATA_DIR, state.targetProjectId);
  const outputMainName = state.targetMainFile || 'main.tex';

  let result;
  try {
    result = await runConversion({
      sourceDir,
      targetTemplateDir,
      outputDir,
      outputMainName,
    });
  } catch (err) {
    const message = err?.message || String(err || 'Rule-based transfer conversion failed');
    return {
      error: message,
      status: 'failed',
      ...progressUpdate(
        'ruleBaseTransferConvert',
        NeuripsPhase.body,
        `Rule-based transfer 转换失败：${message}`,
        'error',
      ),
    };
  }

  const relativeMainTex = path.relative(outputDir, result.mainTex);
  const summaryParts = [
    `target=${result.targetKind}`,
    `main=${relativeMainTex}`,
    result.warnings.length ? `warnings=${result.warnings.length}` : 'warnings=0',
  ];

  const extraEntries = result.warnings.map((message) => ({
    node: 'ruleBaseTransferConvert',
    level: 'warn',
    message,
    ts: Date.now(),
  }));

  const base = progressUpdate(
    'ruleBaseTransferConvert',
    NeuripsPhase.body,
    `Rule-based transfer 规则转换完成（${summaryParts.join(', ')}）`,
    'info',
  );

  return {
    ...base,
    progressLogEntries: [...base.progressLogEntries, ...extraEntries],
  };
}
