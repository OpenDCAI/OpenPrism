\NeedsTeXFormat{LaTeX2e}[2019/10/01]
\ProvidesClass{uai2026}[2026/08/17 UAI proceedings paper class]

%%% CONFERENCE INFORMATION
\newcommand{\@conferenceordinal}{42\textsuperscript{nd}}
\newcommand{\@conferenceyear}{2026}
\newcommand{\@conferencelocation}{Amsterdam, the Netherlands} % NOTE: not used
\newcommand{\@conferencevolume}{245}
\newcommand{\UAI@long}{%
    the \@conferenceordinal{} Conference
    on Uncertainty in Artificial Intelligence
}
\newcommand{\UAI@short}{UAI \@conferenceyear}

%%% BASE CLASS
\LoadClass[twocolumn,10pt]{article}[2019/10/25]
%% Paragraph-level typography
\setlength{\parindent}{0em} % no indent at start of paragraphs
\setlength{\parskip}{.5\baselineskip} % skip between paragraphs
\frenchspacing % no old-style large space between sentences
% NOTE: \abovedisplayskip and \belowdisplayshortskip were reduced
%       (by 3pt and 2pt respectively) in an earlier version of the style,
%       but this was not effective, actually, since at least 2008.
%       Modifying these skips reliably is tricky, so we do not do it here.
% \sloppy % TODO: better educate authors on how to fix bad boxes
%% Page-level typography
\flushbottom

%%% OPTIONS
\RequirePackage{kvoptions}[2019/11/29]
    \SetupKeyvalOptions{
        family=UAI,
        prefix=UAI@
    }
\DeclareBoolOption{accepted} % NOTE: shows authors/changes footer text
\DeclareBoolOption{proceedings} % NOTE: shows authors/changes footer text
\DeclareStringOption{startpage}[1] % NOTE: changes footer text
\DeclareStringOption{mathfont}[cm] % NOTE: for math font selection
\ProcessKeyvalOptions*

%%% PACKAGES
% TODO: Specify versions of packages.
%% Utility
\RequirePackage{xifthen} % TODO: add date
\RequirePackage{adjustbox}[2019/01/04]
\RequirePackage{environ}[2014/05/04]
    \NewEnviron{contributions}{\subsubsection*{Author Contributions}\BODY}
    \NewEnviron{acknowledgements}{\subsubsection*{Acknowledgements}\BODY}
    \NewEnviron{@uthors}{\centering\BODY}
%% Font-size
% NOTE: The UAI style (of the past) essentially used \small for footnotes.
%       We copy that behavior, but preserve \footnotesize as \smaller.
\RequirePackage{letltxmacro}[2016/05/16]
    \LetLtxMacro{\smaller}{\footnotesize}
    \renewcommand{\footnotesize}{\small}
%% Leading
% NOTE: There were font size change commands aimed at decreasing the leading
%       in the earlier UAI style file. These haven't worked as intended since
%       2008 at least. (Due to use of \def\@normalsize instead of
%       \def\normalsize.) The leading changes commented below closely
%       approximate the intent, if ever it is decided to honor the old-style
%       leading.
\RequirePackage{leading}[2008/12/11]
%     \leading{11pt} % 10pt with 11pt baselineskip
%% Page layout
\RequirePackage{geometry}[2018/04/16]
    \geometry{
        % A4 width and Letter height: prints without scaling on both
        a4paper,
        paperheight=11in,
        % mimic Morgan Kaufmann two column style
        textheight=9.25in,
        textwidth=6.75in,
        columnsep=0.25in,
        nohead, % foot kept for page numbers/notice
        footnotesep=9pt plus 4pt minus 2pt,
        % center vertically and horizontally
        % (was asymmetric in the past, outdated with electronic proceedings)
        centering
    }
    \savegeometry{uaigeometry}
\renewcommand{\footnoterule}{\kern-3pt \hrule width 5pc \kern 2.6pt}
\RequirePackage[bottom]{footmisc}[2011/06/06] % bottom floats above footnote
\RequirePackage{caption}[2019/10/18] % proper spacing before tables
%% Fonts
% NOTE: (either (fontenc–helvet with either mathptmx or times)
%        or (newtx packages)) and courier
\ifthenelse{\equal{\UAI@mathfont}{newtx}}{
    \RequirePackage[tighter]{newtxtext} % TODO: add options; version
    \RequirePackage[slantedGreek]{newtxmath} % TODO: add options; version
}{  % cm or ptmx
    \RequirePackage[T1]{fontenc}[2018/08/11]
    \RequirePackage{textcomp}[2018/08/11]
    \ifthenelse{\equal{\UAI@mathfont}{ptmx}}{  % ptmx
        \RequirePackage{mathptmx}[2005/04/12] % NOTE: Greek has wrong size
    }{  % cm (or something unkown that we replace with cm)
        \RequirePackage{times} % NOTE: reverts to Computer Modern math
    }
    \RequirePackage[scaled]{helvet}[2005/04/12] % NOTE: may give harmless warnings
}
\RequirePackage{courier}[2005/04/12]
%% Section styles
\RequirePackage[overload]{textcase}
\RequirePackage[bf,raggedright,small,pagestyles]{titlesec}[2019/10/16]
    \titleformat*{\section}{\raggedright\large\bfseries\MakeUppercase}
    \titleformat*{\subsection}{\raggedright\bfseries\MakeUppercase}
    \titlespacing{\section}{\z@}{*2.75}{*1.375}
    \titlespacing{\subsection}{\z@}{*2.75}{*1.375}
    \titlespacing{\subsubsection}{\z@}{*2.75}{*1.375}
    \titlespacing{\paragraph}{\z@}{*1.375}{1em}
    % TODO: Package to force initial caps for \subsubsection and \paragraph?
    % NOTE: We do not have pre-2021 \subsubsubsection and \subparagraph.
    %       That many levels should not be used in a 10-page paper.
