const fs = require('node:fs');
const path = require('node:path');

const source = require.resolve('lucide/dist/umd/lucide.js');
const targetDir = path.join(__dirname, '..', 'renderer', 'vendor');
fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, path.join(targetDir, 'lucide.js'));
