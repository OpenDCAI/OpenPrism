/** Which file a project opens first. The main file a person chose is remembered per project in this browser. */
export const mainFileKey = (projectId: string) => `openprism-main-file:${projectId}`;

export function rememberedMainFile(projectId: string): string | null {
  try {
    return window.localStorage.getItem(mainFileKey(projectId));
  } catch {
    return null; // storage unavailable
  }
}

interface TreeItem { path: string; type: string }

/**
 * The file to open when a project is opened: the remembered main file if it still exists, else a `main.tex`, else the
 * first `.tex` file, else the first file. The same order the editor uses to choose the main file itself.
 */
export function pickInitialFile(items: TreeItem[], projectId: string): string {
  const files = items.filter((item) => item.type === 'file').map((item) => item.path);
  const remembered = rememberedMainFile(projectId);
  if (remembered && files.includes(remembered)) return remembered;
  const tex = files.filter((path) => path.toLowerCase().endsWith('.tex'));
  return tex.find((path) => path.endsWith('main.tex')) || tex[0] || files[0] || '';
}
