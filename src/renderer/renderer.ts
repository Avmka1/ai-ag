declare global {
  interface Window {
    electronAPI: {
      getSettings: () => Promise<{ apiKey: string; model: string }>;
      setApiKey: (key: string) => Promise<{ success: boolean }>;
      setModel: (model: string) => Promise<{ success: boolean }>;
      runAgent: (task: string) => Promise<{ result?: string; error?: string }>;
      stopAgent: () => Promise<{ success?: boolean; error?: string }>;
      answerAgent: (answer: string) => Promise<{ success?: boolean; error?: string }>;
      onAgentLog: (callback: (log: any) => void) => () => void;
    };
  }
}

const apiKeyInput = document.getElementById('api-key-input') as HTMLInputElement;
const saveKeyBtn = document.getElementById('save-key-btn') as HTMLButtonElement;
const keyStatus = document.getElementById('key-status') as HTMLSpanElement;
const modelSelect = document.getElementById('model-select') as HTMLSelectElement;
const taskInput = document.getElementById('task-input') as HTMLInputElement;
const runBtn = document.getElementById('run-btn') as HTMLButtonElement;
const stopBtn = document.getElementById('stop-btn') as HTMLButtonElement;
const consoleOutput = document.getElementById('console-output') as HTMLDivElement;
const clearConsoleBtn = document.getElementById('clear-console-btn') as HTMLButtonElement;
const userPromptModal = document.getElementById('user-prompt-modal') as HTMLDivElement;
const userPromptQuestion = document.getElementById('user-prompt-question') as HTMLParagraphElement;
const userPromptInput = document.getElementById('user-prompt-input') as HTMLInputElement;
const userPromptSubmit = document.getElementById('user-prompt-submit') as HTMLButtonElement;

let isRunning = false;

async function init(): Promise<void> {
  const settings = await window.electronAPI.getSettings();

  if (settings.apiKey) {
    apiKeyInput.value = settings.apiKey;
    keyStatus.classList.add('saved');
  }

  modelSelect.value = settings.model || 'gpt-4o';

  window.electronAPI.onAgentLog((log) => {
    appendLog(log.type, log.content);
    if (log.type === 'ask_user') {
      showUserPromptModal(log.content);
    }
  });
}

saveKeyBtn.addEventListener('click', async () => {
  const key = apiKeyInput.value.trim();
  if (key) {
    await window.electronAPI.setApiKey(key);
    keyStatus.classList.add('saved');
  }
});

modelSelect.addEventListener('change', async () => {
  await window.electronAPI.setModel(modelSelect.value);
});

runBtn.addEventListener('click', async () => {
  const task = taskInput.value.trim();
  if (!task) {
    appendLog('error', 'Please enter a task.');
    return;
  }

  setRunning(true);
  appendLog('info', `Starting agent with task: "${task}"`);

  const result = await window.electronAPI.runAgent(task);

  if (result.error) {
    appendLog('error', `Error: ${result.error}`);
  } else if (result.result) {
    appendLog('result', `Final result: ${result.result}`);
  }

  setRunning(false);
});

stopBtn.addEventListener('click', async () => {
  appendLog('info', 'Stopping agent...');
  await window.electronAPI.stopAgent();
  setRunning(false);
});

clearConsoleBtn.addEventListener('click', () => {
  consoleOutput.innerHTML = '';
});

taskInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !isRunning) {
    runBtn.click();
  }
});

userPromptSubmit.addEventListener('click', async () => {
  const answer = userPromptInput.value.trim();
  if (answer) {
    await window.electronAPI.answerAgent(answer);
    hideUserPromptModal();
    appendLog('info', `You answered: "${answer}"`);
  }
});

userPromptInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') {
    userPromptSubmit.click();
  }
});

function setRunning(running: boolean): void {
  isRunning = running;
  runBtn.disabled = running;
  stopBtn.disabled = !running;
  taskInput.disabled = running;
}

function appendLog(type: string, content: string): void {
  const entry = document.createElement('div');
  entry.className = `log-entry ${type}`;

  const prefix = document.createElement('span');
  prefix.className = 'log-prefix';
  const now = new Date();
  prefix.textContent = `[${now.toLocaleTimeString()}]`;

  const typeLabels: Record<string, string> = {
    thought: '[THINK]',
    action: '[ACT]',
    observation: '[OBS]',
    error: '[ERR]',
    info: '[INFO]',
    ask_user: '[ASK]',
    result: '[DONE]',
  };

  const label = document.createElement('span');
  label.className = 'log-prefix';
  label.textContent = typeLabels[type] || `[${type.toUpperCase()}]`;

  const text = document.createTextNode(` ${content}`);

  entry.appendChild(prefix);
  entry.appendChild(label);
  entry.appendChild(text);

  consoleOutput.appendChild(entry);
  consoleOutput.scrollTop = consoleOutput.scrollHeight;
}

function showUserPromptModal(question: string): void {
  userPromptQuestion.textContent = question;
  userPromptInput.value = '';
  userPromptModal.classList.remove('hidden');
  userPromptInput.focus();
}

function hideUserPromptModal(): void {
  userPromptModal.classList.add('hidden');
}

init().catch(console.error);

export {};
