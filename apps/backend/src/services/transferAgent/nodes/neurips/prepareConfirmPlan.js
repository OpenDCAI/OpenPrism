import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';

/**
 * Sets pending QA before consumeConfirmPlan (graph interrupts before consume).
 */
export async function prepareConfirmPlan(state) {
  const plan = state.transferPlan || {};
  const profile = state.sourceProfile || {};

  const pendingQA = [
    {
      id: 'float_strategy',
      prompt: '源稿含双栏通栏图 (figure*/table*) 或自定义浮动体策略。迁移时如何处理？',
      type: 'single',
      options: [
        '改为 NeurIPS 单栏 figure/table（推荐）',
        '尽量保留结构，我稍后手动改',
      ],
    },
    {
      id: 'bibliography_strategy',
      prompt: `检测到文献机制倾向：${profile.bibMechanism || 'unknown'}。是否按 NeurIPS 模板默认 thebibliography / BibTeX 路径收敛？`,
      type: 'single',
      options: [
        '是，按模板与 neurips.md 收敛',
        '否，保留现有 .bbl / biblatex 结构并仅做最小修补',
      ],
    },
    {
      id: 'content_drop',
      prompt: '迁移计划中有 drop/merge 段落时，是否允许删除源稿中无法映射的小节？',
      type: 'single',
      options: [
        '不允许删除正文；无法映射则合并到最近小节',
        '允许按计划在极少数情况 drop（我会在 QA 后检查）',
      ],
    },
  ];

  if (plan.notes) {
    pendingQA.push({
      id: 'plan_notes_ack',
      prompt: `Planner notes（请确认已理解）:\n${plan.notes.slice(0, 1200)}`,
      type: 'single',
      options: ['已理解并继续', '暂停，我先改源项目'],
    });
  }

  return {
    pendingQA,
    status: 'waiting_confirm',
    ...progressUpdate(
      'prepareConfirmPlan',
      NeuripsPhase.qa_plan,
      `Prepared ${pendingQA.length} confirmation question(s).`,
    ),
  };
}
