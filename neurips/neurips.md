# NeurIPS 2026 格式与写作完整手册

本文档是团队撰写 **NeurIPS 2026 LaTeX 版式** 论文时的**唯一必读说明**。所有版式约束、写作与提交注意事项均汇总于此；与会议当年政策冲突时，以 [NeurIPS 官网](https://neurips.cc) 为准。

**行号与预印本的关系（易混点）**：**带左侧行号的是匿名投稿默认模式，不是预印本。** 预印本 `\usepackage[preprint]{neurips_2026}` **不加载行号**，且显示真实作者。本仓库 [`neurips_paper_template.tex`](neurips_paper_template.tex) 当前使用 **默认** `\usepackage{neurips_2026}`：**双盲匿名**、**有行号**、页脚为 “Submitted to … Do not distribute.”，`ack` 在 PDF 中**会被隐藏**（定稿录用后再打开）。

---

## 1. 文件清单与编译

| 文件 | 用途 |
|------|------|
| [`neurips_2026.sty`](neurips_2026.sty) | **唯一支持的** NeurIPS 2026 样式包（LaTeX2e）；勿使用 LaTeX 2.09、Word、RTF 等旧模板。 |
| [`neurips_paper_template.tex`](neurips_paper_template.tex) | 论文主入口：默认匿名投稿（**带行号**）；见 §2 改为预印本；`\input` 拆分与顺序见 **§4.5**。 |
| [`checklist.tex`](checklist.tex) | NeurIPS 论文清单正文；**向会议正式投稿时**缺少会导致 **desk rejection**（见 §19）。 |

- **编译**：用 **pdflatex** 直接生成 PDF。
- **纸张**：**US Letter**，不得用 A4。
- **禁止**：修改 `neurips_2026.sty` 中的版心宽高、字号等参数；**擅自改样式可导致 desk rejection**。
- **样式来源**：每年最新文件见 [https://neurips.cc](https://neurips.cc)；本地 `neurips_2026.sty` 应与官网同步更新。

### 1.5 从其它 LaTeX 版式迁入（RevTeX / 双栏 / 其它会议稿）

从 **RevTeX、双栏 `twocolumn`、其它 `documentclass`** 迁到 **`article` + `neurips_2026`** 时，建议按下面逐项核对（避免版式混用与编译炸雷）。

| 来源习惯 | NeurIPS 仓库做法 |
|----------|------------------|
| `\documentclass{revtex4-1}` 等 | 改为 `\documentclass{article}`，**仅**通过 `\usepackage[…]{neurips_2026}` 控制版式。 |
| `\affiliation`、`\email`、期刊专用 `\maketitle` | 不用；改用模板里的 `\author{...}`（匿名默认下 PDF 仍显示占位，见 §2、§6）。 |
| 自定义 `\oddsidemargin`、`\textwidth`、`geometry`（改版心） | **删除**；版心由 `neurips_2026.sty` 与 `geometry` 选项决定，**勿改 sty 内几何参数**（见 §14）。 |
| `figure*` / 双栏通栏图 | NeurIPS 主文为**单栏**，一般用 `\begin{figure}`；通栏环境常可删或改为单栏图。 |
| `table*` | 同上，优先单栏 `table`。 |
| `\bibliographystyle{apsrev4-1}` + `.bbl` | 可保留 **已生成的 `.bbl`** 用 `\input{...bbl}` + `natbib`（注意数字/作者–年份与 `\bibitem` 一致，见 §3）；或改 **`.bib` + BibTeX + `plainnat` 等** 重建文献表。 |
| `\usepackage{hyperref}` 顺序 | 放在导言区**靠后**（在 `amsmath`、`graphicx` 等之后较稳妥）。**匿名稿**建议 `\hypersetup{pdfauthor={}}`，避免 PDF 元数据泄露。 |
| 行间公式用 **`$$ … $$`** | **改为** `equation` / `align` 等；**匿名投稿带行号**时 `$$` 易与 `lineno` 不同步（见 §13）。 |
| `natbib` 与样式冲突 | 使用 `\usepackage[nonatbib]{neurips_2026}`（或 `[preprint,nonatbib]`），自行处理 `\cite` 与文献表（见 §3）。 |
| **双盲**：参考文献表中出现可识别姓名 | 按会议当年政策处理（如匿名化条目、补充匿名版文献表）；**勿**仅改首页作者而保留文末实名文献（见 §9.2）。 |

迁入后应用 **`pdflatex` 连续编译 2 遍**（或按需更多遍）核对交叉引用与引用编号。

---

## 2. 匿名投稿（默认，带行号）与预印本（`preprint`，无行号）

### 2.1 匿名投稿默认（本仓库模板当前用法）

```latex
\usepackage{neurips_2026}
```

（与 `\usepackage[main]{neurips_2026}` 等价：主会、双盲。）

- 首页页脚为 **Submitted to … NeurIPS … Do not distribute.**（以 `neurips_2026.sty` 为准）。
- **启用左侧行号**（`lineno`），便于审稿；**不要**在正文里引用这些行号（终版会去掉）。
- 标题页作者显示为 **Anonymous Author(s)** 占位；正文须**双盲**写作（见 §9.2）。
- **`ack` 环境不会出现在 PDF 中**（被样式清空），致谢与资助披露留在录用后的 camera-ready。

其它轨道（投稿前将 `main` 换成对应选项）：`position`、`eandd`（可加 `nonanonymous`）、`creativeai`、`sglblindworkshop`、`dblblindworkshop`（workshop 须 `\workshoptitle{...}`）。**向会议投稿时不要使用 `preprint`。**

### 2.2 预印本 `preprint`（无行号，非匿名）

```latex
\usepackage[preprint]{neurips_2026}
```

- **不启用行号**；生成**非匿名** PDF，可挂 arXiv 等。
- 页脚为 **“Preprint.”**（以当前 `neurips_2026.sty` 为准）。
- **`ack` 会正常排版**。
- **不得**对未录用稿使用 **`final`**；预印本分发时**不要**写明投往哪一次会议。
- 若与 `natbib` 冲突：`\usepackage[preprint,nonatbib]{neurips_2026}`。

**录用后 camera-ready**：在对应轨道上使用 **`final`**（例如 `\usepackage[main,final]{neurips_2026}`），**不要**继续用匿名默认或 `preprint`。

---

## 3. `natbib` 与包冲突

- 默认由 `neurips_2026` **自动加载 `natbib`**。
- 引用可采用 **作者-年份** 或 **数字编号**，**全文必须统一**；参考文献列表的格式任选一种，**全文一致**即可。
- 在加载 `neurips_2026` **之前**为 `natbib` 传参：

```latex
\PassOptionsToPackage{numbers,compress}{natbib}
```

**区间压缩与排序**：需要正文里出现类似 **`[3, 20--23]`**（连续编号被压成区间）时，在**同一处 `\cite{a,b,c,...}`** 内，文献编号需按顺序才能合并；可增加 **`sort`**，例如：

```latex
\PassOptionsToPackage{numbers,compress,sort}{natbib}
```

（须在 `\usepackage{neurips_2026}` **之前**书写。）

**作者–年份 vs 数字**：全文只能选一种。**不**加 `numbers` 时，`natbib` 默认偏作者–年份，叙述多用 `\citet`、括号引用用 `\citep`（见 §9）。物理/天文稿常习惯**数字**引用；许多 ML 稿习惯**作者–年份**——转投时统一改 `\PassOptionsToPackage` 并检查全文语气（如是否改用 “Author et al.”）。

- 若与其它宏包冲突，使用（按你当前是否预印本二选一）：

```latex
\usepackage[nonatbib]{neurips_2026}
% 或
\usepackage[preprint,nonatbib]{neurips_2026}
```

并自行处理参考文献与 `\cite` 类命令。

样式包官方列出的主要选项还包括：`final`、`preprint`、`nonatbib`；轨道类选项见 §20。

---

## 4. 页数与「不计页」部分

- 正文（主内容）最多 **9 页**，**含图**。**超过 9 页的稿件不予审稿**（亦不作任何其它考虑）。
- **不计入**这 9 页的内容：**致谢**、**参考文献**、**NeurIPS Paper Checklist**、**可选技术附录**（additional pages）。

### 4.5 主文件分工（`neurips_paper_template.tex`）与 `\input` 拆分

- **编译入口**：约定以 [`neurips_paper_template.tex`](neurips_paper_template.tex) 为 **`pdflatex` 唯一主文件**（与会议「单 PDF 投稿」一致）。
- **单文件 vs 拆分**：长稿可将章节拆成 `\input{sections/introduction.tex}` 等，**导言区**（`\usepackage`、`\newcommand`、`\graphicspath`）仍放在主文件；**勿**在子文件里重复 `\documentclass` / `\usepackage{neurips_2026}`。
- **推荐顺序**（与当前模板一致，可按需插入附录）：`\maketitle` → `\begin{abstract}...\end{abstract}` → 正文（含图表）→ 需要时用 **`\clearpage`** 清空浮动体再进入不计页部分 → `\begin{ack}...\end{ack}`（匿名默认下 PDF **不显示**）→ `\section*{References}` → **`\newpage`** → `\input{checklist.tex}`。若有 **附录**：放在参考文献之后、checklist 之前或按当年投稿系统说明调整；附录**不计入** 9 页主文上限，但主文须自洽（见 §18）。
- **补充材料**：额外图表/证明/代码等按官网要求打 **ZIP**；**不要**再单独传「仅附录 PDF」替代主文（见 §18）。
- **资源路径**：图数据可放在子目录，用 `\graphicspath{{./figures/}{../other/}}` 统一引用，避免硬编码过长路径。

---

## 5. 总体版式与字体（General formatting）

- 正文须落在宽 **5.5 英寸**（33 picas）、高 **9 英寸**（54 picas）的矩形内；**左边距 1.5 英寸**（9 picas）。
- 正文 **10 pt**，行距（leading）**11 pt**；**Times New Roman** 为首选，样式默认会选用对应字体。
- **段落**：段间距 **半行**（5.5 pt），**无首行缩进**。
- **论文题目**：约 **17 pt**，**首词大写、其余小写**（initial caps/lower case），**粗体居中**；**上下各一条横线**，上规则 **4 pt**，下规则 **1 pt**；题目与线之间留白约 **1/4 英寸**。
- 页面正文区域从页顶向下约 **1 英寸**（6 picas）起算。
- **最终稿 / 非匿名作者区**：作者姓名为**粗体**，每位作者居中于对应单位之上；**第一作者**排在最左；若仅一位合作者且单位不同，可并排列出。

---

## 6. 标题与 `\author`

- **匿名投稿默认**：PDF 上仍为占位作者；请在源码里写真实 `\author{...}`（录用后 `final` 会排版出来），且**正文不得泄露身份**。
- **预印本 `preprint`**：PDF 上显示真实 `\author{...}`。
- 多作者分隔：`\And` 由 LaTeX 决定换行；若需强制换行，在相应位置用 `\AND`。
- **`\thanks{...}`**：用于作者补充信息（主页、备用地址等），**不用于**致谢资助机构；资助与利益冲突见 `ack` 与官方披露页。

---

## 7. 摘要（Abstract）

- 词 **Abstract** 须 **居中、粗体、约 12 pt**。
- 摘要前约 **两行**空距。
- 摘要正文：**左右各缩进约半英寸**（3 picas）；**10 pt**，行距 **11 pt**（与正文 leading 一致）。
- **仅限一段**，不得多段。

---

## 8. 章节标题

- 各级标题一般为 **小写**（句首与专有名词除外）、**左齐**、**粗体**。
- **一级** `\section`：**12 pt**。
- **二级** `\subsection`：**10 pt**。
- **三级** `\subsubsection`：**10 pt**。
- **`\paragraph`**：**粗体**、左齐、与正文同行，标题后 **1 em** 空格。

---

## 9. 引用与参考文献体例

### 9.1 `natbib` 与 `\citet`

`natbib` 文档：  
[http://mirrors.ctan.org/macros/latex/contrib/natbib/natnotes.pdf](http://mirrors.ctan.org/macros/latex/contrib/natbib/natnotes.pdf)

文内叙述常用 **`\citet`**，例如：

```latex
\citet{hasselmo} investigated\dots
```

排版效果类似：**Hasselmo, et al. (1995) investigated…**

### 9.2 向会议 **匿名投稿** 时的自称（预印本挂网时亦建议谨慎）

双盲审稿要求：提及自己已发表工作时用**第三人称**，例如用 “In the previous work of Jones et al. [4]”，而**不要**写 “In our previous work [4]”。若引用尚未公开、不易获取的稿件，可用 “A. Anonymous” 等形式，并在补充材料中附**匿名版**论文。

（预印本虽非双盲，若之后改投会议，正文措辞提前按第三人称写可减少删改。）

### 9.3 手写 `thebibliography` 与 `natbib`

默认 `natbib` 多为作者-年份，`thebibliography` 中每条应使用带**可选括号标签**的 `\bibitem`，例如：

```latex
\bibitem[Hasselmo et al.(1995)]{hasselmo}
Hasselmo, M.~E., Schnell, E. \& Barkai, E.\ (1995) \ldots
```

若全文使用**数字**引用，请在加载 `neurips_2026` 前使用 `\PassOptionsToPackage{numbers,compress}{natbib}`，或使用 BibTeX + 如 `plainnat` 等一致体例。

### 9.4 参考文献章节位置与字号

- 致谢（若有）**之后**；使用**无编号一级标题** “References”（如 `\section*{References}`）。
- 列表**不计入** 9 页限制；可将列表置于 `{\small ...}` 中（约 **9 pt**）。
- 体例任选，**全文一致**。

---

## 10. 脚注

- **少用**。
- 脚注标在**标点之后**。
- 脚注出现在**首次出现该脚注的页面底部**；脚注上方为宽约 **2 英寸**（12 picas）的横线（由样式处理）。

---

## 11. 图（Figures）

- 图须整洁、清晰、线条足够深以便复印再制。
- **图编号与标题在图的下方**；题注与图之间、题注之后各约 **一行**间距。
- 题注：**小写**（句首与专有名词除外）；图按顺序编号。
- 可使用彩色图；题注与正文在 **黑白打印** 下仍应可读。

**题注写作要求（官方表述）**：说明图展示什么，并在题注中给出**一条关键 take-away**。

### 11.1 浮动体：避免图、表「堆在正文末尾」

NeurIPS **没有**要求把图放在参考文献前或文末；若 PDF 里图都挤在后面，通常是 **LaTeX 浮动体规则** + **文稿结构**所致，而非模板强制。

**常见原因**

- 只用 **`[t]`**（页顶）而图较**高**，一页剩余高度不够，浮动体进入队列，越积越多。  
- **`\\clearpage` / `\\cleardoublepage`**（例如在致谢、参考文献前）会**强制输出**此前未排上的浮动体，造成「致谢前一页全是图」。  
- **图在源码里出现在首次引用的很远之前/之后**，排版器更难把图放在读者预期位置。

**推荐做法（不修改 `neurips_2026.sty` 内几何与字号的前提下）**

1. **插图宽度**：`\includegraphics[width=\linewidth]{...}` 或 `width=0.9\linewidth`，避免超出版心（与 §16 一致）。  
2. **放置参数**：尝试 **`[!htbp]`**（在合规浮动参数内放宽一页内的摆放）。  
3. **适度放宽浮动比例**（在主文件导言区，**不要**改 sty）：例如提高 `\topfraction`、`\bottomfraction`，略降 `\textfraction`，使高图能落在正文页。本仓库 [`neurips_paper_template.tex`](neurips_paper_template.tex) 中有示例片段可参考。  
4. **控制漂移**：使用 **`placeins`** 包的 **`\FloatBarrier`**，在「图 + 紧随其后的讨论段」之后插入，减少图漂到下一节之后（可能增加竖向空白，按需使用）。  
5. **写作顺序**：把 **`figure` 环境放在首次 `Figure~\\ref{...}` 讨论的附近**（先见图再细讲，或先一段引入再插图），不要长期「图在 Methods、文在 Results」。  
6. **`[H]` 强制就地**：仅当版式实在无法接受时再考虑 `float` 包的 **`[H]`**（容易留下大块空白或挤压正文，非首选）。

---

## 12. 表（Tables）

- 表须居中、整洁、清晰。
- **表编号与标题在表的上方**；表题前一行距、表题后一行距、表后一行距（与官方说明一致）。
- 表题：**小写**（句首与专有名词除外）；表连续编号。
- **高质量表格不使用竖线**；强烈推荐 **`booktabs`**：  
  [https://www.ctan.org/pkg/booktabs](https://www.ctan.org/pkg/booktabs)

**官方示例结构（节选，便于照抄）**：

```latex
\begin{table}
  \caption{Sample table caption. Explain what the table shows and add a key take-away message to the caption.}
  \label{sample-table}
  \centering
  \begin{tabular}{lll}
    \toprule
    \multicolumn{2}{c}{Part} \\
    \cmidrule(r){1-2}
    Name     & Description     & Size ($\mu$m) \\
    \midrule
    Dendrite & Input terminal  & $\approx$100 \\
    Axon     & Output terminal & $\approx$10 \\
    Soma     & Cell body       & up to $10^6$ \\
    \bottomrule
  \end{tabular}
\end{table}
```

---

## 13. 数学公式

- **匿名投稿模式**会启用行号：用裸 TeX 的 **`$$ ... $$`** 作为行间公式可能导致行号不正确，应使用 LaTeX / AMSTeX 环境（如 `equation`、`align` 等）。
- **预印本模式**下本仓库不加载 `lineno`，仍建议避免 `$$`，以保持与将来改投会议时一致。参考：  
  [Why is \[ … \] preferable to $$?](https://tex.stackexchange.com/questions/503/why-is-preferable-to)  
  [align vs equation vs displaymath](https://tex.stackexchange.com/questions/40492/what-are-the-differences-between-align-equation-and-displaymath)

---

## 14. 禁止自行改版式（Final instructions）

- **不得**改动样式文件中的格式参数；尤其**不得**改正文区域宽高、**不得**改字号。
- 论文须编**页码**。

---

## 15. PDF 与字体

- PDF 仅含 **Type 1** 或 **嵌入的 TrueType** 字体；含 Type 3 或未嵌入 TrueType 会被要求修改。
- 用 **pdflatex** 直接生成 PDF。
- 在 Acrobat Reader：**文件 → 文档属性 → 字体**（Show All Fonts）；或在命令行使用 **`pdffonts`**（常随 xpdf 提供）。
- **xfig** 中带 “pattern” 的填充往往使用位图字体，请改用 **solid** 填充形状。
- **`bbold`** 几乎总是位图字体；请改用 **AMS Fonts**：

```latex
\usepackage{amsfonts}
```

使用 `\mathbb{R}`、`\mathbb{N}`、`\mathbb{C}` 等。若需变通写法（示例）：

```latex
\newcommand{\RR}{I\!\!R}   % real numbers
\newcommand{\Nat}{I\!\!N} % natural numbers
\newcommand{\CC}{I\!\!\!\!C} % complex numbers
```

注意：`amssymb` 会自动加载 `amsfonts`。

---

## 16. LaTeX 插图与边距问题

- 避免用 `\special` 等手摆图导致跑版；请用 **`graphicx`** 的 `\includegraphics`，宽度宜为 `\linewidth` 的分数，例如：

```latex
\usepackage{graphicx}
...
\includegraphics[width=0.8\linewidth]{myfile.pdf}
```

- 插图与说明见 [grfguide.pdf 第 4.4 节](http://mirrors.ctan.org/macros/latex/required/graphics/grfguide.pdf)。
- 若 LaTeX 无法断词导致行溢出，用 `\-` 给出断字提示。

---

## 17. 致谢与资助披露（`ack`）

- `ack` 由样式定义为 `\section*{Acknowledgments and Disclosure of Funding}` 加正文。
- **匿名投稿（带行号）**：样式将 `ack` **整段隐藏**，PDF 中不出现；内容可先在源码里写好，**camera-ready** 再随 `final` 呈现。
- **预印本**：`ack` **会显示**；仍须按官方要求写资助与利益冲突。
- 须按官方要求声明 **资助**（支持本工作的财务活动）与 **利益冲突**（工作之外的相关财务活动）：  
  [NeurIPS 2026 Funding Disclosure](https://neurips.cc/Conferences/2026/PaperInformation/FundingDisclosure)

---

## 18. 技术附录与补充材料

- 可在全文提交截止前提交技术附录（额外结果、图、证明等）；可上传含视频或代码的 **ZIP**。**不要**再单独上传**仅附录的 PDF**。
- 附录**无页数上限**。
- 附录视为审稿人 **“可选阅读”**：**主文必须自洽**；把支撑**主结论**的关键实验只放在附录是**不合适的**。

---

## 19. NeurIPS Paper Checklist

- **向会议正式投稿**：论文须包含 checklist；**删除 checklist 会导致 desk rejection**。
- 位置：在**参考文献之后**（及附录之后，若有）；建议 `\newpage` 后 `\input{checklist.tex}`。
- Checklist **不计入** 9 页限制。
- 编辑规则（见 `checklist.tex` 头部）：
  - **删除** `%%% BEGIN INSTRUCTIONS %%%` 至 `%%% END INSTRUCTIONS %%%` 的整段说明；
  - **保留** 节标题 “NeurIPS Paper Checklist” 及原有小节标题、问题与答题栏；
  - **不得修改问题原文**；答案仅用 `\answerYes`、`\answerNo`、`\answerNA`（定稿前将 `\answerTODO`、`\justificationTODO` 替换掉）；
  - 每个问题在答案后附 **1–2 句** justification（`\answerNA` 也需理由）。
- 答案对审稿人、AC、SAC、伦理审稿人可见；录用后修订稿仍须包含，**最终版会随论文公开**。
- 答 **No** / **N/A** 在合理解释下可接受；**不会仅因 No/N/A 拒稿**。

### 19.1 各条 Guidelines 要点摘要

1. **Claims**：摘要与引言中的论断是否与贡献、范围一致；假设与局限是否清楚；与理论与实验是否匹配；可写动机性目标，但须区分未在本文完成的目标。
2. **Limitations**：是否讨论局限；建议设 “Limitations” 节；假设、数据范围、可推广性、算力、公平与隐私等。
3. **Theory assumptions and proofs**：若无理论则 N/A；若有则假设完整、证明完整或可指向附录；定理编号与交叉引用。
4. **Experimental result reproducibility**：他人能否据文复现支撑主结论的实验（不限于必须开源）。
5. **Open access to data and code**：见 [CodeSubmissionPolicy](https://neurips.cc/public/guides/CodeSubmissionPolicy)；无法开放时答 No 并解释亦可。
6. **Experimental setting/details**：划分、超参、优化器、选取方式等是否足够。
7. **Experiment statistical significance**：误差条/区间/检验是否恰当；含义与算法是否说明。
8. **Experiments compute resources**：硬件、内存、时间、项目总算力。
9. **Code of ethics**：是否符合 [NeurIPS Code of Ethics](https://neurips.cc/public/EthicsGuidelines)。
10. **Broader impacts**：正负面社会影响；误用、公平、隐私、安全等。
11. **Safeguards**：高误用风险资产发布时的管控措施。
12. **Licenses for existing assets**：来源、版本、许可证与使用条款。
13. **New assets**：新数据/代码/模型的文档；同意与投稿时匿名化。
14. **Crowdsourcing and human subjects**：说明、截图、报酬等；最低工资见伦理指南。
15. **IRB**：风险披露与 IRB/等同审批（初稿注意匿名）。
16. **Declaration of LLM usage**：若 LLM 为方法中重要、原创或非标准组成部分须声明；若仅用于写作润色/排版且不影响方法与原创性，按当年 handbook 可能不要求声明。

### 19.2 Checklist 与正文对应关系（写作与填表时自测）

填 checklist 时，审稿人常会**回到正文找依据**。建议在主文里为下列条目预留**可定位**的段落（节名不必一字不差，但应在 PDF 中能搜到相关内容）。

| Checklist 主题（见 §19.1 编号） | 正文建议落点 |
|--------------------------------|--------------|
| 1 **Claims** | **摘要** + **引言**末段：贡献列表、范围、哪些是本文完成/哪些只是动机。 |
| 2 **Limitations** | 独立 **`\\section{Limitations}`** 或讨论节中一段；与假设、数据范围、可推广性挂钩。 |
| 3 **Theory** | 定理/命题与**假设**写在主文或附录；文中标明编号与「证明见附录」若适用。 |
| 4 **Reproducibility** | **Methods / Experimental setup**：数据、划分、种子、超参、评测指标、实现细节；复杂处指附录。 |
| 5 **Open data/code** | 同上节 + 补充材料链接或「为何不能公开」的**诚实说明**（答 No 亦可，须 justification）。 |
| 6 **Experimental details** | 与第 4、5 条共享：**Methods** 与附录中的实验表、超参表。 |
| 7 **Statistical significance** | Results：误差条、置信区间、重复次数、检验方式。 |
| 8 **Compute** | Methods 或独立小段：硬件、GPU 型号、训练时间、总算力量级。 |
| 9–11 **Ethics / Broader impacts / Safeguards** | 讨论或独立短节：误用风险、数据隐私、发布策略。 |
| 12–13 **Licenses / New assets** | Methods 或附录：数据集/代码/模型的**来源、版本、许可证**；新资产如何匿名分发。 |
| 14–15 **Human subjects / IRB** | 若适用：实验设计、审批、报酬；不适用则 **N/A** 并 justification。 |
| 16 **LLM usage** | 通常在 Methods 末或致谢前一句：是否用 LLM 写稿/改代码，是否影响结论。 |

**自检**：每个 `\answerYes` 最好在 justification 里写「见 **第 X 节 / 附录 Y**」，避免空话。

---

## 20. 轨道与模式切换摘要

1. **会议匿名投稿（带行号）**：`\usepackage{neurips_2026}` 或 `\usepackage[main]{neurips_2026}`；其它轨道：`position`、`eandd`（可选 `nonanonymous`）、`creativeai`、`sglblindworkshop`、`dblblindworkshop`（须 `\workshoptitle{...}`）。**勿用** `preprint`。
2. **仅需 arXiv / 非匿名预印本、不要行号**：改为 `\usepackage[preprint]{neurips_2026}`。
3. **录用后 camera-ready**：在对应轨道上 **`final`**，例如 `\usepackage[main,final]{neurips_2026}`。
4. **匿名稿**：正文勿泄露身份；**勿引用** PDF 左侧**行号**。

---

## 21. 预印本 / 会议投稿通用核对清单

- [ ] 使用当年 `neurips_2026.sty`，未篡改几何与字号  
- [ ] PDF 为 US Letter，`pdflatex` 生成，字体为 Type 1 / 嵌入 TrueType  
- [ ] 主文 ≤ 9 页（含图）  
- [ ] 参考文献体例全文一致  
- [ ] **会议匿名稿**：含 checklist、已删说明块、仅用规定宏作答；**无身份泄露**；既往工作第三人称；**不引用行号**  
- [ ] **预印本**：使用 `[preprint]`；不在文中声明投往哪一次会议；未录用不使用 `final`  
- [ ] **自其它版式迁入**：已对照 **§1.5**；图表浮动已按 **§11.1** 检查；checklist 与正文已按 **§19.2** 能对上  

---

