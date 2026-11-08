import { API_PREFIX } from './api';

export const HOST_PROTOCOL_VERSION = 1;
export const HOST_CONTROLLER_PATH = `${API_PREFIX}/host-controller`;
export type HostState = 'connected' | 'disconnected';
export interface HostRef { id: string; name: string; state: HostState }
export interface Host extends HostRef {
  kind: 'local' | 'remote';
  description: string;
  connectedAt: string | null;
  disconnectedAt: string | null;
  controllerVersion: string | null;
  dockerVersion: string | null;
  os: string | null;
  architecture: string | null;
  cpus: number | null;
  memoryBytes: number | null;
  backendUrl: string | null;
  backendUrlOverride: string | null;
  allowInsecure: boolean;
  network: string | null;
  error: string | null;
  workers: { id: string; name: string }[];
  runningContainers: number;
}

import { z } from 'zod';
const nullableText = (schema: z.ZodType<string>) => schema.nullable().transform((v) => v || null);
const hostFields = {
  name: z.string().trim().min(1).max(100),
  description: z.string().max(2000),
  backendUrlOverride: nullableText(z.string().trim().refine((value) => {
    if (!value) return true;
    return z.url({ protocol: /^https?$/ }).safeParse(value).success && !/[?#]/.test(value) && !/^https?:\/\/[^/]*@/.test(value);
  }, 'Use an absolute http or https URL without query or fragment').transform((v) => v.replace(/\/+$/, ''))),
  allowInsecure: z.boolean(),
  network: nullableText(z.string().trim().max(128).regex(/^$|^[A-Za-z0-9][A-Za-z0-9_.-]*$/)),
};
export const createHostBody = z.strictObject({ ...hostFields, description: hostFields.description.default(''), backendUrlOverride: hostFields.backendUrlOverride.default(null), allowInsecure: hostFields.allowInsecure.default(false), network: hostFields.network.default(null) });
export const updateHostBody = z.strictObject(hostFields).partial();
export type CreateHostBody = z.input<typeof createHostBody>;
export type UpdateHostBody = z.input<typeof updateHostBody>;
export interface HostConnection { host: Host; token: string; commands: string[] }
