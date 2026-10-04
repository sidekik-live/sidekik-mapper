// Dev fixtures shared by pnpm dev:mock, pnpm dev:draft and the tests.
import { readFileSync } from 'node:fs';
import { parseDraft, type Drafter } from '../build/drafter.js';
import type { MemoryData } from '../store/memory.js';

const fixture = (name: string) => new URL(`../../dev/fixtures/${name}`, import.meta.url);

export const SABINE = {
  org: '00000000-0000-4000-8000-00000000a001',
  workflow: '00000000-0000-4000-8000-00000000b001',
  session: '00000000-0000-4000-8000-00000000d001',
  expert: '00000000-0000-4000-8000-00000000e001',
};

/** Sabine's capture session as the database holds it after capture (dev/fixtures/capture_sabine.json). */
export function sabineCapture(): Partial<MemoryData> {
  const { _comment, ...data } = JSON.parse(readFileSync(fixture('capture_sabine.json'), 'utf8')) as Partial<MemoryData> & {
    _comment?: string;
  };
  return data;
}

/** A drafter that returns a recorded draft instead of calling Claude (no cost, no network). */
export function fixtureDrafter(name = 'sabine-draft.json'): Drafter {
  return {
    async draft() {
      const parsed = parseDraft(readFileSync(fixture(name), 'utf8'));
      if (!parsed.ok) throw new Error(`fixture ${name} is not a valid draft: ${parsed.problem}`);
      return { draft: parsed.draft, attempts: 1 };
    },
  };
}
