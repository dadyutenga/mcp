// Delivery receipts record a tool read, never background polling or a model's thoughts.
export const WORK_LEASE_MS = 5 * 60 * 1000;
export const BLOCKED_RECHECK_MS = 15 * 60 * 1000;
export const requestRevision = (q) => q.request_revision || 1;
export const receiptFor = (q, actor, connection) =>
  (q.read_receipts || []).find(
    (r) =>
      r.agent_id === actor &&
      r.revision === requestRevision(q) &&
      (connection === undefined || r.connection_id === connection),
  );
export const ownsWork = (q, p) =>
  q.work?.agent_id === p.id && q.work.connection_id === (p.token_id || null);
export function handling(q, actor, now = Date.now(), connection) {
  const result = (status, action_required) => ({
    status,
    action_required,
    revision: requestRevision(q),
    assigned_agent: q.work?.agent_id || null,
    next_check_at: q.work?.lease_until || null,
  });
  if (Date.parse(q.expires_at) <= now) return result("expired", false);
  if (["answered", "denied", "revoked"].includes(q.state))
    return result(q.state, false);
  if (q.state === "needs-input") return result("waiting_requester", false);
  const work = q.work?.revision === requestRevision(q) ? q.work : null;
  if (work && Date.parse(work.lease_until) > now)
    return result(
      work.agent_id === actor &&
        (connection === undefined || work.connection_id === connection)
        ? work.status
        : "assigned_elsewhere",
      false,
    );
  if (work) return result("overdue", true);
  return result(
    receiptFor(q, actor, connection)
      ? "awaiting_acknowledgement"
      : "awaiting_read",
    true,
  );
}
export const requestView = (q, actor, connection) => ({
  ...q,
  request_revision: requestRevision(q),
  handling: handling(q, actor, Date.now(), connection),
});
