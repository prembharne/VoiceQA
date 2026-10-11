import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

async function run(binary, args) {
  return new Promise((done, reject) => {
    const child = spawn(binary, args, { shell: false, windowsHide: true });
    let output = '';
    child.stdout.on('data', (data) => {
      output += data;
    });
    child.stderr.on('data', (data) => {
      process.stderr.write(data);
    });
    child.on('error', reject);
    child.on('close', (code) => done({ code, output }));
  });
}
try {
  if (!process.env.npm_execpath) throw new Error('Run this check using npm run security:check.');
  await mkdir('.tools', { recursive: true });
  const audit = await run(process.execPath, [process.env.npm_execpath, 'audit', '--json']);
  await writeFile(resolve('.tools/npm-audit.json'), audit.output);
  let result;
  try {
    result = JSON.parse(audit.output);
  } catch {
    throw new Error('Dependency audit did not return a valid report.');
  }
  if (result.error || !result.metadata?.vulnerabilities)
    throw new Error('Dependency audit failed; missing results are not a clean scan.');
  const counts = result.metadata.vulnerabilities;
  console.log(
    `npm dependency findings: ${counts.high} high, ${counts.critical} critical, ${counts.moderate} moderate, ${counts.low} low.`,
  );
  const go = await run('go', [
    'run',
    'golang.org/x/vuln/cmd/govulncheck@v1.8.0',
    './companion/...',
  ]);
  await writeFile(resolve('.tools/govulncheck.txt'), go.output);
  process.stdout.write(go.output);
  if (counts.high || counts.critical || go.code !== 0)
    throw new Error('Security dependency checks failed. Review the reports in .tools.');
  console.log(
    'Dependency checks completed. Browser logic tests and source review remain separate checks.',
  );
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
