export interface RuntimeCapabilities {
  start: boolean;
  pause: boolean;
  resume: boolean;
  cancel: boolean;
  isolatedWorktrees: boolean;
  enforcedWrites: boolean;
}
/** DockerRuntime implements this managed-job lifecycle. External IDEs are separate. */
export interface AgentRuntimeAdapter {
  capabilities(): RuntimeCapabilities;
  health(): Promise<{
    available: boolean;
    reason?: string;
    capabilities: RuntimeCapabilities;
    profiles: string[];
  }>;
  start(
    principal: unknown,
    input: { task_id: string; profile: string },
  ): Promise<unknown>;
  control(
    principal: unknown,
    jobId: string,
    action: "pause" | "resume" | "cancel",
  ): Promise<unknown>;
  status(principal: unknown, jobId: string): Promise<unknown>;
  apply(
    principal: unknown,
    jobId: string,
    files: { path: string; content: string | null }[],
  ): Promise<unknown>;
  diff(principal: unknown, jobId: string): Promise<unknown>;
}
