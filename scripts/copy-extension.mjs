import { cp, copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
await mkdir('dist/extension', { recursive: true });
const manifest = JSON.parse(await readFile('extension/manifest.json', 'utf8'));
await writeFile('dist/extension/manifest.json', JSON.stringify(manifest, null, 2));
for (const name of ['content.js', 'axe.min.js']) {
  await copyFile(
    name === 'axe.min.js' ? 'node_modules/axe-core/axe.min.js' : `extension/${name}`,
    `dist/extension/${name}`,
  );
}
console.log('Extension assembled in dist/extension');
await cp('agent_s', 'dist/agent-s', {
  recursive: true,
  filter: (source) => !source.includes('__pycache__') && !source.endsWith('.pyc'),
});
