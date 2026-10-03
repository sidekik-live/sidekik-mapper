import { readFileSync } from 'node:fs';

// src/ and dist/ are both one level below package.json.
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
  version: string;
};

export const VERSION = pkg.version;
