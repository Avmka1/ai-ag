import { ipcMain, BrowserWindow, app } from 'electron';
import path from 'node:path';
import { getApiKey, setApiKey, getModel, setModel, getAllSettings } from './store.js';
import { AgentController } from '../agent/agent.js';
import type { LogEntry } from '../agent/tool-executor.js';

let agentController: AgentController | null = null;

export function registerIpcHandlers(mainWindow: BrowserWindow): void {
  // Settings
  ipcMain.handle('get-settings', async () => {
    return getAllSettings();
  });

  ipcMain.handle('set-api-key', async (_event, key: string) => {
    setApiKey(key);
    return { success: true };
  });

  ipcMain.handle('set-model', async (_event, model: string) => {
    setModel(model);
    return { success: true };
  });

  // Agent control
  ipcMain.handle('run-agent', async (_event, task: string) => {
    if (agentController?.isRunning) {
      return { error: 'Agent is already running' };
    }

    const apiKey = getApiKey();
    if (!apiKey) {
      return { error: 'Please set your OpenAI API key first' };
    }

    const model = getModel();

    const logger = (log: LogEntry) => {
      try {
        mainWindow.webContents.send('agent-log', log);
      } catch {
        // Window may be closed
      }
    };

    const userDataDir = path.join(app.getPath('userData'), 'playwright-profile');
    agentController = new AgentController(apiKey, model, task, logger, { userDataDir });

    try {
      const result = await agentController.run();
      return { result };
    } catch (err: any) {
      return { error: err.message || 'Agent failed' };
    } finally {
      agentController = null;
    }
  });

  ipcMain.handle('stop-agent', async () => {
    if (agentController) {
      await agentController.stop();
      // Keep the controller instance until run-agent finishes and clears it in its finally{}.
      // This prevents starting a second agent while the first one is still shutting down.
      return { success: true };
    }
    return { error: 'No agent running' };
  });

  ipcMain.handle('answer-agent', async (_event, answer: string) => {
    if (agentController) {
      agentController.provideUserAnswer(answer);
      return { success: true };
    }
    return { error: 'No agent running' };
  });
}
