import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { readFile } from 'node:fs/promises';

// Exercise the real client in workerd. Constructing a native Request catches
// unsupported fetch options before returning an offline upstream fixture.
test('TfL request options work in Workers and preserve redirect/disambiguation handling', async () => {
  const config = JSON.parse(await readFile(new URL('../wrangler.jsonc', import.meta.url), 'utf8'));
  const bundle = await build({
    stdin: { contents: `
      import { createTflClient } from './src/tfl.js';
      export default { async fetch(input) {
        const status = Number(new URL(input.url).searchParams.get('status'));
        let calls = 0;
        const client = createTflClient({ TFL_API_KEY: 'fixture-key' }, {
          fetcher: async (url, init) => {
            calls++;
            const request = new Request(url, init);
            if (request.redirect !== 'manual') throw new Error('Redirects must not be followed');
            return Response.json({ fixture: true }, { status,
              headers: status === 302 ? { Location: 'https://example.invalid/' } : {} });
          }
        });
        try { return Response.json({ result: await client('/Line/northern/Status'), calls }); }
        catch (error) { return Response.json({ code: error.code, calls }); }
      }};`, resolveDir: process.cwd(), sourcefile: 'runtime-fixture.js' },
    bundle: true, write: false, format: 'esm', platform: 'browser',
  });
  const mf = new Miniflare({ workers: [{ config: {
    name: 'tfl-runtime-test', compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    manifest: { mainModule: 'index.js', modules: {
      'index.js': { type: 'esm', contents: bundle.outputFiles[0].text },
    } },
  } }] });
  try {
    for (const status of [200, 300, 302]) {
      const response = await mf.dispatchFetch(`http://localhost/?status=${status}`);
      const data = await response.json();
      assert.equal(data.calls, 1);
      if (status === 302) assert.equal(data.code, 'upstream_error');
      else {
        assert.equal(data.code, undefined, JSON.stringify(data));
        assert.equal(data.result.status, status);
        assert.deepEqual(data.result.data, { fixture: true });
      }
      assert.doesNotMatch(JSON.stringify(data), /fixture-key/);
    }
  } finally { await mf.dispose(); }
});
