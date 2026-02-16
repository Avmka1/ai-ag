import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('electronAPI', {
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setApiKey: (key: string) => ipcRenderer.invoke('set-api-key', key),
  setModel: (model: string) => ipcRenderer.invoke('set-model', model),
  runAgent: (task: string) => ipcRenderer.invoke('run-agent', task),
  stopAgent: () => ipcRenderer.invoke('stop-agent'),
  answerAgent: (answer: string) => ipcRenderer.invoke('answer-agent', answer),
  onAgentLog: (callback: (log: any) => void) => {
    const handler = (_event: any, log: any) => callback(log);
    ipcRenderer.on('agent-log', handler);
    return () => {
      ipcRenderer.removeListener('agent-log', handler);
    };
  },
});
