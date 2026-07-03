import { createApplication } from './composition.js';
import { loadConfig } from './config.js';
import { startHttpServer } from './http/server.js';

const config = loadConfig();
const token = process.env.FINORA_DESKTOP_TOKEN;
if (!token) throw new Error('FINORA_DESKTOP_TOKEN is required for the desktop backend');

const service = createApplication(config);
let server: ReturnType<typeof startHttpServer>;
const shutdown = () => server.close(() => service.close());
server = startHttpServer(service, {
  ...config,
  desktopToken: token,
  onDesktopShutdown: shutdown,
});

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
