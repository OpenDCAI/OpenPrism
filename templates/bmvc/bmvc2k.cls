% -*- compile-command: "texify --pdf --quiet bmvc_abstract.tex" -*-
% The above must be the first line
%------------------------------------------------------------------------------
% B M V A 2 K 9. c l s   --   LaTeX2e class for BMVC, 2009 onwards
%------------------------------------------------------------------------------
% REVISION HISTORY
% 0.00 2007-03-29  Adrian F. Clark <alien/at/essex.ac.uk>
%      Original version.
% 0.01 2007-05-01  Adrian F. Clark <alien/at/essex.ac.uk>
%      Increase \headsep and tweak headline following comments from Roy Davies.
% 0.02 2008-10-01  Andrew Fitzgibbon <awf/at/microsoft.com>
%      Changes for BMVC
% 0.03 2009-06-19  Andrew Fitzgibbon <awf/at/microsoft.com>
%      Added extended abstract for BMVC
% 0.04 2009-06-22  Andrew Fitzgibbon <awf/at/microsoft.com>
%      Remove ``References'' from before bibliography
% 0.05 2009-06-22  Andrew Fitzgibbon <awf/at/microsoft.com>
%      Add pdfcatalog entry to display 2-up
% 0.06 2010-01-29  Alan Woodland <ajw/at/aber.ac.uk>
%      Bump year to 2010
% 0.07 2010-07-06  Andrew Fitzgibbon <awf/at/microsoft.com>
%      Add DOI
% 0.08 2011-03-01 Stephen McKenna <stephen/at/computing.dundee.ac.uk>
%      Change year to 2011
% 0.09 2011-04-07 Oliver Woodford <o.j.woodford.98/at/cantab.net>
%      Changed to use default mathcal font
%      Change year to 2011
% 0.10 2012-04-17 John Collomosse <j.collomosse/at/surrey.ac.uk>
%      Change year to 2012
% 0.11 2014-07-14 Michel Valstar <michel.valstar/at/nottingham.ac.uk>
%      Change year to 2014
% 0.12 2014-09-02 Jingjing Deng <J.Deng/at/swansea.ac.uk>
%      Change year to 2015
% 0.13 2016-07-20 Richard Wilson <Richard.Wilson/at/york.ac.uk>
%      Change year to 2016
%	   Change formatting of extended abstract option to A5 paper
% 0.13 2017-07-06 Krystian Mikolajczyk <K.Mikolajczyk/at/imperial.ac.uk>
%      Change year to 2017
% 0.14 2019-03-06 David Marshall <MarshallAD@Cardiff.ac.uk>
% 0.15 2020-04-09 Oisin Mac Aodha <oisin.macaodha@ed.ac.uk>
%      Change year to 2020
% 0.16 2021-05-21 Tu Bui <t.v.bui@surrey.ac.uk>
%      Change year to 2021
%      Replace color with xcolor
%      Redefine BMVA@blfootnote
% 0.17 2021-10-19 Neill Campbell <n.campbell@bath.ac.uk>
%      Fixed a bug in the author (and institution) expansion that would
%      fail to expand in the double digits (> 9 authors). Fix is on
%      lines 369 and 393 (extra braces escaping the counts added).
%      Also removed the institution matching logic since it fails under
%      multiple institutions - will need to fix this at some point..
% 0.18 2022-07-18 Yaoyao Liu <yaoyao.liu@mpi-inf.mpg.de>
%      Change year to 2022.
%      Change the page limit to nine.
% 0.19 2022-10-02 Yaoyao Liu <yaoyao.liu@mpi-inf.mpg.de>
%      Change the page limit for the camera-ready version to ten.
% 0.20 2023-05-07 Yaoyao Liu <yliu538@jhu.edu>
%      Change year to 2023.
% 0.21 2025-04-28 Steve Maddock <s.maddock@sheffield.ac.uk>
%      Change year to 2025.
% 0.22 2026-04-02 Bryan M. Williams <b.williams6@lancaster.ac.uk>
%      Change year to 2026.
%      Change page limit to 14.
%------------------------------------------------------------------------------
% Copyright 2007 Adrian F. Clark <alien/at/essex.ac.uk>.  All rights reserved.
%------------------------------------------------------------------------------

