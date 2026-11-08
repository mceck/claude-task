export const HOST_PROTOCOL_VERSION = 1;
export const HOST_CONTROLLER_PATH = '/api/host-controller';
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
