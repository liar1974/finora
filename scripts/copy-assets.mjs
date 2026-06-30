import { cp, mkdir } from 'node:fs/promises';

await mkdir(new URL('../dist/http/', import.meta.url), { recursive: true });
await cp(
  new URL('../src/http/web/', import.meta.url),
  new URL('../dist/http/web/', import.meta.url),
  { recursive: true },
);
