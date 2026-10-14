import { __testApi__ as sidebar } from "../app/scripts/sidebar.js";
import {
  createClient,
  exerciseSynchronousHelpers,
  installHtmlFixture,
} from "./browser_test_utils.js";

describe("ticket sidebar helpers", () => {
  const approvalInstance = {
    id: "instance-1",
    rule_id: "rule-1",
    rule_name: "Manager approval",
    ticket_id: 42,
    ticket_subject: "Approval request",
    state: "pending",
    approval_mode: "everyone",
    approved_count: 0,
    rejected_count: 0,
    pending_count: 1,
    approvers: [{
      email: "agent@example.com",
      label: "Agent",
      status: "pending",
      email_delivery_status: "sent",
    }],
    created_at: Date.now() - 1000,
    updated_at: Date.now(),
  };

  beforeEach(() => {
    installHtmlFixture("app/sidebar.html");
    const client = createClient();
    client.request.invoke.mockImplementation(async (name) => ({
      response: JSON.stringify(
        name === "getTicketApprovalData"
          ? { success: true, ticket_id: 42, instances: [approvalInstance] }
          : name === "submitSidebarApprovalDecision"
            ? { success: true, instance: { ...approvalInstance, state: "approved" } }
            : { success: true }
      ),
    }));
    globalThis.app = { initialized: vi.fn(async () => client) };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("formats approver identity and state", () => {
    expect(sidebar.normalizeEmail(" Agent@Example.COM ")).toBe("agent@example.com");
    expect(sidebar.humanizeApproverNameFromEmail("jane.doe@example.com")).toBe("Jane Doe");
    expect(sidebar.getApproverStateMeta("approved")).toEqual(expect.objectContaining({ label: "Approved" }));
    expect(sidebar.getApproverStateMeta("rejected")).toEqual(expect.objectContaining({ label: "Rejected" }));
    expect(sidebar.getApproverStateMeta("not_required")).toEqual(expect.objectContaining({ label: "Not Required" }));
    expect(sidebar.getApproverStateMeta("pending")).toEqual(expect.objectContaining({ label: "Awaiting Reply" }));
  });

  test("extracts nested identities and authorizes matching agent ids", () => {
    const agent = sidebar.extractLoggedInAgent({
      loggedInUser: {
        user: {
          id: 112,
          email: "alternate@example.com",
          name: "Approver",
        },
      },
    });
    expect(agent).toEqual({ id: 112, email: "alternate@example.com", name: "Approver" });
    expect(sidebar.canLoggedInAgentAct(
      approvalInstance,
      { ...approvalInstance.approvers[0], agent_id: 112 },
      { id: 112, email: "changed@example.com" }
    )).toBe(true);
  });

  test("computes approval progress", () => {
    expect(sidebar.getApprovalProgressMetrics({
      approvers: [{ status: "approved" }, { status: "pending" }],
    })).toEqual(expect.objectContaining({ approved: 1, pending: 1, total: 2 }));
  });

  test("renders unneeded reviewers correctly after a terminal rejection", () => {
    const rejectedWithPendingReviewer = {
      ...approvalInstance,
      state: "rejected",
      approved_count: 0,
      rejected_count: 1,
      pending_count: 0,
      approvers: [
        { email: "pending@example.com", label: "Pending Agent", status: "pending" },
        { email: "rejected@example.com", label: "Rejecting Agent", status: "rejected" },
      ],
    };

    expect(sidebar.getApprovalProgressMetrics(rejectedWithPendingReviewer)).toEqual(
      expect.objectContaining({ pending: 0, notRequired: 1, percent: 100 })
    );
    expect(sidebar.renderApprovalProgress(rejectedWithPendingReviewer)).toContain("Request rejected");
    expect(sidebar.renderApprovalProgress(rejectedWithPendingReviewer)).toContain("1 not required");
    const pendingRow = sidebar.renderApproverRow(
      rejectedWithPendingReviewer,
      rejectedWithPendingReviewer.approvers[0]
    );
    expect(pendingRow).toContain("Not Required");
    expect(pendingRow).not.toContain("data-approval-action");
  });

  test("keeps a remaining reviewer actionable in anyone mode after another rejection", () => {
    const anyonePending = {
      ...approvalInstance,
      state: "pending",
      approval_mode: "anyone",
      approvers: [
        { email: "first@example.com", status: "rejected", agent_id: 10 },
        { email: "second@example.com", status: "pending", agent_id: 20 },
      ],
    };

    expect(sidebar.canLoggedInAgentAct(
      anyonePending,
      anyonePending.approvers[1],
      { id: 20, email: "second@example.com" }
    )).toBe(true);
  });

  test("normalizes ticket events and plain objects", () => {
    expect(sidebar.clonePlainObject({ a: 1 })).toEqual({ a: 1 });
    expect(sidebar.clonePlainObject(null)).toEqual({});
    expect(sidebar.normalizeTicketEventValue("status", { value: 4 })).toBe("4");
    expect(sidebar.escapeHtml('<b class="x">&</b>')).toBe("&lt;b class=&quot;x&quot;&gt;&amp;&lt;/b&gt;");
  });

  test("initializes and renders the current ticket", async () => {
    await sidebar.init();
    expect(globalThis.app.initialized).toHaveBeenCalledOnce();
    expect(document.getElementById("approvalList").textContent).toContain("Agent");
  });

  test("captures ticket changes and submits an assigned approver action", async () => {
    await sidebar.init();
    await sidebar.handleTicketFieldChanged("status", {
      helper: { getData: vi.fn(async () => ({ old: 2, new: 3 })) },
    });

    const button = document.querySelector("[data-approval-action='approved']");
    expect(button).not.toBeNull();
    expect(button.closest(".approver-actions")).not.toBeNull();
    await sidebar.handleSummaryActionClick({ target: button });

    const client = await globalThis.app.initialized.mock.results[0].value;
    expect(client.request.invoke).toHaveBeenCalledWith(
      "submitSidebarApprovalDecision",
      expect.objectContaining({ instance_id: "instance-1", decision: "approved" })
    );
  });

  test("sorts, selects, and renders approval state variants", () => {
    const approved = {
      ...approvalInstance,
      id: "instance-2",
      state: "approved",
      approved_count: 1,
      rejected_count: 0,
      pending_count: 0,
      approvers: [{ email: "agent@example.com", status: "approved" }],
    };
    const rejected = {
      ...approvalInstance,
      id: "instance-3",
      state: "rejected",
      approved_count: 0,
      rejected_count: 1,
      pending_count: 0,
      approvers: [{ email: "agent@example.com", status: "rejected" }],
    };
    const sorted = sidebar.sortInstances([approved, approvalInstance, rejected]);
    expect(sidebar.getPrimaryInstance(sorted).state).toBe("pending");
    expect(sidebar.renderApprovalProgress(approved)).toContain("approved");
    expect(sidebar.renderApprovalProgress(rejected)).toContain("Request rejected");
    expect(sidebar.renderApproverRow(approved, approved.approvers[0])).toContain("Approved");
    expect(sidebar.renderApproverRow(rejected, rejected.approvers[0])).toContain("Rejected");
  });

  test("synchronous UI helpers handle boundary input", () => {
    exerciseSynchronousHelpers(sidebar);
    expect(Object.keys(sidebar).length).toBeGreaterThan(30);
  });
});
