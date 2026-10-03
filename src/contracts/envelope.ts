// TEMPORARY: replace with @sidekik/contracts (see ./README.md).
import { ulid } from 'ulid';

export type ServiceName = 'gateway' | 'perception' | 'brain' | 'mapper' | 'tutor' | 'voice' | 'meetbot';

export type Envelope<T> = {
  id: string;
  type: string;
  v: 1;
  org_id: string;
  session_id: string;
  t_ms: number;
  ts: string;
  producer: ServiceName;
  data: T;
};

export function makeEvent<T>(e: {
  type: string;
  org_id: string;
  session_id: string;
  t_ms: number;
  producer: ServiceName;
  data: T;
}): Envelope<T> {
  return { id: ulid(), v: 1, ts: new Date().toISOString(), ...e };
}
