// @vitest-environment node
// Runs scripts/check-readme-toc.mjs as `pnpm check:readme` does: on the real README, and on small samples written to a
// temporary folder, one right and one wrong in each way the check looks for.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = fileURLToPath(new URL('./check-readme-toc.mjs', import.meta.url));
const dir = mkdtempSync(join(tmpdir(), 'readme-toc-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function check(markdown?: string): { status: number | null; out: string } {
  const args = [SCRIPT];
  if (markdown !== undefined) {
    const file = join(dir, `sample-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(file, markdown);
    args.push(file);
  }
  const r = spawnSync(process.execPath, args, { encoding: 'utf8' });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

/** Repeated headings, punctuation, code in a heading, a lower-level repeat and a fenced "# comment" that is no heading. */
const GOOD = `# Sample app

## Contents

- [Sample app](#sample-app)
  - [Install and uninstall](#install-and-uninstall)
  - [Microsoft Store build: where your data lives](#microsoft-store-build-where-your-data-lives)
  - [Tests](#tests-1)
  - [The \`zWorkTracker/versions\` folder](#the-zworktrackerversions-folder)
  - [Windows 10 and 11, step 2.](#windows-10-and-11-step-2)

## Install and uninstall

### Tests

\`\`\`sh
# Not a heading
\`\`\`

## Microsoft Store build: where your data lives

## Tests

## The \`zWorkTracker/versions\` folder

## Windows 10 and 11, step 2.
`;

describe('check-readme-toc', () => {
  it('passes on the real README', () => {
    const r = check();
    expect(r.out).toContain('matches every # and ## heading');
    expect(r.status).toBe(0);
  });

  it('works out anchors as GitHub does, numbering repeats across every level', () => {
    const r = check(GOOD);
    expect(r.out).toContain('matches');
    expect(r.status).toBe(0);
  });

  it('fails on a link to no heading and on a heading left out', () => {
    const bad = GOOD.replace('(#tests-1)', '(#tests)').replace('(#install-and-uninstall)', '(#install-uninstall)').replace('  - [Windows 10 and 11, step 2.](#windows-10-and-11-step-2)\n', '');
    const r = check(bad);
    expect(r.status).toBe(1);
    expect(r.out).toContain('goes to #install-uninstall, and no heading has that anchor');
    expect(r.out).toContain('"Install and uninstall" (#install-and-uninstall) is missing');
    expect(r.out).toContain('"Windows 10 and 11, step 2." (#windows-10-and-11-step-2) is missing');
    // #tests is a real anchor (the ### heading), so the link is not reported, but the ## Tests it was meant for is.
    expect(r.out).not.toContain('goes to #tests,');
    expect(r.out).toContain('"Tests" (#tests-1) is missing');
  });

  it('fails when there is no table of contents', () => {
    const r = check('# Sample app\n\n## Install\n');
    expect(r.status).toBe(1);
    expect(r.out).toContain('No "Contents" heading');
  });

  it('treats a "# comment" inside a fenced block as code, not a heading', () => {
    const r = check(`# App\n\n## Contents\n\n- [App](#app)\n\n\`\`\`sh\n# Read a sample back\n\`\`\`\n`);
    expect(r.status).toBe(0);
  });
});
