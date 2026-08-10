const { app, safeStorage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const DEFAULTS = Object.freeze({
  serverUrl: process.env.INTERVIEW_SERVER_URL?.trim() || 'https://119.29.213.205',
  answerHotkey: 'CommandOrControl+1',
  microphoneEnabled: false,
  activationToken: '',
  deviceId: '',
});

class ConfigStore {
  constructor() {
    this.filePath = path.join(app.getPath('userData'), 'student-config.json');
    this.value = { ...DEFAULTS };
    this.load();
    if (!this.value.deviceId) {
      this.value.deviceId = randomUUID();
      this.persist();
    }
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      this.value.answerHotkey = typeof raw.answerHotkey === 'string' ? raw.answerHotkey : DEFAULTS.answerHotkey;
      this.value.microphoneEnabled = raw.microphoneEnabled === true;
      this.value.deviceId = typeof raw.deviceId === 'string' ? raw.deviceId : '';
      if (typeof raw.activationTokenEncrypted === 'string' && safeStorage.isEncryptionAvailable()) {
        this.value.activationToken = safeStorage.decryptString(Buffer.from(raw.activationTokenEncrypted, 'base64'));
      }
    } catch (error) {
      if (error?.code !== 'ENOENT') process.stderr.write('[config] Unable to read configuration; using defaults.\n');
    }
  }

  publicValue() {
    return {
      answerHotkey: this.value.answerHotkey,
      microphoneEnabled: this.value.microphoneEnabled,
      activated: Boolean(this.value.activationToken),
    };
  }

  update(patch) {
    if (typeof patch.answerHotkey === 'string') this.value.answerHotkey = patch.answerHotkey;
    if (typeof patch.microphoneEnabled === 'boolean') this.value.microphoneEnabled = patch.microphoneEnabled;
    this.persist();
    return this.publicValue();
  }

  setActivationToken(token) {
    if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用，无法安全保存激活状态');
    this.value.activationToken = token;
    this.persist();
  }

  clearActivationToken() {
    this.value.activationToken = '';
    this.persist();
  }

  persist() {
    const serialized = {
      answerHotkey: this.value.answerHotkey,
      microphoneEnabled: this.value.microphoneEnabled,
      deviceId: this.value.deviceId,
    };
    if (this.value.activationToken) {
      if (!safeStorage.isEncryptionAvailable()) throw new Error('系统凭据加密不可用');
      serialized.activationTokenEncrypted = safeStorage.encryptString(this.value.activationToken).toString('base64');
    }
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(serialized, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.filePath);
  }
}

module.exports = { ConfigStore, DEFAULTS };
