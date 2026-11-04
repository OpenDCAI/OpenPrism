"""Worker-side implementations. Each takes a Job and per-call secrets and returns the response body the
Node endpoint used to return ({ok, ...}); the task stores it as job.result."""
import base64
import posixpath

from projects import files as pfiles
from projects import storage
from projects.paths import InvalidPath, safe_path, sanitize_upload_path

from . import agent, llm, plot
from .i18n import t

VISION_PROMPTS = {
    'table': 'Convert the table in the image to LaTeX tabular/table. Output only the table environment (no document, no preamble, no extra text).',
    'algorithm': 'Convert the algorithm in the image to LaTeX algorithm/algorithmic. Output only the algorithm environment (no document, no extra text).',
    'ocr': 'Extract the text from the image and return clean LaTeX-safe text. Output only text.',
    'equation': 'Convert the formula in the image to LaTeX equation environment. Output only the equation environment (no document, no extra text).',
}


def llm_config(job, secrets):
    return {**(job.params.get('llmConfig') or {}), 'apiKey': (secrets or {}).get('apiKey', '')}


def handle_llm(job, secrets):
    p = job.params
    cfg = llm_config(job, secrets)
    if p.get('model') and not cfg.get('model'):
        cfg['model'] = p['model']
    return llm.chat(p.get('messages') or [], cfg)


def handle_agent(job, secrets):
    from jobs.models import Job
    from jobs.tasks import add_progress
    return agent.run(job.params, job.project, llm_config(job, secrets), job.params.get('lang') or 'en-US',
                     progress=lambda message: add_progress(job, message),
                     cancelled=lambda: Job.objects.filter(pk=job.pk, result__cancelled=True).exists())


def handle_vision(job, secrets):
    p = job.params
    image = storage.get_bytes(p['imageKey'])
    asset_path = ''
    if job.project_id and p.get('saveToProject'):
        try:
            name = sanitize_upload_path(p.get('imageName') or '') or 'image.png'
            asset_path = posixpath.join('assets', name)
            pfiles.write_binary(job.project, asset_path, image, p.get('imageType'))
        except (InvalidPath, IsADirectoryError):
            asset_path = ''
    mode = p.get('mode') or 'equation'
    if mode == 'figure':
        instruction = (f"Generate a LaTeX figure environment using {asset_path or 'the image file'} with caption and label. "
                       'Output only the figure environment (no document, no extra text).')
    else:
        instruction = VISION_PROMPTS.get(mode, VISION_PROMPTS['equation'])
    note = p.get('prompt')
    data_url = f"data:{p.get('imageType') or 'image/png'};base64,{base64.b64encode(image).decode()}"
    messages = [
        {'role': 'system', 'content': 'You are a LaTeX conversion engine. Return only LaTeX or plain text without explanations.'},
        {'role': 'user', 'content': [
            {'type': 'text', 'text': f'{instruction}\n\nUser note: {note}' if note else instruction},
            {'type': 'image_url', 'image_url': {'url': data_url}}]},
    ]
    res = llm.chat(messages, llm_config(job, secrets))
    if not res['ok']:
        return {'ok': False, 'error': res['error']}
    return {'ok': True, 'latex': res['content'], 'assetPath': asset_path}


PLOT_SYSTEM = ' '.join([
    'You generate python plotting code using matplotlib (and seaborn if available).',
    'You are given: rows (list of rows), header (list of column names).',
    'If pandas is available, df and df_numeric are provided; otherwise df is None.',
    'Do not import packages. Do not call plt.savefig.',
    'Use chart_type if helpful.',
    'Return ONLY python code.'])


def handle_plot(job, secrets):
    p = job.params
    cfg = llm_config(job, secrets)
    if not llm.resolve_config(cfg)['api_key']:
        return {'ok': False, 'error': 'OPENPRISM_LLM_API_KEY not set'}
    asset_path = p['assetPath']
    code, last_error = '', ''
    for _ in range(int(p.get('retries', 2)) + 1):
        user = '\n'.join(x for x in [
            f"chart_type: {p.get('chartType') or 'bar'}",
            f"user_prompt: {p['prompt']}" if p.get('prompt') else '',
            f'runtime_error:\n{last_error}' if last_error else '',
            f'previous_code:\n{code}' if code else ''] if x)
        res = llm.chat([{'role': 'system', 'content': PLOT_SYSTEM}, {'role': 'user', 'content': user}], cfg)
        if not res['ok'] or not res['content']:
            return {'ok': False, 'error': res.get('error') or 'Plot code generation failed.'}
        code = res['content'].replace('```python', '').replace('```', '').strip()
        out = plot.render(p['tableLatex'], code, p.get('chartType') or 'bar', p.get('title') or '')
        if out['ok']:
            pfiles.write_binary(job.project, asset_path, out['png'], 'image/png')
            return {'ok': True, 'assetPath': asset_path}
        last_error = out['error'] or 'Plot render failed.'
    return {'ok': False, 'error': last_error or 'Plot render failed.'}


HANDLERS = {'llm': handle_llm, 'agent': handle_agent, 'vision': handle_vision, 'plot': handle_plot}
