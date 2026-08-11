const path = require('node:path');
const { spawnSync } = require('node:child_process');

const studentRoot = path.resolve(__dirname, '..');
let command;
let args;

if (process.platform === 'win32') {
  command = 'powershell';
  args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(studentRoot, 'native', 'build.ps1')];
} else if (process.platform === 'darwin') {
  command = 'bash';
  args = [path.join(studentRoot, 'native', 'build-mac.sh'), process.arch];
} else {
  throw new Error(`Native system-audio capture is not supported on ${process.platform}`);
}

const result = spawnSync(command, args, { cwd: studentRoot, stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