% Notes on reading this file:
%
% 1.
% Private identifiers begin with bmv@, identifiers intended for use by
% the authors are of two kinds: identifiers typically exported by
% ``article'' classes such as \addauthor, \maketitle, or \addinstitution;
% additional useful tools such as \bmvaOneDot, \bmvaHangBox, etc.
%
% 2.
% Lines ending with apparently innocuous comments are common in TeX
% source, because without them, spaces are inserted into the output.
% In this file I've tried to make these ``important'' comments begin
% with %^, to indicate that they have a structural purpose.  We use
% ^ because it's easy to type shift-56, and the ^ looks like an
% ``insert'' marker.
%
% 3.
% Debugging tips:
% \tracingmacros=1 % xx check this is unset before release...
%\def\bmv@pdfcompresslevel{\global\pdfcompresslevel=0}  % xx this should also be unset for release
\let\bmv@pdfcompresslevel=\relax  % xx this should also be unset for release

\newif\ifbmv@pdf
\bmv@pdffalse
\ifx\pdfoutput\undefined
\else
  \ifx\pdfoutput\relax
  \else
    \ifcase\pdfoutput
    \else
      \bmv@pdftrue
    \fi
  \fi
\fi


%% Change the year...
\def\BMVA@year{2026}

%% -- CLASS FILE BOILERPLATE --

\def\fileversion{0.22}
\def\filedate{2026/04/02}

\newif\ifbmv@extabs
\bmv@extabsfalse

\NeedsTeXFormat{LaTeX2e}
\ProvidesClass{bmvc2k}[\filedate\space BMVC Proceedings. v\fileversion]
\DeclareOption{extendedabs}{\bmv@extabstrue}

\newif\ifbmv@review
\bmv@reviewfalse

\def\bmv@papernumber{??}
\def\bmvcreviewcopy#1{\bmv@reviewtrue\global\def\bmv@papernumber{#1}}

% We're based on the article class.
\ProcessOptions
\ifbmv@extabs
% Extended abstract: one page,
\LoadClass[a5paper,twoside]{article}
\renewcommand{\normalsize}{\fontsize{9}{10pt}\selectfont}
\renewcommand{\small}{\fontsize{8}{9pt}\selectfont}
\renewcommand{\footnotesize}{\fontsize{7}{8pt}\selectfont}
\renewcommand{\scriptsize}{\fontsize{6}{8.5pt}\selectfont}
\renewcommand{\tiny}{\fontsize{5.5}{6.5pt}\selectfont}
\renewcommand{\large}{\fontsize{10}{11pt}\selectfont}
\renewcommand{\Large}{\fontsize{11}{11.5pt}\selectfont}
\renewcommand{\LARGE}{\fontsize{12}{13pt}\selectfont}
\renewcommand{\huge}{\fontsize{14}{14pt}\selectfont}
\renewcommand{\Huge}{\fontsize{16}{16pt}\selectfont}

\newcommand{\bmv@titlesize}{\fontsize{10}{11pt}\selectfont}
\twocolumn

\else
\LoadClass[10pt,twoside]{article}
\newcommand{\bmv@titlesize}{\LARGE}
\fi

%% -- USEFUL PACKAGES --
\RequirePackage{xcolor}
\RequirePackage{graphicx,subfigure}
\RequirePackage{xspace}
\RequirePackage{eso-pic}
\ifbmv@extabs
% no need for hyperref in a 1-pager, but we do want urlstyle
\RequirePackage{url}
\else
\RequirePackage[colorlinks,urlcolor=blue,citecolor=red,bookmarks=false]{hyperref}
\bmv@pdfcompresslevel % reset as hyperref mucks it (of course..)
\fi

\DeclareUrlCommand\bmvaUrl{\urlstyle{sf}}

\usepackage{amsmath}

%% -- USER-VISIBLE MACROS --

%% \bmvaOneDot{e.g}
% Add a period to the end of an abbreviation unless there's one
% already, then \xspace.
\DeclareRobustCommand\bmvaOneDot{\futurelet\@let@token\bmv@onedotaux}
\def\bmv@onedotaux{\ifx\@let@token.\else.\null\fi\xspace}

%% \bmvaCenterBox{Line 1\\Line 2}
% Center lines in a box.  This expands its argument twice, so any side
% effects (e.g. incrementing a counter) will be observed twice
\newbox\bmv@CenterBoxtmp
\def\bmvaCenterBox#1{%^
 % First measure the width
 \setbox\bmv@CenterBoxtmp\hbox{%^
   \begin{minipage}{2\textwidth}%^
     \begin{tabbing}#1\end{tabbing}%^
   \end{minipage}}%^
 % And then make the minipage
 \begin{minipage}[t]{\wd\bmv@CenterBoxtmp}%^
   \begin{center}#1\end{center}%^
 \end{minipage}}

