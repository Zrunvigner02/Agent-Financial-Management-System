'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 只向启动页暴露极小的控制面，业务页面（http 源）不注入任何 Node 能力
if (location.protocol === 'file:') {
  contextBridge.exposeInMainWorld('desktop', {
    retry: () => ipcRenderer.send('desktop:retry'),
    quit: () => ipcRenderer.send('desktop:quit'),
  });
}
