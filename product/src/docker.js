// Preserve the caller's selected context and TLS settings by default.
// An explicit host intentionally takes precedence over a saved/current context.
export function dockerConnection(
  env = process.env,
  host = env.COORDINATION_DOCKER_HOST,
) {
  const childEnv = { ...env };
  if (host) delete childEnv.DOCKER_CONTEXT;
  return { args: host ? ["--host=" + host] : [], env: childEnv };
}