%% \bmvaHangBox{Text}
% Proper hanging from top o f first line, not bottom.  i.e.
%   \bmv@hang{\epsfbox{pic1.ps}}\bmv@hang{\epsfbox{pic2.ps}}
% will produce
%   -----  -----
%   | 1 |  | 2 |
%   -----  |   |
%          -----
%
%

\def\bmvaHangBox#1{%^
\begin{minipage}[t]{\textwidth}% Top-hanging minipage, will align on
			       % bottom of first line
\begin{tabbing} % tabbing so that minipage shrinks to fit
~\\[-\baselineskip] % Make first line zero-height
#1 % Include user's text
\end{tabbing}%^
\end{minipage}} % can't allow } onto next line, as {WIDEBOX}~x will not tie.


\def\bmvaBaselineHangBox#1{%^
\begin{minipage}[t]{\textwidth}% Top-hanging minipage, will align on
			       % bottom of first line
\begin{tabbing} % tabbing so that minipage shrinks to fit
#1 % Include user's text
\end{tabbing}
\end{minipage}} % can't allow } onto next line, as {WIDEBOX}~x will not tie.

%%  --  PAGE LAYOUT  --
\ifbmv@extabs
% Extended abstract:
% A single A5 page, for printed abstract booklet. Pages are centered
% horizontally, as they will be shifted left and right at print time.
\RequirePackage[twoside,headsep=3mm,a5paper,inner=11mm,outer=11mm,top=3mm,includehead,bottom=8mm,heightrounded]{geometry}
\columnsep=4mm
\else
% Proceedings:
% This format is designed with on-screen reading in mind.  This means that
% a single-column format is required, to avoid panning between text and
% figures.  However, a single-column format with very long lines wastes
% space and is hard to read, so this format uses a narrow page which is
% readable either 1-up on a low res monitor, or 2-up on a high-resolution
% display.
%
% For printing, setting the PDF reader to an appropriate combination of
% centering, scaling, and number of pages yields a variety of useful
% formats, for example:
%   1-up, centred:  A format very like the old BMVC or Springer LNCS (ECCV).
%   1-up, scaled:   A large-print format, for the visually impaired.
%   2-up, scaled:   A compact paper-saving format without loss of font size.
% If we had kept the old margins, only the first of these is possible.

% Page width is 70 characters, i.e. about 70 * 6pt,
% Page height is 3/2 times the width, so two can fit side-by-side on a 4x3 monitor
% 16/9 monitors can use the space to the sides for notes.
% xx talk about notes
\RequirePackage[twoside,headsep=3mm,papersize={410pt,620pt},inner=9mm,outer=6mm,top=3mm,includehead,bottom=5mm,heightrounded]{geometry}
\ifbmv@pdf
% Default view is 2-up to emphasize that this is the intended view
% for on-screen reading
\pdfcatalog{/PageLayout /TwoColumnLeft}
\fi
\fi
% Set up the fonts.

\RequirePackage[T1]{fontenc}
\RequirePackage{mathptmx}
\RequirePackage{helvet,courier}
\DeclareMathAlphabet{\mathcal}{OMS}{cmsy}{m}{n}

%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% INTERNALS

% xx
% pdfTeX warning (ext4): destination with the same identifier
% (name{}) has been already used, duplicate ignored
%

% Debug flag: set to 1 to see boxes around authors/insts
\let\bmvadebug=0
\newif\ifbmvadebug
\ifx\bmvadebug 1
\bmvadebugtrue
\else
\bmvadebugfalse
\fi

% Colours for debugging
\ifbmvadebug
\definecolor{bmv@PaleBlue}{rgb}{.7,.7,1}
\definecolor{bmv@PalePink}{rgb}{1,.7,.7}
\else
\definecolor{bmv@PaleBlue}{rgb}{1,1,1}
\definecolor{bmv@PalePink}{rgb}{1,1,1}
\fi

\definecolor{bmv@sectioncolor}{rgb}{0,.1,.4}
\definecolor{bmv@captioncolor}{rgb}{0,0,.4}

\ifbmvadebug
\message{BMVA style file debugging on}
\fi

