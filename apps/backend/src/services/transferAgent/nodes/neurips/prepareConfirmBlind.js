import { NeuripsPhase, progressUpdate } from '../../progressMeta.js';

export async function prepareConfirmBlind(state) {
  const intake = state.transferIntake || {};
  if (intake.doubleBlind === false || intake.preprint) {
    return {
      pendingQA: null,
      status: 'running',
      ...progressUpdate(
        'prepareConfirmBlind',
        NeuripsPhase.blind,
        'Skipped blind QA (preprint or non-double-blind).',
      ),
    };
  }

  const pendingQA = [
    {
      id: 'anon_citations',
      prompt: '参考文献中是否可能存在可识别本人/本组的条目，需要匿名化或改为第三人称引用？',
      type: 'single',
      options: [
        '需要，请按 neurips.md 双盲条款尽量匿名化文内与文献表',
        '不需要，源稿已匿名',
      ],
    },
    {
      id: 'self_referential',
      prompt: '正文是否包含 “our previous work” / 项目主页 / GitHub 等可识别链接？',
      type: 'single',
      options: [
        '有，请改写为匿名表述或删除链接',
        '无或已处理',
      ],
    },
  ];

  return {
    pendingQA,
    status: 'waiting_confirm',
    ...progressUpdate(
      'prepareConfirmBlind',
      NeuripsPhase.blind_qa,
      'Blind compliance questions ready.',
    ),
  };
}