%% Page styles
    \renewpagestyle{plain}{%
        % because the titling package has a hardcoded call to plain…
        \setfoot{}{\footnotesize\notice@text}{}
    }
    \newpagestyle{numbered}{%
        \setfoot{}{\thepage}{}
    }
    \pagestyle{numbered}
%% Title, authors, (absence of) date
\RequirePackage{titling}[2009/09/04]
    \setlength{\droptitle}{-2em} % undo titling package vskip of 2em
    \renewcommand{\maketitlehooka}{%
        \vbox to 2.375in\bgroup % ends in \maketitlehookd
        % TODO: make this a minimum height… (now it is fixed)
    }
    \pretitle{%
        \hrule height4pt
        \vskip .25in
        \centering
        \Large\bfseries
    }
    \posttitle{%
        \vskip .25in
        \hrule height1pt
        \vskip .25in
    }
    \renewcommand{\maketitlehookb}{\vskip 0.2in plus 1fil minus 0.1in}
    \preauthor{%
        \begin{center}
    }
%     % NOTE: We mimicked the original style using \person and template
%     %       instructions. This original style has shortcomings
%     %       (uses a lot of space for affiliation for one thing).
%     %       Therefore it was decided to move to authblk footnote style.
%     %       We leave this here for reference, for now.
%     \newcommand{\person}[2]{%
%         \begin{tabular}[t]{c}
%             \textbf{#1}\\
%             #2
%         \end{tabular}
%     }
    \postauthor{
        \end{center}
    }
    \renewcommand{\maketitlehookc}{\vskip 0.3in plus 2fil minus 0.1in}
    \predate{}
    \postdate{}
    \renewcommand{\maketitlehookd}{%
        \egroup % starts in \maketitlehooka
    }
\RequirePackage[noblocks]{authblk}[2001/02/27]
    \renewcommand{\Authfont}{\bfseries}
    \renewcommand\Affilfont{\leading{12pt}\normalfont}
    \setlength{\affilsep}{\baselineskip}
    \renewcommand{\Authsep}{\hspace{1em plus 1fil}}
    \renewcommand{\Authand}{\hspace{1em plus 1fil}}
    \renewcommand{\Authands}{\leading{18pt}\hspace{1em plus 1fil}}
%% Abstract
\renewenvironment{abstract}{
    \begin{adjustbox}{minipage=\linewidth-0.5in,center}
    \centerline{\large\bfseries Abstract}
    \vspace{2\baselineskip}
}{
    \end{adjustbox}
}
%% Lists and spacing around them
\RequirePackage[inline]{enumitem}[2019/06/20]
    % Set list spacing
    % TODO: make size-adaptive by using em and ex instead of pt?
    \setlist[1,2,3,4,5,6]{
        labelsep=5pt,
        leftmargin=2em,
        topsep=4pt plus 1pt minus 2pt,
        partopsep=1pt plus 0.5pt minus 0.5pt,
        itemsep=2pt plus 1pt minus 0.5pt,
        parsep=2pt plus 1pt minus 0.5pt
    }
    \setlist[2,3,4,5,6]{
        topsep=2pt plus 1pt minus 0.5pt,
        itemsep=1pt plus 0.5pt minus 0.5pt,
        parsep=1pt plus 0.5pt minus 0.5pt,
    }
    \setlist[3,4,5,6]{
        leftmargin=1.5em,
        topsep=1pt plus 0.5pt minus 0.5pt,
        partopsep=0.5pt plus 0pt minus 0.5pt,
        parsep=0pt
    }
    \setlist[4,5,6]{leftmargin=1em} % TODO: eliminate, too deep?
    \setlist[5,6]{leftmargin=0.5em} % TODO: eliminate, too deep?
    \setlist[6]{leftmargin=0.5em} % TODO: eliminate, too deep?
%% Typography (nicer, less badboxes)
\RequirePackage{microtype}[2019/11/18] % TODO: set some options?
%% Internal and external hyperlinks
\RequirePackage[breaklinks]{hyperref}[2019/11/10] % TODO: set some more options?

%%% ACT ON OPTIONS
\RequirePackage{lastpage}[2015/03/29]
\ifUAI@accepted % The paper has been accepted
    \ifx\UAI@startpage\@empty % No PMLR page numbers assigned yet
        \newcommand{\notice@text}{%
            %\textit{Accepted for \UAI@long} (\UAI@short). % NOTE: removed footers for accepted version, will add post-hoc
        }
        \pagestyle{empty}
    \else % PMLR page number assigned
        \newcommand{\notice@text}{%
            \textit{Proceedings of \UAI@long} (\UAI@short),
            PMLR \@conferencevolume:\UAI@startpage--\pageref*{LastPage}.
        }
        \setcounter{page}{\UAI@startpage}
        \pagestyle{numbered}
    \fi
\else % This is a submission
    \newcommand{\notice@text}{%
        \textit{Submitted to \UAI@long} (\UAI@short).
        \textbf{To be used for reviewing only}.
    }
    \pagestyle{numbered} % NOTE: page numbers are useful when reviewing
\fi

%%% ODDS AND ENDS
\AtBeginDocument{%
    \date{} % make sure no date is set
    \loadgeometry{uaigeometry} % avoid some illegal preamble changes to layout
    % TODO: add further tripwires?
    \ifUAI@accepted
    \else % This is a submission: remove authors, contributions, acknowledgements
        \renewcommand{\@author}{}
        \RenewEnviron{contributions}{}
        \RenewEnviron{acknowledgements}{}
    \fi
}
\endinput
