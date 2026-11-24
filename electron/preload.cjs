const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('reelDesktop', {
  isDesktop: true,
  platform: process.platform
});
