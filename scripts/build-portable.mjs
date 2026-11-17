#!/usr/bin/env node
/**
 * 打包 Windows 便携版：解压后双击 `start.bat` 即可使用，不需要安装 Node.js。
 *
 * 面向的是「只想用、不想配环境」的人。npm install + npm start 对开发者是两步，
 * 但对普通用户仍要先装 Node，这一步最容易劝退，所以把运行时一起打包。
 *
 * 产物：dist-portable/notizhi-portable-win-x64.zip
 * 结构：node.exe + server/ + shared/ + scripts/ + dist-standalone/ + node_modules/（仅运行依赖）
 */
import { copyFile, cp, mkdir, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
const OUT_DIR = resolve(ROOT, 'dist-portable');
const BUNDLE_NAME = 'notizhi-portable-win-x64';
const STAGE = resolve(OUT_DIR, BUNDLE_NAME);
const ZIP_PATH = resolve(OUT_DIR, `${BUNDLE_NAME}.zip`);

// 服务端实际会用到的第三方包；其余依赖只服务于构建，不必随包分发。
const RUNTIME_DEPS = ['@napi-rs/canvas', 'pdfjs-dist', 'zod'];

const log = (message = '') => console.log(message);

function run(command, args, options = {}) {
  // npm 在 Windows 上是 npm.cmd，必须经过 shell；其余命令直接执行，避免路径里的括号被 cmd 当成语法。
  const result = spawnSync(command, args, { stdio: 'inherit', cwd: ROOT, shell: options.shell ?? false, ...options });
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} 执行失败（退出码 ${result.status ?? '未知'}）`);
  }
}

/** 没有前端产物就先构建，否则打出来的包打开是白屏。 */
function ensureBuild() {
  if (existsSync(resolve(ROOT, 'dist-standalone/standalone.html'))) return;
  log('未找到前端产物，先执行构建…');
  run(process.execPath, [resolve(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--config', 'vite.standalone.config.ts']);
}

/**
 * 清空输出目录。输出目录一定在项目内，不会碰到用户数据。
 * 某些受限环境会拦截批量删除，此时给出可操作的提示而不是一堆 shim 报错。
 */
async function clearOutput() {
  if (!resolve(OUT_DIR).startsWith(ROOT)) throw new Error('输出目录不在项目内，拒绝清理。');
  if (!existsSync(OUT_DIR)) return;
  try {
    await rm(OUT_DIR, { recursive: true, force: true });
  } catch {
    throw new Error(`无法自动清理 ${OUT_DIR}，请手动删除该目录后重试。`);
  }
}

async function stageFiles(pkg) {
  await clearOutput();
  await mkdir(STAGE, { recursive: true });

  // 运行必需的代码与静态资源
  for (const dir of ['server', 'shared', 'dist-standalone']) {
    await cp(resolve(ROOT, dir), resolve(STAGE, dir), { recursive: true });
  }
  await mkdir(resolve(STAGE, 'scripts'), { recursive: true });
  for (const file of ['start.mjs', 'knowledge-admin.mjs']) {
    await cp(resolve(ROOT, 'scripts', file), resolve(STAGE, 'scripts', file));
  }
  for (const file of ['.env.example', 'LICENSE', 'README.md']) {
    await cp(resolve(ROOT, file), resolve(STAGE, file));
  }

  // 只声明运行依赖，装出来的体积才可控
  const dependencies = Object.fromEntries(RUNTIME_DEPS.map((name) => [name, pkg.dependencies[name]]));
  await writeFile(resolve(STAGE, 'package.json'), `${JSON.stringify({
    name: 'notizhi-portable',
    version: pkg.version,
    private: true,
    type: 'module',
    description: '通知智析便携版',
    dependencies,
  }, null, 2)}\n`);

  // 把当前运行时复制进去，使用者无需自行安装 Node
  await cp(process.execPath, resolve(STAGE, 'node.exe'));
}

/**
 * 便携版使用说明。写成 Markdown：txt 在记事本里没有排版，长文很难读。
 * 用 \n 而不是 \r\n —— Markdown 靠空行分段，多余的回车只会让 Git 报换行警告。
 */
function buildReadme() {
  return `# 通知智析 便携版

把群通知、公众号文章解析成带截止时间的待办事项。**不需要安装 Node，不需要联网账号，数据全在本机。**

## 一、启动

1. 把压缩包**解压**到任意位置。路径可以有中文，但不要直接在压缩包里双击运行，否则数据会写进临时目录，关掉就没了。
2. 双击 **\`start.bat\`**。
3. 等几秒，浏览器会自动打开 <http://127.0.0.1:8001>。

第一次启动时，黑色窗口里会打印**管理员账号和初始密码**，只显示一次。请立刻记下来。
密码忘了可以删掉 \`.local\` 目录重来，但那样所有数据也会一起清空。

## 二、填模型密钥

解析需要一个大模型，密钥要自己准备。不填也能打开页面、看已有待办，但点「智能解析」会明确提示尚未配置。

进入页面 **「我的 → 模型接入」**，填三样：

| 项 | 填什么 | 示例 |
|---|---|---|
| API 基础地址 | 服务商给的根地址，**不要**带 \`/chat/completions\` | \`https://api.deepseek.com\` |
| API 密钥 | 服务商控制台创建的 key | \`sk-...\` |
| 默认模型 ID | 用于通知解析的模型 | \`deepseek-flash\` |

保存后立即生效，不用重启。密钥只存在本机的 \`.env.local\` 和 SQLite 里，不会发到浏览器，也不会传给别的服务商。

深度解读和通知生成可以另填模型，留空就用上面那个。要识别图片和截图，还需要填一个支持视觉的模型。

## 三、数据存在哪

所有数据都在这个文件夹里：

\`\`\`
.local/            待办、知识库、账号，SQLite 数据库在这里
.env.local         模型配置与密钥
\`\`\`

- **备份**：整个文件夹复制走即可，包括上面两个。
- **换电脑**：同样整个复制，Node 运行时已经打在里面，不用另外装。
- **删除文件夹 = 清空所有数据**，没有云端副本能找回。

## 四、停止服务

关掉那个黑色窗口，或者在窗口里按 \`Ctrl+C\`。

浏览器标签页留着没关系，下次启动还在。

## 五、常见问题

| 现象 | 原因与处理 |
|---|---|
| 浏览器打不开 | 服务还没起完，等几秒刷新。窗口里如果已经显示地址就说明起来了 |
| 端口 8001 被占用 | 关掉占用的程序，或改 \`.env.local\` 里的 \`PORT\` |
| 解析提示「尚未配置」 | 没填模型密钥，按第二节填 |
| 解析很慢或超时 | 长通知解读实测约 80 秒；可在 \`.env.local\` 调大 \`AI_TIMEOUT_MS\` |
| 中文显示成方块 | 窗口编码问题，不影响功能，页面里是正常的 |
| 提示缺 VC++ 运行库 | 装一次 [Microsoft Visual C++ 运行库](https://aka.ms/vs/17/release/vc_redist.x64.exe) |

## 六、这不是什么

- **不是安装版**，没有注册表、没有开机自启、没有系统托盘。
- **不会上传你的数据**。唯一的对外请求是调用你自己配置的模型接口。
- **只支持 Windows x64**。其他系统请用源码版（\`npm install && npm start\`）。
`;
}

