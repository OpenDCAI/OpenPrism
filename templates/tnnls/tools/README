
August 26, 2015


The IEEEtrantools.sty package provides several commands from the
IEEEtran.cls file so that they can be used under other LaTeX classes. The
user guide provided here covers only the differences in the use of the
commands from those provided by IEEEtran.cls. For complete documentation
on these commands, see the relevant sections in the IEEEtran_HOWTO manual
of the IEEEtran LaTeX class.

The IEEEtrantools.sty package provides the following IEEEtran.cls commands:

 1. \IEEEPARstart which produces large initial "drop cap" letters.

 2. The \bstctlcite command for the control entry types of IEEEtran.bst
    V1.00 and later.

 3. The \IEEEnoauxwrite command.

 4. The IEEE itemize, enumerate and description list environments.

 5. The complete IEEEeqnarray family for producing multiline equations
    as well as matrices and tables, including the IEEEeqnarray support
    commands.

 6. The \IEEEQEDhere and \IEEEQEDhereams commands to provide amsthm.sty
    \qedhere functionality to IEEEproof. \IEEEQEDhere is for simple use
    "right on the spot" such as within an IEEEeqnarry:

    \begin{IEEEproof}
       \begin{IEEEeqnarray}{rCl+x*}
        x & = & y & \nonumber\IEEEQEDhere
       \end{IEEEeqnarray}
    \end{IEEEproof}

    While \IEEEQEDhereams is like amsthm's venerable \qedhere and is
    for use within the standard equation environment:

    \begin{IEEEproof}
     \begin{equation}
       x = y \nonumber\IEEEQEDhereams\quad
     \end{equation}
    \end{IEEEproof}

    Note that the qedhere style is normally not done with IEEE-related
    work so these are undocumented features of IEEEtran.cls.

    Thanks Mark D. Butala, Hennadiy Leontyev and Stefan M. Moser for
    suggesting this feature.



IEEEtrantools.sty is not needed and should not be used with IEEEtran.cls.

For helpful tips, answers to frequently asked questions and other support,
visit the IEEEtrantools support page at my website:

http://www.michaelshell.org/tex/ieeetran/tools/


Enjoy!

Michael Shell
http://www.michaelshell.org/


*******
2015/08/26 V1.5 (V1.8b of IEEEtran.cls) changes:

 1) Revised IEEEeqnarray column specifications to work with active " 
    (or other punctuation catcode changes) as with babel under the
    german or ngerman language modes. 
    Thanks to Stefan M. Moser for reporting this problem.

 2) Fix bug with IEEEeqnarray equation number foreground color
    under the color environment of Beamer class.
    Thanks to Joschi Brauchle for reporting this problem.

 3) Added the \IEEEnoauxwrite command.
    Thanks to Sudarshan Mukherjee for suggesting this feature.



********************************** Files **********************************

README                - This file.

changelog.txt         - The revision history.

IEEEtrantools.sty     - The LaTeX package file.

IEEEtrantools_doc.txt - The user manual - supplementary to the 
                        IEEEtran_HOWTO manual.

***************************************************************************
Legal Notice:
This code is offered as-is without any warranty either expressed or
implied; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE! 
User assumes all risk.
In no event shall the IEEE or any contributor to this code be liable for
any damages or losses, including, but not limited to, incidental,
consequential, or any other damages, resulting from the use or misuse
of any information contained here.

All comments are the opinions of their respective authors and are not
necessarily endorsed by the IEEE.

This work is distributed under the LaTeX Project Public License (LPPL)
( http://www.latex-project.org/ ) version 1.3, and may be freely used,
distributed and modified. A copy of the LPPL, version 1.3, is included
in the base LaTeX documentation of all distributions of LaTeX released
2003/12/01 or later.
Retain all contribution notices and credits.
** Modified files should be clearly indicated as such, including  **
** renaming them and changing author support contact information. **

File list of work: IEEEtrantools.sty, IEEEtrantools_doc.txt
***************************************************************************

