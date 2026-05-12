export const TEMPLATE_CONFIGS = {
    acl: {
        preferredMainNames: ['acl_latex.tex', 'acl_lualatex.tex'],
        defaultBibliographystyle: '\\bibliographystyle{acl_natbib}',
        skipPackages: new Set(['acl', 'times']),
        sourceStripPackages: new Set(['acl', 'times']),
        sourceStripCommands: [],
        stripMacros: ['title', 'author', 'date'],
    },
    neurips: {
        preferredMainNames: ['neurips_2026.tex'],
        defaultBibliographystyle: '\\bibliographystyle{plainnat}',
        skipPackages: new Set(['neurips_2026', 'times']),
        sourceStripPackages: new Set(['neurips_2026', 'times']),
        sourceStripCommands: [],
        stripMacros: ['title', 'author', 'date', 'pdfinfo'],
    },
    icml: {
        preferredMainNames: ['example_paper.tex'],
        defaultBibliographystyle: '\\bibliographystyle{icml2026}',
        skipPackages: new Set(['icml2026', 'times', 'algorithm', 'algorithmicx', 'algpseudocode']),
        sourceStripPackages: new Set(['icml2026', 'times']),
        sourceStripCommands: [],
        stripMacros: ['title', 'author', 'date', 'icmltitlerunning'],
    },
    iclr: {
        preferredMainNames: ['iclr2026_conference.tex'],
        defaultBibliographystyle: '\\bibliographystyle{iclr2026_conference}',
        skipPackages: new Set(['iclr2026_conference', 'times']),
        sourceStripPackages: new Set(['iclr2026_conference', 'times']),
        sourceStripCommands: [],
        stripMacros: ['title', 'author', 'date'],
    },
    cvpr: {
        preferredMainNames: ['main.tex'],
        defaultBibliographystyle: '\\bibliographystyle{ieeenat_fullname}',
        skipPackages: new Set(['cvpr']),
        sourceStripPackages: new Set(['cvpr', 'axessibility']),
        sourceStripCommands: [],
        stripMacros: ['title', 'author', 'date'],
    },
    aaai: {
        preferredMainNames: [
            'anonymous-submission-latex-2026.tex',
            'Formatting-Instructions-LaTeX-2026.tex',
        ],
        defaultBibliographystyle: '',
        skipPackages: new Set([
            'aaai2026',
            'times',
            'helvet',
            'courier',
            'url',
            'graphicx',
            'natbib',
            'caption',
            'algorithm',
            'algorithmicx',
            'algpseudocode',
            'hyperref',
            'fontenc',
        ]),
        sourceStripPackages: new Set([
            'aaai2026',
            'times',
            'helvet',
            'courier',
            'url',
            'natbib',
            'caption',
        ]),
        sourceStripCommands: ['nocopyright'],
        stripMacros: ['title', 'author', 'date', 'affiliations', 'pdfinfo'],
    },
    generic: {
        preferredMainNames: [],
        defaultBibliographystyle: '\\bibliographystyle{plainnat}',
        skipPackages: new Set(['times']),
        sourceStripPackages: new Set(),
        sourceStripCommands: [],
        stripMacros: ['title', 'author', 'date'],
    },
};
export const CONFERENCE_TO_FAMILY = {
    acl: 'acl',
    emnlp: 'acl',
    neurips: 'neurips',
    nips: 'neurips',
    icml: 'icml',
    iclr: 'iclr',
    cvpr: 'cvpr',
    iccv: 'cvpr',
    aaai: 'aaai',
};
export function getTemplateConfig(kind) {
    return TEMPLATE_CONFIGS[kind] || TEMPLATE_CONFIGS.generic;
}
export function normalizeConferenceName(name) {
    const lowered = String(name || '').trim().toLowerCase();
    if (!(lowered in CONFERENCE_TO_FAMILY)) {
        throw new Error(`Unsupported conference alias: ${name}`);
    }
    return lowered;
}
export function conferenceFamily(name) {
    return CONFERENCE_TO_FAMILY[normalizeConferenceName(name)];
}