/** 双击入口。bat 内容保持纯 ASCII：cmd 解析 .bat 用的是本地代码页，塞中文容易乱码。 */
async function writeLauncher() {
  const bat = [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'title Notizhi',
    'set OPEN_BROWSER=1',
    '".\\node.exe" "scripts\\start.mjs"',
    'if errorlevel 1 (',
    '  echo.',
    '  echo Startup failed. Please screenshot the messages above.',
    '  pause',
    ')',
    '',
  ].join('\r\n');
  await writeFile(resolve(STAGE, 'start.bat'), bat, 'utf8');

  const readme = buildReadme();
  await writeFile(resolve(STAGE, '使用说明书.md'), `\uFEFF${readme}`, 'utf8');

  const notices = [
    '本程序打包分发了以下第三方组件，各自保留其原始许可证：',
    '',
    `Node.js ${process.version}  —  MIT License  —  https://nodejs.org`,
    '  许可证全文见 https://github.com/nodejs/node/blob/main/LICENSE',
    '',
    '其余 npm 依赖的许可证位于 node_modules/<包名>/LICENSE。',
    '',
  ].join('\r\n');
  await writeFile(resolve(STAGE, 'THIRD-PARTY-NOTICES.txt'), notices, 'utf8');
}

/**
 * 打包目录里绝不能出现的东西：源码软链、本机数据、密钥。
 * npm 在项目根用 --prefix 安装时，会把根项目以软链形式放进 node_modules/<根包名>，
 * 指向源码目录，连带把 .local 数据库和 .env.local 一起打进包里 —— 这里必须拦住。
 */
