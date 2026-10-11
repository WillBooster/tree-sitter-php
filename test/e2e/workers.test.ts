import path from 'node:path';

import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { createTestHarness, type TestHarness } from 'wrangler';

import { ExpectedTrees } from '../fixtures/parse.js';

// The same Worker with and without Node.js compatibility, since the package must run in both.
const Configs = {
  'tree-sitter-php-test': 'wrangler.jsonc',
  'tree-sitter-php-test-no-nodejs-compat': 'wrangler.no-nodejs-compat.jsonc',
};

let harness: TestHarness | undefined;

beforeAll(async () => {
  harness = createTestHarness({
    workers: Object.values(Configs).map((config) => ({
      configPath: path.join(import.meta.dirname, '../fixtures/worker', config),
    })),
  });
  await harness.listen();
}, 120_000);

afterAll(async () => {
  await harness?.close();
});

describe.each(Object.keys(Configs))('in Cloudflare Workers with the imported Wasm modules (%s)', (name) => {
  test.each(Object.entries(ExpectedTrees))('parses with the %s grammar', async (grammar, { source, tree }) => {
    const response = await harness!.getWorker(name).fetch(`http://localhost/${grammar}`, {
      method: 'POST',
      body: source,
    });
    expect(await response.text()).toBe(tree);
  });
});
