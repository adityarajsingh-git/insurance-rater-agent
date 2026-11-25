// The committed traces/ files are the submitted outputs for the four sample policies. This keeps
// them honest: if the engine or a grid changes, the test fails until `npm run traces` is re-run.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { SAMPLES, renderMarkdown, sampleOutput } from '../scripts/traces';

describe('committed decision traces', () => {
  it.each(SAMPLES)('%s matches the current engine', (name) => {
    const out = sampleOutput(name);
    expect(JSON.parse(readFileSync(`traces/${name}.json`, 'utf8'))).toEqual(JSON.parse(JSON.stringify(out)));
    expect(readFileSync(`traces/${name}.md`, 'utf8')).toBe(renderMarkdown(name, out));
  });
});