function assertNoLeak() {
  const suspects = [
    resolve(STAGE, 'node_modules', 'notizhi'),
    resolve(STAGE, 'node_modules', 'notizhi-portable', '.local'),
    resolve(STAGE, '.local'),
    resolve(STAGE, '.env.local'),
  ];
  const found = suspects.filter((item) => existsSync(item));
  if (found.length) throw new Error(`打包目录里出现了不应包含的内容：${found.join('、')}`);
}

async function installDeps() {
  log('安装运行依赖（仅 3 个）…');
  // 工作目录必须是 STAGE：在项目根执行会把根项目本身链进 node_modules。
  run('npm', ['install', '--omit=dev', '--no-audit', '--no-fund'], { shell: true, cwd: STAGE });
  assertNoLeak();
}

async function zip() {
  log('压缩中（约 1 分钟）…');
  await rm(ZIP_PATH, { force: true });

  // 用系统自带的 tar.exe（bsdtar），它比 Compress-Archive 快得多，也不必在运行时
  // 编译 .NET 代码（部分受限环境会拦截 Add-Type）。
  const tarBin = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(tarBin)) throw new Error('未找到系统自带的 tar.exe（Windows 10 及以上自带），无法打包。');

  // 归档必须写在被压缩目录之外。tar 的路径参数按模式匹配：若归档名为目录名的前缀
  // （notizhi-portable-win-x64.zip 之于 notizhi-portable-win-x64），
  // 它会把正在写入的 zip 自己也收进去，体积无限膨胀（实测 448MB → 6.9GB）。
  const tempZip = resolve(tmpdir(), `${BUNDLE_NAME}.zip`);
  await rm(tempZip, { force: true });
  run(tarBin, ['-a', '-c', '-f', tempZip, '-C', OUT_DIR, BUNDLE_NAME]);
  await copyFile(tempZip, ZIP_PATH);
  await rm(tempZip, { force: true });

  const { size } = await stat(ZIP_PATH);
  log(`完成：${ZIP_PATH}`);
  log(`体积：${(size / 1024 / 1024).toFixed(1)} MB`);
}

/**
 * 回读压缩包确认关键文件都在、中文名没有坏。
 * 用系统自带的 bsdtar 读取（能读 zip 且按 UTF-8 输出），不用 PowerShell：
 * 后者在中文系统上会把条目名按 GBK 输出，出现「文件明明在却报缺失」的假失败。
 */
async function verifyZip() {
  const tarBin = resolve(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  if (!existsSync(tarBin)) {
    log('未找到系统 tar，跳过压缩包校验。');
    return;
  }
  const result = spawnSync(tarBin, ['-tf', ZIP_PATH], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const names = String(result.stdout ?? '').split(/\r?\n/).filter(Boolean);
  if (!names.length) throw new Error('压缩包读取失败，可能是写入过程被中断。');
  const required = ['start.bat', '使用说明书.md', 'node.exe', 'scripts/start.mjs'];
  const missing = required.filter((name) => !names.includes(`${BUNDLE_NAME}/${name}`));
  if (missing.length) throw new Error(`压缩包内缺少或文件名损坏：${missing.join('、')}`);
  log(`压缩包校验通过：${names.length} 个条目，关键文件齐全。`);
}

async function main() {
  if (process.platform !== 'win32') {
    throw new Error('便携版目前只打包 Windows 版本（需要 node.exe）。');
  }
  const pkg = JSON.parse(await readFile(resolve(ROOT, 'package.json'), 'utf8'));
  ensureBuild();
  log(`准备打包 ${BUNDLE_NAME}…`);
  await stageFiles(pkg);
  await writeLauncher();
  await installDeps();
  assertNoLeak();
  await zip();
  await verifyZip();
  log('');
  log('自检提示：解压到空目录后双击 start.bat，浏览器应自动打开并可直接登录。');
}

main().catch((error) => {
  console.error(`\n打包失败：${error.message}\n`);
  process.exit(1);
});
