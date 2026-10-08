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
    expect(sidebar.getApproverStateMeta("pending")).toEqual(expect.objectContaining({ label: "Awaiting Reply" }));
  });

  test("computes approval progress", () => {
    expect(sidebar.getApprovalProgressMetrics({
      approvers: [{ status: "approved" }, { status: "pending" }],
    })).toEqual(expect.objectContaining({ approved: 1, pending: 1, total: 2 }));
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
      approvers: [{ email: "agent@example.com", status: "approved" }],
    };
    const rejected = {
      ...approvalInstance,
      id: "instance-3",
      state: "rejected",
      approvers: [{ email: "agent@example.com", status: "rejected" }],
    };
    const sorted = sidebar.sortInstances([approved, approvalInstance, rejected]);
    expect(sidebar.getPrimaryInstance(sorted).state).toBe("pending");
    expect(sidebar.renderApprovalProgress(approved)).toContain("approved");
    expect(sidebar.renderApprovalProgress(rejected)).toContain("reviewed");
    expect(sidebar.renderApproverRow(approved, approved.approvers[0])).toContain("Approved");
    expect(sidebar.renderApproverRow(rejected, rejected.approvers[0])).toContain("Rejected");
  });

  test("synchronous UI helpers handle boundary input", () => {
    exerciseSynchronousHelpers(sidebar);
    expect(Object.keys(sidebar).length).toBeGreaterThan(30);
  });
});
