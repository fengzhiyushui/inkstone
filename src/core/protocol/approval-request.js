import { makeId } from "../../shared/id.js";

export function createApprovalRequest({
  turnId,
  kind,
  risk = "medium",
  summary,
  detailsRef = null,
  decisions = ["approve", "deny"],
  id = makeId("approval"),
  category = null
}) {
  if (!turnId) throw new Error("turnId is required");
  if (!kind) throw new Error("approval kind is required");
  if (!summary) throw new Error("approval summary is required");

  return {
    id,
    turn_id: turnId,
    kind,
    risk,
    summary,
    details_ref: detailsRef,
    decisions,
    // v1.13.1:风险等级(read/mutate/destructive),供三端判定可否持久放行
    ...(category ? { category } : {})
  };
}
