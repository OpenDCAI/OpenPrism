# CVPR Venue Rules (OpenPrism)

This file is the venue handbook loaded by the transfer agent for `cvpr`.

## Core constraints

1. Use the official CVPR template and style files as-is.
2. Do not modify `cvpr.sty`.
3. Keep the required two-column paper layout.
4. Preserve figure/table semantics:
   - Use `figure*` / `table*` for full-width content.
   - Keep captions and references consistent.
5. Preserve all scientific content (math, citations, labels, references).
6. Keep bibliography and citation behavior consistent with CVPR template defaults.
7. Respect review anonymity when double blind is required:
   - Remove author-identifying names, affiliations, and identifying URLs.
   - Keep self-citations in third-person style.

## Migration guidance

- Prefer minimal, surgical changes over rewrites.
- Do not introduce custom layout hacks that conflict with template style.
- Ensure all referenced assets exist and paths are valid.
- Keep source structure and intent unless strict venue compliance requires adaptation.
# CVPR 2026 LaTeX 排版与投稿规则（仓库内版本）

本文件用于 transferAgent 的 CVPR skill 规则注入。以本仓库 `cvpr/` 模板内容为基准（`main.tex`、`preamble.tex`、`cvpr.sty`、`sec/2_formatting.tex`）。

## 1) 文档骨架与样式

- 文档类应为：
  - `\documentclass[10pt,twocolumn,letterpaper]{article}`
- 样式包应使用：
  - 审稿：`\usepackage[review]{cvpr}`
  - 终版：`\usepackage{cvpr}`
  - 预印本（强制页码）：`\usepackage[pagenumbers]{cvpr}`
- 不要修改 `cvpr.sty`。
- 保持双栏（two-column）与 letterpaper 配置，不要用 `geometry` 覆盖模板版式。

## 2) 页面与版式约束（来自模板 formatting 指南）

- 所有正文内容必须双栏排版。
- 文本区尺寸、栏宽、栏间距、上下边距等应由模板控制，不手工硬改。
- 审稿版应有页码；终版不应显示页码（由模板选项自动处理）。

## 3) 标题、作者与匿名

- review 模式下必须满足匿名要求：不暴露作者身份信息、机构信息和可识别链接（除非用户明确要求保留）。
- camera-ready 模式允许显示作者与机构。

## 4) 图表与浮动体

- CVPR 为双栏：
  - 单栏图用 `figure`
  - 跨双栏图用 `figure*`
  - 表格同理 `table` / `table*`
- 不要全局把 `figure*`/`table*` 强制改成单栏版本。
- `\includegraphics` 路径必须有效，资源文件应存在于目标工程。

## 5) 公式、交叉引用、脚注

- 保留数学内容与编号体系；避免破坏 `\label/\ref/\cref`。
- 交叉引用建议使用模板习惯（如 `\cref`）。
- 脚注尽量克制，避免影响主文流。

## 6) 参考文献

- 采用 CVPR 模板推荐的参考文献流程，常见形式：
  - `\bibliographystyle{ieeenat_fullname}`
  - `\bibliography{main}`（或项目实际 bib 文件名）
- 引用风格为数字引用流程，引用与参考文献条目要一致可编译。
- 若源文使用 `biblatex`，迁移时需改为 CVPR 兼容流程（natbib 路径）。

## 7) hyperref 与辅助内容

- 建议保留 `hyperref`（模板示例含 `pagebackref` 等），仅在严重编译冲突时临时关闭。
- 主文提交时不要默认内联 supplementary 页面（如 `sec/X_suppl`），除非用户明确要求。

## 8) 迁移执行要求（给 Agent）

- 先读源与目标主文件，再执行迁移。
- 优先保留语义完整性：章节、图表、公式、引用不丢失。
- 对小改动优先 `applyDiff`，大改动用 `writeFile`。
- 每次关键修改后重新读取文件验证。
- 对二义性决策优先保守策略，必要时提问用户确认。
