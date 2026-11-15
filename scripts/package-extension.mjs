#!/usr/bin/env node
/**
 * Package the editor extension as a .vsix.
 *
 *   npm run extension:package
 *
 * A .vsix is a zip with two files of its own at the root — a manifest saying
 * what the extension is, and a list of the kinds of file inside — and the
 * extension under extension/. That is all the official packager produces for
 * an extension with no dependencies and nothing to compile, so it is written
 * here with the zip writer the room already has, rather than fetching a tool
 * to do it.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { zip } from '../src/skillpack.js';

const here = dirname(fileURLToPath(import.meta.url));
const xml = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));

/** What goes in, and under what name: a file with no extension has no declared type, so the licence gets one. */
const FILES = [
  ['package.json', 'package.json'],
  ['extension.js', 'extension.js'],
  ['room.js', 'room.js'],
  ['README.md', 'README.md'],
  ['LICENSE', 'LICENSE.txt'],
];

export function buildVsix(dir = join(here, '..', 'extensions', 'vscode')) {
  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const id = `${pkg.publisher}.${pkg.name}`;

  const manifest = `<?xml version="1.0" encoding="utf-8"?>
<PackageManifest Version="2.0.0" xmlns="http://schemas.microsoft.com/developer/vsx-schema/2011" xmlns:d="http://schemas.microsoft.com/developer/vsx-schema-design/2011">
  <Metadata>
    <Identity Language="en-US" Id="${xml(pkg.name)}" Version="${xml(pkg.version)}" Publisher="${xml(pkg.publisher)}" />
    <DisplayName>${xml(pkg.displayName ?? pkg.name)}</DisplayName>
    <Description xml:space="preserve">${xml(pkg.description)}</Description>
    <Tags>${xml((pkg.keywords ?? []).join(','))}</Tags>
    <Categories>${xml((pkg.categories ?? ['Other']).join(','))}</Categories>
    <GalleryFlags>Public</GalleryFlags>
    <Properties>
      <Property Id="Microsoft.VisualStudio.Code.Engine" Value="${xml(pkg.engines.vscode)}" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionDependencies" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionPack" Value="" />
      <Property Id="Microsoft.VisualStudio.Code.ExtensionKind" Value="workspace" />
      <Property Id="Microsoft.VisualStudio.Code.LocalizedLanguages" Value="" />
      <Property Id="Microsoft.VisualStudio.Services.Links.Source" Value="${xml(pkg.repository?.url ?? '')}" />
      <Property Id="Microsoft.VisualStudio.Services.GitHubFlavoredMarkdown" Value="true" />
      <Property Id="Microsoft.VisualStudio.Services.Content.Pricing" Value="Free" />
    </Properties>
    <License>extension/LICENSE.txt</License>
  </Metadata>
  <Installation>
    <InstallationTarget Id="Microsoft.VisualStudio.Code" />
  </Installation>
  <Dependencies />
  <Assets>
    <Asset Type="Microsoft.VisualStudio.Code.Manifest" Path="extension/package.json" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.Details" Path="extension/README.md" Addressable="true" />
    <Asset Type="Microsoft.VisualStudio.Services.Content.License" Path="extension/LICENSE.txt" Addressable="true" />
  </Assets>
</PackageManifest>
`;

  const types = `<?xml version="1.0" encoding="utf-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension=".json" ContentType="application/json" /><Default Extension=".vsixmanifest" ContentType="text/xml" /><Default Extension=".js" ContentType="application/javascript" /><Default Extension=".md" ContentType="text/markdown" /><Default Extension=".txt" ContentType="text/plain" /></Types>
`;

  const entries = [
    ['extension.vsixmanifest', manifest],
    ['[Content_Types].xml', types],
    ...FILES.map(([from, to]) => [`extension/${to}`, readFileSync(join(dir, from))]),
  ];
  return { name: `${pkg.name}-${pkg.version}.vsix`, id, version: pkg.version, data: zip(entries), files: entries.map(([path]) => path) };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const dir = join(here, '..', 'extensions', 'vscode');
  const out = buildVsix(dir);
  writeFileSync(join(dir, out.name), out.data);
  process.stdout.write(`wrote extensions/vscode/${out.name} — ${out.id} ${out.version}, ${out.files.length} files, ${out.data.length} bytes\n`
    + `install it with:  code --install-extension extensions/vscode/${out.name}\n`
    + '                  (cursor, windsurf or codium in place of code, for those editors)\n');
}