%% bmv@edefappend -- expand token list and append to macro #1
\newtoks\bmv@toks
\def\bmv@edefappend#1#2{%^
  \bmv@toks = \expandafter{#1}%^
  \xdef#1{\the\bmv@toks #2}%^
}

%% Useful macros for named boxes and counters

% named boxes
\def\bmv@newbox#1{\expandafter \newbox \csname bmv@box #1 \endcsname}
\def\bmv@sbox#1#2{\expandafter \sbox \csname bmv@box #1 \endcsname {#2}}
\def\bmv@savenewbox#1#2{\bmv@newbox{#1}\bmv@sbox{#1}{#2}}
\def\bmv@unhbox#1{\expandafter\unhbox \csname bmv@box #1 \endcsname}
\def\bmv@usebox#1{\expandafter\usebox \csname bmv@box #1 \endcsname}

% named counters
\def\bmv@newcount#1{\expandafter \newcount \csname bmv@cnt #1 \endcsname}
\def\bmv@setcountaux#1#2{#1=#2}
\def\bmv@setcount#1#2{\expandafter \bmv@setcountaux \csname bmv@cnt #1 \endcsname {#2}}
\def\bmv@thecount#1{\expandafter \the \csname bmv@cnt #1 \endcsname}

% struts
% These are visible in debug mode
\ifbmvadebug
\def\bmv@strut{\rule{0.1pt}{1ex}\hspace{-0.1pt}}
\else
\def\bmv@strut{\rule{0pt}{1ex}}
\fi

%% Generic List Map
\let\bmv@endstop=\relax

% bmv@maplistaux -- macro \bmv@action is called with each token in list up to
% next \bmv@endstop, calling macro \bmv@between between items.
\def\bmv@maplistaux#1{%^
 \bmv@action{#1}%^
 \@ifnextchar\bmv@endstop{\@gobble}{\bmv@between\bmv@maplistaux}%^
}

% executing \between between each

% e.g. \bmv@maplist\fbox{-o-}{{fred}{una}{conor}}

% reminder of ~ catcodes
% \catcode`\~=12  \def~{\char`~}  % code is ``7E

%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% AUTHOR AND INSTITUTION HANDLING

%% bmvaResetAuthors -- Empty author/institution lists for testing
\def\bmvaResetAuthors{
  \bmv@nauthors=0
  \bmv@ninsts=0
  \edef\bmv@auths{}
  \edef\bmv@insts{}
  \gdef\maketitle{\bmv@maketitle}
}

% We will explictly count the authors in bmv@nauthors
% just to keep the code a bit clearer
\newcount\bmv@nauthors
\bmv@nauthors=0

% bmv@ninsts -- Number of institutions
\newcount\bmv@ninsts
\bmv@ninsts=0

% bmv@auths -- stores the author ids as a list of length n
\edef\bmv@auths{}

% bmv@insts -- stores the institutions as a list of length n
\edef\bmv@insts{}

% \bmv@RenderAuthorName -- Place the author's name in a box
\def\bmv@RenderAuthorName#1{%^
  \sffamily\normalsize #1}

% \bmv@RenderAuthorNameFN -- Place the author's name in a box with a footnotemark
\def\bmv@RenderAuthorNameFN#1#2{%^
  \sffamily\normalsize #1$^{\mbox{\sffamily\scriptsize #2}}$}

