import { cp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve, dirname, basename } from 'node:path';
const root = resolve('dist/package');
// Remove only this generated output, so old hashed assets cannot enter a new release.
if (dirname(root) !== resolve('dist') || basename(root) !== 'package')
  throw new Error('Refusing to replace an unexpected package directory.');
await rm(root, { recursive: true, force: true });
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
await mkdir(root, { recursive: true });
await cp('dist/extension', `${root}/extension`, { recursive: true });
await cp('dist/voiceqa-host.exe', `${root}/voiceqa-host.exe`);
await cp('dist/agent-s', `${root}/agent-s`, { recursive: true });
await cp('LICENSE', `${root}/LICENSE`);
await cp('README.md', `${root}/PROJECT_README.md`);
await cp('docs', `${root}/docs`, { recursive: true });
await cp('demo', `${root}/demo`, { recursive: true });
await mkdir(`${root}/licenses`, { recursive: true });
for (const name of [
  'react',
  'react-dom',
  'axe-core',
  'ajv',
  'motion',
  'framer-motion',
  'motion-dom',
  'motion-utils',
  'lucide-react',
  '@fontsource-variable/inter',
]) {
  const files = (await readdir(`node_modules/${name}`)).filter((file) =>
    /^(license|copying|notice|ofl)(\.|$)/i.test(file),
  );
  for (const file of files)
    await cp(
      `node_modules/${name}/${file}`,
      `${root}/licenses/${name.replaceAll('/', '-')}-${file}`,
    );
}
// License the modules actually linked into the host. Enumerating the entire
// module graph also fetches unused upstream test dependencies during packaging.
const modules = [
  ...new Set(
    execFileSync(
      'go',
      [
        'list',
        '-deps',
        '-f',
        '{{with .Module}}{{.Path}}|{{.Version}}|{{.Dir}}{{end}}',
        './companion/cmd/voiceqa',
      ],
      { encoding: 'utf8' },
    )
      .trim()
      .split(/\r?\n/)
      .filter(Boolean),
  ),
];
const notices = [
  'Optional Agent S3 browser adapter: Apache-2.0, upstream revision 15776a8dc659658b1963816ea006f7af1978e595. License and source included in agent-s/vendor. Python dependencies are installed separately from pinned requirements; the runtime is not bundled.',
  'VoiceQA includes the following open-source components. Their licenses are included in this folder.',
  'JavaScript runtime: React, React DOM, axe-core, Motion, Lucide React. Local font: Inter (Fontsource). Build-time schema generation: Ajv.',
];
const goRoot = execFileSync('go', ['env', 'GOROOT'], { encoding: 'utf8' }).trim();
await cp(`${goRoot}/LICENSE`, `${root}/licenses/go-standard-library-LICENSE`);
notices.push(
  'Go standard library: BSD-3-Clause; its license is included. CodeRabbit CLI is a separate development service and is not bundled.',
);
for (const entry of modules) {
  const [name, version, dir] = entry.split('|');
  if (!version || !dir) continue;
  notices.push(`${name} ${version}`);
  const files = (await readdir(dir)).filter((file) =>
    /^(license|copying|notice)([.-]|$)/i.test(file),
  );
  for (const file of files) {
    await cp(`${dir}/${file}`, `${root}/licenses/go-${name.replaceAll('/', '-')}-${file}`);
  }
}
await writeFile(`${root}/THIRD-PARTY-NOTICES.txt`, notices.join('\n'));
for (const name of [
  'install-host.ps1',
  'uninstall-host.ps1',
  'check-host.ps1',
  'run-demo.ps1',
  'install-agent-s.ps1',
]) {
  let source = await readFile(`scripts/${name}`, 'utf8');
  source = source
    .replace(
      "$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path",
      '$projectRoot = $PSScriptRoot',
    )
    .replace("'dist\\voiceqa-host.exe'", "'voiceqa-host.exe'")
    .replace("'dist\\native-host.json'", "'native-host.json'");
  if (name === 'install-agent-s.ps1')
    source = source.replace("Join-Path $projectRoot 'dist'", '$projectRoot');
  await writeFile(`${root}/${name}`, source);
}
await writeFile(
  `${root}/INSTALL.txt`,
  `VoiceQA ${version}\r\n\r\n1. Chrome > chrome://extensions > Developer mode > Load unpacked > extension folder.\r\n2. Run: powershell -NoProfile -ExecutionPolicy Bypass -File .\\install-host.ps1 -ExtensionId YOUR_ID\r\n3. Open the side panel. The connection screen shows your extension ID and a setup command. Choose Retry connection.\r\n4. On a website, choose Share current tab in the bottom composer and configure your API key using the top-right settings gear.\r\n5. Optional RelayDesk benchmark: install Node.js 24+, then run powershell -NoProfile -File .\\run-demo.ps1 and open http://127.0.0.1:4173/.\r\n6. Review the plan before running. Use a dedicated QA profile and synthetic data.\r\n\r\nDiagnostic: powershell -NoProfile -File .\\check-host.ps1 -ExtensionId YOUR_ID\r\nKeep this folder in place: Chrome starts the executable at its installed path.\r\n`,
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
