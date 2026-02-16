import Store from 'electron-store';

interface StoreSchema {
  apiKey: string;
  model: string;
}

const store = new Store<StoreSchema>({
  name: 'ai-browser-agent-settings',
  defaults: {
    apiKey: '',
    model: 'gpt-4o',
  },
  encryptionKey: 'ai-browser-agent-v1',
});

export function getApiKey(): string {
  return store.get('apiKey');
}

export function setApiKey(key: string): void {
  store.set('apiKey', key);
}

export function getModel(): string {
  return store.get('model');
}

export function setModel(model: string): void {
  store.set('model', model);
}

export function getAllSettings(): StoreSchema {
  return {
    apiKey: store.get('apiKey'),
    model: store.get('model'),
  };
}