% \bmv@RenderAuthorMail -- Place the author's mail/www in a box
\def\bmv@RenderAuthorMail#1{%^
  \small\textcolor{bmv@sectioncolor}{\bmvaUrl{#1}}}

% \addauthor{Name}{email/homepage}{INSTITUTION_CODE}
\def\addauthor#1#2#3{%^
  \advance\bmv@nauthors1
  \bmv@savenewbox{authname\the\bmv@nauthors}{\bmv@RenderAuthorName{#1}}
  \bmv@savenewbox{authnameFN\the\bmv@nauthors}{\bmv@RenderAuthorNameFN{#1}{#3}}
  \bmv@savenewbox{authmail\the\bmv@nauthors}{\bmv@RenderAuthorMail{#2}}
  % NDFC Removing this logic since it breaks with multiple institutions
  % at the moment - will fix at somepoint..
  %\bmv@newcount{authinst\the\bmv@nauthors}
  %\bmv@setcount{authinst\the\bmv@nauthors}{#3}
  \bmv@edefappend{\bmv@auths}{{\the\bmv@nauthors}}
}

% \bmv@RenderInst{Name\\Address}
% Display an institution address
\def\bmv@RenderInst#1{%^
   \begin{minipage}[t]{0.48\textwidth}
    \sffamily
    \begin{raggedright}
     #1
    \end{raggedright}
   \end{minipage}}

% \addinstitution{Name\\Address}
% This creates two display boxes: one with footnotemark,
% and one without. We make the boxes now so that we can
% deal with them without worrying about subsequent macro
% expansion.
\long\def\addinstitution#1{
  \advance\bmv@ninsts1
  \bmv@savenewbox{inst\the\bmv@ninsts}{\bmv@RenderInst{#1}}
  \bmv@savenewbox{instFN\the\bmv@ninsts}{%^
    \sffamily$\rule{0pt}{1ex}^{\mbox{\scriptsize \the\bmv@ninsts}}\,$%^
    \hbox{\bmv@RenderInst{#1}}}
  \bmv@edefappend{\bmv@insts}{{\the\bmv@ninsts}}
}

\ifbmv@extabs
\def\bmv@RAIspace{\hspace*{4pt}}
\else
\def\bmv@RAIspace{}
\fi

% \bmv@RenderAuthInstTwoColumn
% Display authors on left and institutions on right
% Add footnotes if
\def\bmv@RenderAuthInstTwoColumn{
% Use footnotes if more than one institution
% In future, one might be cleverer if the author order and
% institution order are both ascending
\ifnum\bmv@ninsts>1
 \def\bmv@FN{FN}
\else
 \def\bmv@FN{}
\fi
% A minipage for the authors, on the left
\begin{minipage}[t]{0.49\textwidth}
 \def\bmv@action##1{%^
  \bmv@unhbox{authname\bmv@FN##1}\\
  \bmv@unhbox{authmail##1}}
 \def\bmv@between{\\[3pt]}
 \expandafter\bmv@maplistaux\bmv@auths\bmv@endstop
\end{minipage}
\bmv@RAIspace\hfill%^
% A minipage for the institutions, on the right
\begin{minipage}[t]{0.48\textwidth}
 \def\bmv@action##1{%^
  \bmv@unhbox{inst\bmv@FN##1}}
 \def\bmv@between{\\[4pt]}
 \expandafter\bmv@maplistaux\bmv@insts\bmv@endstop
\end{minipage}
}

% \bmv@RenderAuthInstTable
% Display authors on left and institutions on right,
% but look up the institution for each author
\def\bmv@RenderAuthInstTable{
\def\bmv@FN{}
\let\bmv@action=\bmv@RAITableAction
\def\bmv@between{\\[4pt]}
\expandafter\bmv@maplistaux\bmv@auths\bmv@endstop
}

\def\bmv@RAITableAction#1{
\begin{minipage}[t]{0.49\textwidth}
\bmv@unhbox{authname#1}\\
\bmv@unhbox{authmail#1}
\end{minipage}
\bmv@RAIspace~
\begin{minipage}[t]{0.48\textwidth}
\bmv@usebox{inst\bmv@thecount{authinst#1}}
\end{minipage}
}

%% bmv@RenderAuthorsAndInstitutions
% Make author list, but not in ``review'' mode...
\def\bmv@RenderAuthorsAndInstitutions{
\ifbmv@review
\begin{center}
\sffamily\normalsize BMVC \BMVA@year\ Submission \# \bmv@papernumber
\end{center}
\else
% Send them to the page
\ifnum\bmv@ninsts=1
\bmv@RenderAuthInstTwoColumn
\else
% more than one institution.
%  if equal to number of authors, then there's one each, so
%  render one each..
% NDFC Removing this logic since it breaks with multiple institutions
% at the moment - will fix at somepoint..
%\ifnum\bmv@ninsts=\bmv@nauthors
%\bmv@RenderAuthInstTable
%\else
\bmv@RenderAuthInstTwoColumn
%\fi
\fi
\fi
}


%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%

% Email addresses are enclosed in angle brackets.  (The \<...> macro
% can also be used independently, though it works only outside maths mode.)

%\def\<#1>{$\langle$#1$\rangle$}
%\def\email#1{\<\texttt{#1}>}

% A macro for producing the title, which also puts the copyright notice
% in an unnumbered footnote on the first page.  The \maketitle macro
% was derived from a (probably very old) version of the article class
% and is probably not as elegant as it could be.

\newcounter{BMVA@shortyear}
\setcounter{BMVA@shortyear}\BMVA@year
\addtocounter{BMVA@shortyear}{-1986}

% remove hyperref warning with this
\newcommand\BMVA@blfootnote[1]{%
\begin{NoHyper}
\renewcommand\thefootnote{}\footnote{#1}%
\addtocounter{footnote}{-1}%
\end{NoHyper}
}

\def\bmv@maketitle{\newpage\global\@topnum\z@%^
  \bmv@strut\\[-4pt]% vglue produces inconsistent results
  \begin{raggedright}%^
    {\bmv@titlesize\bfseries\sffamily\textcolor{bmv@sectioncolor} \@title\par}%^
    \vskip 1.5em%^
    {\bmv@RenderAuthorsAndInstitutions}%^
  \end{raggedright}%^
  \vskip\baselineskip
  \hrule
  \vskip\baselineskip
  % \def\BMVA@blfootnote{\xdef\@thefnmark{}\@footnotetext}%^
  \BMVA@blfootnote{\null\hspace{-1.9em}\copyright{} \BMVA@year.
    The copyright of this document resides with its authors.
%\hfill doi:10.5244/C.\arabic{BMVA@shortyear}.NNN % DOI will be inserted directly on the PDF
\\
    It may be distributed unchanged freely in print or electronic forms.}%^
  \setcounter{footnote}{0}%^
  \thispagestyle{bmv@c}\pagestyle{bmv@c}%^
  \gdef\maketitle{\message{Cannot use maketitle twice}}%^
}
\ifbmv@extabs
\def\maketitle{\twocolumn[\bmv@maketitle]}
\else
\let\maketitle=\bmv@maketitle
\fi

% The running head contains the author(s) and paper title, perhaps
% abbreviated so that the overall length of the headline is not too long.

\def\runninghead#1#2{\gdef\BMVA@author{\MakeUppercase{#1}}%^
  \gdef\BMVA@title{\MakeUppercase{#2}}}

% The et al macro allows for a lowercase ``et al.'' in the running head.
% It is called using \protect\etal
\def\bmv@EtAl{\em et al.}
\def\bmvaEtAl{\protect\bmv@EtAl}


% A macro that saves out the number of the last page of the document
% in the macro \BMVA@LastPage, for use in the headline.

\AtEndDocument{\immediate\write\@auxout{\gdef\string\BMVA@LastPage{\thepage}}}
\def\BMVA@LastPage{??}

% The headline itself, which comprises two lines of text:
%   -- The first contains the paper's authors and title and is a
%      hypertext reference to the master version on the Annals website.
%   -- The second gives citation information, with the journal name
%      being a hypertext reference to the Annals website.
% This has to be set explicitly by the author (or editor) via the \papernumber
% macro (see above).

\def\BMVA@authorOrAnon{\ifbmv@review{AUTHOR(S)}\else\BMVA@author\fi}

\ifbmv@extabs
\newcommand*{\ps@bmv@c}{%^
\renewcommand*{\@oddhead}{}%^
\renewcommand*{\@evenhead}{}%^
\renewcommand*{\@oddfoot}{}%^
\renewcommand*{\@evenfoot}{}%^
}
\else
\newcommand*{\ps@bmv@c}{%^
  \renewcommand*{\@oddhead}{\begin{minipage}{\textwidth}\small
      \begin{tabular*}{\textwidth}{@{}l@{\extracolsep{\fill}}r@{}}
        \textsl{\BMVA@authorOrAnon: \BMVA@title}
          & \bfseries\thepage
      \end{tabular*}\par\smallskip\hrule
    \end{minipage}}
  \renewcommand*{\@evenhead}{%^
    \begin{minipage}{\textwidth}\small
      \begin{tabular*}{\textwidth}{@{}l@{\extracolsep{\fill}}r@{}}
        \bfseries\thepage &\textsl{\BMVA@authorOrAnon: \BMVA@title}
      \end{tabular*}\par\smallskip\hrule
    \end{minipage}}
  \renewcommand*{\@oddfoot}{}%^
  \renewcommand*{\@evenfoot}{}%^
}
\fi

% Ensure section titles are set ragged-right.   These definitions are
% adapted from those in article.cls v1.4f of 2004/02/16.

\renewcommand\section{\@startsection {section}{1}{\z@}%^
                                   {-3.5ex \@plus -1ex \@minus -.2ex}%^
                                   {2.3ex \@plus.2ex}%^
                                   {\normalfont\Large\bfseries\flushleft\textcolor{bmv@sectioncolor}}}
\renewcommand\subsection{\@startsection{subsection}{2}{\z@}%^
                                     {-3.25ex\@plus -1ex \@minus -.2ex}%^
                                     {1.5ex \@plus .2ex}%^
                                     {\normalfont\large\bfseries\flushleft\textcolor{bmv@sectioncolor}}}
\renewcommand\subsubsection{\@startsection{subsubsection}{3}{\z@}%^
                                     {-3.25ex\@plus -1ex \@minus -.2ex}%^
                                     {1.5ex \@plus .2ex}%^
                                     {\normalfont\normalsize\bfseries\flushleft\textcolor{bmv@sectioncolor}}}

% Footnote rules go right across the page (definition adapted from
% article.cls v1.4f of 2004/02/16).

\renewcommand\footnoterule{\kern-3\p@
  \hrule\@width\columnwidth
  \kern2.6\p@}

% Make the space above figure captions more compact
\setlength\abovecaptionskip{-5pt}

% Set captions in blue
\let\bmv@makecaption=\@makecaption
\def\@makecaption#1#2{\textcolor{bmv@captioncolor}{\bmv@makecaption{#1}{#2}}}


%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% RULER
%% --------- Page background marks: Ruler and confidentiality

% ----- define vruler
\newbox\bmv@rulerbox
\newcount\bmv@rulercount
\newdimen\bmv@ruleroffset
\newdimen\bmv@rulerlineheight
\newdimen\bmv@rulerboxheight
\newbox\bmv@rulertmpbox
\newcount\bmv@rulerrefno
\newcount\bmv@rulertot

\font\bmv@ruler@tenhv = phvb at 8pt % *** If this fails, see the lines after this one in bmvc2k.sty ***
% If the above lines give an error message, try to comment them and
% uncomment these:
%\font\bmv@ruler@tenhv = phvb7t at 8pt

%% \fillzeros[<WIDTH>]<NUMBER>
% NUMBER with left flushed zeros
\newcount\bmv@rulertmpc@
\newcount\bmv@rulertmpc
\def\bmv@fillzeros[#1]#2{
  \bmv@rulertmpc@=#2\relax\ifnum\bmv@rulertmpc@<0\bmv@rulertmpc@=-\bmv@rulertmpc@\fi
\bmv@rulertmpc=1 %^
\loop\ifnum\bmv@rulertmpc@<10 \else \divide\bmv@rulertmpc@ by 10 \advance\bmv@rulertmpc by 1 \fi
   \ifnum\bmv@rulertmpc@=10\relax\bmv@rulertmpc@=11\relax\fi \ifnum\bmv@rulertmpc@>10 \repeat
\ifnum#2<0\advance\bmv@rulertmpc1\relax-\fi
\loop\ifnum\bmv@rulertmpc<#1\relax0\advance\bmv@rulertmpc1\relax\fi \ifnum\bmv@rulertmpc<#1 \repeat
\bmv@rulertmpc@=#2\relax\ifnum\bmv@rulertmpc@<0\bmv@rulertmpc@=-\bmv@rulertmpc@\fi
\relax\the\bmv@rulertmpc@}

% \makevruler[<SCALE>][<INITIAL_COUNT>][<STEP>][<DIGITS>][<HEIGHT>]
\def\makevruler[#1][#2][#3][#4][#5]{\begingroup\offinterlineskip
\textheight=#5\vbadness=10000\vfuzz=120ex\overfullrule=0pt%^
\global\setbox\bmv@rulerbox=\vbox to \textheight{%^
{\parskip=0pt\hfuzz=150em\bmv@rulerboxheight=\textheight
\bmv@rulerlineheight=#1\global\bmv@rulercount=#2%^
\bmv@rulertot\bmv@rulerboxheight\divide\bmv@rulertot\bmv@rulerlineheight\advance\bmv@rulertot2%^
\bmv@rulerrefno1\vskip-\bmv@rulerlineheight\vskip1ex%^
\loop\setbox\bmv@rulertmpbox=\hbox to0cm{{\bmv@ruler@tenhv\hfil\bmv@fillzeros[#4]\bmv@rulercount}}%^
\ht\bmv@rulertmpbox\bmv@rulerlineheight\dp\bmv@rulertmpbox0pt\box\bmv@rulertmpbox\break
\advance\bmv@rulerrefno1\global\advance\bmv@rulercount#3\relax
\ifnum\bmv@rulerrefno<\bmv@rulertot\repeat}}\endgroup}%^
% ----- end of vruler

% \makevruler[<SCALE>][<INITIAL_COUNT>][<STEP>][<DIGITS>][<HEIGHT>]
\def\bmv@ruler#1{\makevruler[12.5pt][#1][1][3][0.993\textheight]\usebox{\bmv@rulerbox}}
\AddToShipoutPicture{%^
  %\AtTextLowerLeft{%^
  % \color[gray]{.15}\framebox(\LenToUnit{\textwidth},\LenToUnit{\textheight}){}
  %}
  \ifbmv@review
  \bmv@ruleroffset=\textheight
  \advance\bmv@ruleroffset by 1pt
  \color[rgb]{.7,.7,1}
  \AtTextUpperLeft{%^
    \ifodd\c@page
    \put(\LenToUnit{-21pt},\LenToUnit{-\bmv@ruleroffset}){%left ruler
      \bmv@ruler{\bmv@rulercount}}
    \else
    \put(\LenToUnit{\dimexpr\textwidth+3pt},\LenToUnit{-\bmv@ruleroffset}){%right ruler
      \bmv@ruler{\bmv@rulercount}}
   % 2019 BMVC Change David Marshall Bug Fixed according to https://tex.stackexchange.com/questions/361032/illegal-unit-of-measurept-inserted-in-bmvc-paper-template
 % \put(\LenToUnit{\textwidth\kern+3pt},\LenToUnit{-\bmv@ruleroffset}){%right ruler
    %  \bmv@ruler{\bmv@rulercount}}
    \fi
  }
  \fi
}

%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%%
% Bibliography stuff.

% Natbib gives sorting of numeric references.
% We don't use the compress option, because we
% want each reference to have its own popup
\usepackage[sort,numbers]{bmvc2k_natbib}

% Compressed bibliography for the 1-pager
\ifbmv@extabs
\def\bibsection{} % No ``References'' header
\bibsep=2pt
\fi

\newif\ifbmv@annot
\bmv@annotfalse
\def\bmv@annotation{}
\definecolor{bmv@CiteBoxColor}{rgb}{1,1,1}

\def\Hy@StartlinkName#1#2{%^  #1 is object props -- ignored for us
  \ifbmv@annot%^
  \setbox\@tempboxa=\hbox{\textcolor{bmv@CiteBoxColor}{{BMVCtest~}}}%^
  \immediate\pdfxform\@tempboxa%^
  \edef\bmv@theblank{\the\pdflastxform}%^
   \pdfannot {  % This annot will be given a bounding box corresponding to
		% its surrounding hbox
    % We use a ``square'' Annot because we want it to scale with the text
    /A << /D << /S /GoTo /D (#2) >> >> ^^J
    /Subtype /Square ^^J
    /Subj (Citation) ^^J
    /CA 1.0
    /T (Citation) ^^J
    /Contents (\bmv@annotation) ^^J
    /XAP << % Appearance
      /N \bmv@theblank\space 0 R
      /D \bmv@theblank\space 0 R
      /R \bmv@theblank\space 0 R
    >> ^^J
    /Open false
   }%^
  \else
    \pdfstartlink attr{#1 /PTEX.FullName (BMVCtest) }goto name{#2}\relax
  \fi}

% hook into the natbib/hyperref citation hooks.
\ifbmv@extabs\else
\ifbmv@pdf
\newbox\bmv@citebox
\let\hyper@natlinkend=\relax
\def\hyper@natlinkstart#1{%^
  \Hy@backout{#1}%^
  \xdef\bmv@annotation{\NAT@all@names\space\NAT@date}%^
  \message{BMVC cite \bmv@annotation}%^
  %\fbox{\bmv@annotation}%^
  \bmv@annottrue%^
  \hyper@linkstart{cite}{cite.#1}%^
  \bmv@annotfalse%^
  \def\hyper@nat@current{#1}%^
}

\def\hyper@natlinkend{%^
  \Hy@endcolorlink %^
%\pdfendlink
}
\fi
\fi

\bibliographystyle{plainnat}

%------------------------------------------------------------------------------
% End of bmvc2k.cls
%------------------------------------------------------------------------------
\message{Finished loading BMVC2K}
