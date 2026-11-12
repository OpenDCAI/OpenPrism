import { expect, test } from '@playwright/test';
import { newAccount, setWorkspaceLlm, newWorkspace, setActiveWorkspace, signIn } from './helpers';

// Load models and Test in the workspace AI provider form (#76). The provider itself is not reachable from the test stack
// (the endpoint must resolve to a public address), so the two API calls are stubbed at the network; the server side has
// its own tests (integrations/test_provider.py). What matters here: what the browser sends, what it shows, and that
// saving never depends on either button.

test('an admin loads the provider\'s models, picks one, tests it and saves', async ({ page }) => {
  const session = await newAccount('wsai-check');
  await signIn(page, session);
  const seen: { models: any[]; test: any[] } = { models: [], test: [] };
  await page.route('**/api/workspaces/*/llm/models', async (route) => {
    seen.models.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, models: ['gpt-4o', 'gpt-4o-mini', 'o3'] } });
  });
  await page.route('**/api/workspaces/*/llm/test', async (route) => {
    seen.test.push(route.request().postDataJSON());
    await route.fulfill({ json: { ok: true, latencyMs: 321 } });
  });

  await page.goto('/projects?section=settings');
  const block = page.getByTestId('ws-ai');
  await block.getByLabel('Endpoint').fill('https://api.openai.com/v1');
  await block.getByLabel('API key').fill('sk-typed-key-4321');

  // the test needs a model; the models list does not
  await expect(block.getByTestId('ws-ai-test')).toBeDisabled();
  await block.getByTestId('ws-ai-load-models').click();
  await expect(block.getByTestId('ws-ai-models-result')).toContainText('3 models loaded');
  await expect(block.getByTestId('ws-ai-model-list').locator('option')).toHaveCount(3);
  expect(seen.models).toEqual([{ endpoint: 'https://api.openai.com/v1', model: '', apiKey: 'sk-typed-key-4321' }]);

  // pick from the list, then test
  await block.getByLabel('Model').fill('gpt-4o-mini');
  await block.getByTestId('ws-ai-test').click();
  await expect(block.getByTestId('ws-ai-test-result')).toContainText('answered in 321 ms');
  await expect(block.getByTestId('ws-ai-test-result')).toHaveAttribute('data-ok', 'true');
  expect(seen.test[0]).toMatchObject({ model: 'gpt-4o-mini', apiKey: 'sk-typed-key-4321' });

  // the key is only in the password field, never in the result text
  await expect(block.getByTestId('ws-ai-test-result')).not.toContainText('sk-typed-key');

  // saving works and clears the transient result; afterwards the key is nowhere in the page
  await block.getByRole('button', { name: 'Save' }).click();
  await expect(block.getByTestId('ws-ai-key-set')).toContainText('ending 4321');
  expect(await page.content()).not.toContain('sk-typed-key-4321');
  await expect(block.getByTestId('ws-ai-test-result')).toHaveCount(0);
});

test('a provider without a model list still works: type the model, test, and the provider\'s error is shown', async ({ page }) => {
  const session = await newAccount('wsai-check2');
  await signIn(page, session);
  await page.route('**/api/workspaces/*/llm/models', (route) =>
    route.fulfill({ json: { ok: false, error: 'The provider answered 404: not found' } }));
  let calls = 0;
  await page.route('**/api/workspaces/*/llm/test', (route) => {
    calls += 1;
    return route.fulfill({ json: calls === 1 ? { ok: false, error: 'The provider refused the key (401). Incorrect API key' } : { ok: true, latencyMs: 90 } });
  });

  await page.goto('/projects?section=settings');
  const block = page.getByTestId('ws-ai');
  await block.getByLabel('Endpoint').fill('https://example-azure.openai.test/openai');
  await block.getByLabel('API key').fill('sk-whatever-1111');
  await block.getByTestId('ws-ai-load-models').click();
  await expect(block.getByTestId('ws-ai-models-result')).toContainText('404');
  await expect(block.getByTestId('ws-ai-models-result')).toHaveAttribute('data-ok', 'false');
  await expect(block.getByLabel('Model')).toBeEditable();            // free text stays

  await block.getByLabel('Model').fill('my-deployment');
  await block.getByTestId('ws-ai-test').click();
  await expect(block.getByTestId('ws-ai-test-result')).toContainText('Incorrect API key');
  await block.getByTestId('ws-ai-test').click();                      // advice, not a gate: try again
  await expect(block.getByTestId('ws-ai-test-result')).toContainText('answered in 90 ms');
});

test('with a saved provider the buttons work without retyping the key', async ({ page }) => {
  const admin = await newAccount('wsai-check3');
  const ws = await newWorkspace(admin, 'Lab');
  await setWorkspaceLlm(admin, ws, { endpoint: 'https://api.openai.com/v1', model: 'gpt-lab', apiKey: 'sk-lab-key-9999' });
  await signIn(page, admin);
  await setActiveWorkspace(page, admin, ws);
  let body: any = null;
  await page.route('**/api/workspaces/*/llm/test', (route) => {
    body = route.request().postDataJSON();
    return route.fulfill({ json: { ok: true, latencyMs: 12 } });
  });
  await page.goto('/projects?section=settings');
  const block = page.getByTestId('ws-ai');
  await expect(block.getByTestId('ws-ai-key-set')).toContainText('ending 9999');
  await block.getByTestId('ws-ai-test').click();
  await expect(block.getByTestId('ws-ai-test-result')).toContainText('12 ms');
  // no key is sent: the server uses the stored one because the endpoint is the saved one (shown in its chat-completions form)
  expect(body).toEqual({ endpoint: 'https://api.openai.com/v1/chat/completions', model: 'gpt-lab' });
});
