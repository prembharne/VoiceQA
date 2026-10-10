import { cp, mkdir, readFile, writeFile, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
const root = resolve('dist/package');
await mkdir(root, { recursive: true });
await cp('dist/extension', `${root}/extension`, { recursive: true });
await cp('dist/voiceqa-host.exe', `${root}/voiceqa-host.exe`);
await cp('LICENSE', `${root}/LICENSE`);
await cp('README.md', `${root}/PROJECT_README.md`);
await mkdir(`${root}/licenses`, { recursive: true });
for (const name of ['react', 'react-dom', 'axe-core', 'ajv']) {
  await cp(`node_modules/${name}/LICENSE`, `${root}/licenses/${name}.txt`).catch(async () => {
    await cp(`node_modules/${name}/LICENSE.txt`, `${root}/licenses/${name}.txt`);
  });
}
const modules = execFileSync('go', ['list', '-m', '-f', '{{.Path}}|{{.Version}}|{{.Dir}}', 'all'], {
  encoding: 'utf8',
})
  .trim()
  .split(/\r?\n/);
const notices = [
  'VoiceQA includes the following open-source components. Their licenses are included in this folder.',
  'JavaScript runtime: React, React DOM, axe-core; build-time schema generation: Ajv.',
];
for (const entry of modules) {
  const [name, version, dir] = entry.split('|');
  if (!version || !dir) continue;
  notices.push(`${name} ${version}`);
  const files = (await readdir(dir)).filter((file) =>
    /^(license|copying|notice)(\.|$)/i.test(file),
  );
  for (const file of files) {
    await cp(`${dir}/${file}`, `${root}/licenses/go-${name.replaceAll('/', '-')}-${file}`);
  }
}
await writeFile(`${root}/THIRD-PARTY-NOTICES.txt`, notices.join('\n'));
for (const name of ['install-host.ps1', 'uninstall-host.ps1']) {
  let source = await readFile(`scripts/${name}`, 'utf8');
  source = source
    .replace(
      "$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path",
      '$projectRoot = $PSScriptRoot',
    )
    .replace("'dist\\voiceqa-host.exe'", "'voiceqa-host.exe'")
    .replace("'dist\\native-host.json'", "'native-host.json'");
  await writeFile(`${root}/${name}`, source);
}
await writeFile(
  `${root}/INSTALL.txt`,
  'VoiceQA 0.1.0\r\n\r\n1. Chrome > chrome://extensions > Developer mode > Load unpacked > extension folder.\r\n2. Copy its ID and run: powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-host.ps1 -ExtensionId YOUR_ID\r\n3. Open the side panel on a website, choose Test this tab, and configure your API key in Local setup.\r\n4. Review the plan before running. Use a dedicated QA profile and synthetic data.\r\n\r\nKeep this folder in place: Chrome starts the executable at its installed path.\r\n',
);
await cp('docs/VALIDATION.md', `${root}/VALIDATION.md`);
if (process.platform === 'win32')
  execFileSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      'Compress-Archive -LiteralPath $env:VOICEQA_PACKAGE_PATH -DestinationPath $env:VOICEQA_ZIP_PATH -Force',
    ],
    {
      env: {
        ...process.env,
        VOICEQA_PACKAGE_PATH: root,
        VOICEQA_ZIP_PATH: resolve('dist/voiceqa-windows.zip'),
      },
    },
  );
console.log('Packaged VoiceQA in dist/package and dist/voiceqa-windows.zip');
