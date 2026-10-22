import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';

export const root = fileURLToPath(new URL('../', import.meta.url));
export const agentRoot = path.join(root, 'backend/agent');
export const agentPython = path.join(agentRoot, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
export const javaJar = path.join(root, 'backend/java/target/knowrift-local.jar');
export function javaEnvironment() {
  const selected = process.env.KNOWRIFT_JAVA_HOME || process.env.JAVA_HOME;
  const executable = selected ? path.join(selected, 'bin', process.platform === 'win32' ? 'java.exe' : 'java') : 'java';
  const result = spawnSync(executable, ['-version'], { encoding: 'utf8', windowsHide: true });
  if (result.error || result.status !== 0 || !/version "17[.\"]/.test(result.stderr + result.stdout)) throw new Error('需要 JDK 17。请设置 KNOWRIFT_JAVA_HOME（本机可用 D:\\java\\jdk-17）后重试。');
  let javaHome = selected;
  if (!javaHome) {
    const settings = spawnSync(executable, ['-XshowSettings:properties', '-version'], { encoding: 'utf8', windowsHide: true });
    javaHome = /java.home\s*=\s*(.+)/.exec(settings.stderr)?.[1]?.trim();
  }
  if (!javaHome) throw new Error('无法定位 JDK 17 目录，请设置 KNOWRIFT_JAVA_HOME');
  return { executable: path.join(javaHome, 'bin', process.platform === 'win32' ? 'java.exe' : 'java'), env: { ...process.env, JAVA_HOME: javaHome, MAVEN_OPTS: `${process.env.MAVEN_OPTS || ''} -Dfile.encoding=UTF-8 -Dsun.stdout.encoding=UTF-8 -Dsun.stderr.encoding=UTF-8`, PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH || process.env.Path || ''}` } };
}
export function execute(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, { cwd: root, stdio: 'inherit', windowsHide: true, ...options });
    child.once('error', reject);
    child.once('exit', code => code === 0 ? resolve() : reject(new Error(`命令执行失败 (${code})`)));
  });
}
async function maven(args) {
  const { env } = javaEnvironment();
  // Windows .cmd launch requires cmd.exe; arguments here are fixed, not user input.
  if (process.platform === 'win32') await execute(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'mvn.cmd', '-B', '-ntp', '-f', 'backend/java/pom.xml', ...args], { env });
  else await execute('mvn', ['-B', '-ntp', '-f', 'backend/java/pom.xml', ...args], { env });
}
export function serviceCommands() {
  const commands = {};
  try {
    const java = javaEnvironment();
    // A short, ordinary directory avoids Windows packaged-app TEMP virtualization
    // breaking JDK 17's internal Unix-domain socket used by the NIO selector.
    const socketTemp = path.join(root, '.cache/java-tmp');
    if (process.platform === 'win32') fs.mkdirSync(socketTemp, { recursive: true });
    commands.java = fs.existsSync(javaJar) ? { executable: java.executable, args: ['-Dfile.encoding=UTF-8', ...(process.platform === 'win32' ? [`-Djdk.net.unixdomain.tmpdir=${socketTemp}`] : []), '-jar', javaJar], cwd: root, env: java.env } : { error: '项目服务尚未构建，请先运行 npm run services:setup' };
  } catch (error) { commands.java = { error: error.message }; }
  commands.python = fs.existsSync(agentPython) ? { executable: agentPython, args: ['-m', 'knowrift_agent'], cwd: agentRoot, env: { ...process.env, PYTHONUTF8: '1', PYTHONUNBUFFERED: '1' } } : { error: '智能服务尚未安装，请先运行 npm run services:setup' };
  return commands;
}
async function command(action) {
  if (action === 'setup') {
    javaEnvironment();
    const python = process.env.KNOWRIFT_PYTHON || 'python';
    const version = spawnSync(python, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (version.status !== 0 || !/Python 3\.14\./.test(version.stdout + version.stderr)) throw new Error('需要 Python 3.14，请设置 KNOWRIFT_PYTHON 为基础解释器路径');
    if (!fs.existsSync(agentPython)) await execute(python, ['-m', 'venv', path.join(agentRoot, '.venv')]);
    const locked = path.join(agentRoot, 'requirements.lock');
    await execute(agentPython, ['-m', 'pip', 'install', '-r', fs.existsSync(locked) ? locked : path.join(agentRoot, 'requirements.txt')]);
    if (!fs.existsSync(locked)) {
      const frozen = spawnSync(agentPython, ['-m', 'pip', 'freeze'], { encoding: 'utf8', windowsHide: true });
      if (frozen.status !== 0) throw new Error('依赖锁定失败');
      fs.writeFileSync(locked, frozen.stdout.replaceAll('\r\n', '\n'), 'utf8');
    }
    await maven(['verify']);
  } else if (action === 'test-java') await maven(['verify']);
  else if (action === 'test-agent') await execute(agentPython, ['-m', 'unittest', 'discover', '-s', 'tests', '-v'], { cwd: agentRoot, env: { ...process.env, PYTHONUTF8: '1' } });
  else throw new Error('Unknown services command');
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) command(process.argv[2]).catch(error => { console.error(error.message); process.exitCode = 1; });
