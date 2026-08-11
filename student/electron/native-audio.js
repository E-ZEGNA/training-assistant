const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');

const PACKET_BYTES = 3200 * 2;

class NativeAudioCapture extends EventEmitter {
  constructor(executablePath, { platform = process.platform } = {}) {
    super();
    this.executablePath = executablePath;
    this.platform = platform;
    this.child = null;
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = '';
  }

  async start() {
    await this.stop();
    return new Promise((resolve, reject) => {
      let settled = false;
      const child = spawn(this.executablePath, [], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.stdoutBuffer = Buffer.alloc(0);
      this.stderrBuffer = '';

      const finishStart = (error, event) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(event);
      };
      const timer = setTimeout(() => {
        const hint = this.platform === 'darwin'
          ? '请在系统设置的“隐私与安全性 > 屏幕与系统音频录制”中允许本应用，然后重新打开应用'
          : '请确认当前有可用的 Windows 播放设备';
        finishStart(new Error(`系统音频启动超时，${hint}`));
        this.stop().catch(() => {});
      }, 8_000);

      child.stdout.on('data', (chunk) => {
        this.stdoutBuffer = Buffer.concat([this.stdoutBuffer, chunk]);
        while (this.stdoutBuffer.length >= PACKET_BYTES) {
          const packet = this.stdoutBuffer.subarray(0, PACKET_BYTES);
          this.stdoutBuffer = this.stdoutBuffer.subarray(PACKET_BYTES);
          this.emit('audio', packet);
        }
      });
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        this.stderrBuffer += chunk;
        const lines = this.stderrBuffer.split(/\r?\n/);
        this.stderrBuffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let event;
          try { event = JSON.parse(line); } catch { event = { event: 'error', message: line.trim() }; }
          if (event.event === 'ready') {
            finishStart(null, event);
            this.emit('status', { state: 'capturing', device: event.device });
          } else if (event.event === 'error') {
            const message = event.device
              ? `无法采集系统音频（${event.device}）：${event.message}`
              : `无法采集系统音频：${event.message}`;
            finishStart(new Error(message));
            this.emit('status', { state: 'failed', error: message });
          }
        }
      });
      child.once('error', (error) => finishStart(new Error(`系统音频组件启动失败：${error.message}`)));
      child.once('exit', (code) => {
        if (this.child === child) this.child = null;
        if (!settled) finishStart(new Error(`系统音频组件异常退出 (${code ?? 'unknown'})`));
        else if (code && code !== 0) this.emit('status', { state: 'failed', error: `系统音频组件异常退出 (${code})` });
      });
    });
  }

  async stop() {
    const child = this.child;
    if (!child) return;
    this.child = null;
    await new Promise((resolve) => {
      let completed = false;
      const done = () => {
        if (completed) return;
        completed = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(() => {
        child.kill();
        done();
      }, 2_000);
      child.once('exit', done);
      child.stdin.end();
    });
    this.stdoutBuffer = Buffer.alloc(0);
    this.stderrBuffer = '';
  }
}

module.exports = { NativeAudioCapture, PACKET_BYTES };
