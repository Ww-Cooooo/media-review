import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const index = process.argv.indexOf('--out');
if (index < 0 || !process.argv[index + 1]) throw new Error('请用--out指定新的本机输出目录；此命令不安装或发布。');
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
if (!pkg.license || pkg.license === 'UNLICENSED') throw new Error('请先确认自有源码许可，再生成对外安装包。');
await fs.access(path.join(root, 'LICENSE'));
const output = path.resolve(process.argv[index + 1]);
await fs.mkdir(path.dirname(output), { recursive: true });
await fs.mkdir(output, { recursive: false });
const bundle = path.join(output, '.build');
await fs.mkdir(bundle);
const execute = promisify(execFile);
const compiler = path.join(path.dirname(require.resolve('typescript/package.json')), 'bin/tsc');
const vite = path.join(path.dirname(require.resolve('vite/package.json')), 'bin/vite.js');
await execute(process.execPath, [compiler, '--noEmit'], { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 });
const built = await execute(process.execPath, [vite, 'build', '--mode', 'standalone', '--outDir', bundle, '--emptyOutDir'], { cwd: root, timeout: 120000, maxBuffer: 1024 * 1024 });
console.log(built.stdout);
if (built.stderr) console.error(built.stderr);
const copy = async (from, to) => fs.cp(from, to, { recursive: true, force: false, errorOnExist: true });
for (const name of ['SKILL.md', 'README.md', 'references', 'scripts', '安装 Media Review.cmd', '初始化桌面入口.cmd', '打开 Media Review.cmd', '启动 Media Review 本机音视频校对室.cmd', '启动入口说明.txt']) await copy(path.join(root, 'skill', name), path.join(output, name));
await copy(path.join(root, 'LICENSE'), path.join(output, 'LICENSE'));
const app = path.join(output, 'app');
await fs.mkdir(path.join(app, 'server'), { recursive: true });
await fs.mkdir(path.join(app, 'scripts'));
await fs.mkdir(path.join(app, 'dist'));
for (const file of await fs.readdir(path.join(root, 'server'))) if (file.endsWith('.mjs') && !file.endsWith('.test.mjs')) await copy(path.join(root, 'server', file), path.join(app, 'server', file));
await copy(path.join(root, 'scripts/review-agent.mjs'), path.join(app, 'scripts/review-agent.mjs'));
await fs.writeFile(path.join(app, 'standalone.json'), JSON.stringify({ format: 'media-review-standalone/v1', version: pkg.version }) + '\n', { flag: 'wx' });
await fs.writeFile(path.join(app, 'package.json'), JSON.stringify({ name: 'media-review-runtime', private: true, type: 'module', version: pkg.version, localRevision: pkg.localRevision, license: pkg.license, engines: { node: '>=24' } }) + '\n', { flag: 'wx' });
for (const name of ['index.html', 'assets']) await copy(path.join(bundle, name), path.join(app, 'dist', name));
await fs.mkdir(path.join(app, 'dist/fonts'));
await fs.mkdir(path.join(app, 'dist/brand'));
for (const weight of ['Regular', 'Medium', 'Semibold']) await copy(path.join(root, 'public/fonts', `MiSans-${weight}.woff2`), path.join(app, 'dist/fonts', `MiSans-${weight}.woff2`));
for (const name of ['review-mark.svg', 'media-review-launcher.ico']) await copy(path.join(root, 'public/brand', name), path.join(app, 'dist/brand', name));
await copy(path.join(root, 'public/licenses'), path.join(app, 'dist/licenses'));
const modules = path.dirname(path.dirname(require.resolve('react/package.json')));
const lock = JSON.parse(await fs.readFile(path.join(root, 'package-lock.json'), 'utf8'));
const notices = ['第三方依赖许可与声明', '以下保留构建所用依赖的原声明；字体、GSAP许可及品牌图标说明另见app/dist/licenses。', ''];
for (const [relative, dependency] of Object.entries(lock.packages)) {
  if (!relative.startsWith('node_modules/') || dependency.dev) continue;
  const directory = path.join(modules, relative.slice('node_modules/'.length));
  for (const file of await fs.readdir(directory).catch(() => [])) if (/^(?:licen[cs]e|copying|notice)(?:[._-].*)?$/iu.test(file)) {
    const input = path.join(directory, file), stat = await fs.lstat(input);
    if (stat.isFile() && !stat.isSymbolicLink() && stat.size < 1024 * 1024) notices.push(`===== ${relative} ${dependency.version ?? ''} / ${file} =====`, await fs.readFile(input, 'utf8'), '');
  }
}
await fs.writeFile(path.join(output, 'THIRD_PARTY_NOTICES.txt'), notices.join('\n'), { flag: 'wx' });
// 只删除本命令刚创建的临时构建，不接触任何运行数据。
await fs.rm(bundle, { recursive: true });
const files = [];
async function walk(directory) {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const file = path.join(directory, entry.name), relative = path.relative(output, file).replaceAll('\\', '/');
    if (entry.isSymbolicLink()) throw new Error('候选含链接，拒绝打包。');
    if (entry.isDirectory()) await walk(file);
    else {
      const bytes = await fs.readFile(file);
      if (/\.(?:mp4|mov|wav|mp3|lnk|srt)$/iu.test(entry.name) || /\.(?:review|workspace)\.json$/u.test(entry.name)) throw new Error('候选不应含用户媒体或校对记录。');
      files.push({ path: relative, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length });
    }
  }
}
await walk(output);
await fs.writeFile(path.join(output, 'skill-package.json'), JSON.stringify({ format: 'media-review-skill-package/v1', name: 'media-review', skill_id: '56e78c64-701a-4a1b-85cb-751491ca743a', version: pkg.version, localRevision: pkg.localRevision, files: files.sort((a, b) => a.path.localeCompare(b.path)) }, null, 2) + '\n', { flag: 'wx' });
console.log(JSON.stringify({ built: true, output, version: pkg.version, files: files.length, userDataIncluded: false, installed: false, published: false }));
