import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export interface Config {
  host: string;
  port: number;
  databasePath: string;
  modelsDir: string;
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): Config {
  const dataDirectory = resolve(environment.FINORA_DATA_DIR ?? join(homedir(), '.finora'));
  const port = Number(environment.FINORA_PORT ?? 3011);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error('FINORA_PORT must be an integer between 1 and 65535');
  }
  return {
    host: environment.FINORA_HOST ?? '127.0.0.1',
    port,
    databasePath: resolve(environment.FINORA_DATABASE_PATH ?? join(dataDirectory, 'finora.db')),
    modelsDir: resolve(environment.FINORA_MODELS_DIR ?? join(dataDirectory, 'models')),
  };
}
