const fs = require('fs');
const path = require('path');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'linux') return;

  const appOutDir = context.appOutDir;
  const sandboxPath = path.join(appOutDir, 'chrome-sandbox');

  if (fs.existsSync(sandboxPath)) {
    fs.unlinkSync(sandboxPath);
    console.log('Removed chrome-sandbox to prevent SUID sandbox crash in AppImage');
  }
};
