import { __testApi__ as appCore } from "../app/scripts/app.js";
import {
  createClient,
  exerciseSynchronousHelpers,
  installHtmlFixture,
} from "./browser_test_utils.js";

describe("app.js bootstrap", () => {
  const rule = {
    id: "rule-1",
    name: "Manager approval",
    active: true,
    status_values: ["3"],
    status_value_labels: ["Pending"],
    condition_operator: "and",
    conditions: [{ field: "priority", operator: "is", values: ["1"] }],
    approvers: [{ email: "agent@example.com", label: "Agent" }],
    sender_email: "support@example.com",
    email_subject: "Approval {{ticket_id}}",
    email_body: "Please approve {{ticket_subject}}",
    summary: { status_text: "Pending", approval_mode_text: "Everyone must approve" },
    updated_at: Date.now(),
  };
  const dashboard = {
    success: true,
    rules: [rule],
    recent_instances: [{
      id: "instance-1",
      rule_name: rule.name,
      ticket_id: 42,
      ticket_subject: "Approval request",
      state: "pending",
      updated_at: Date.now(),
      approvers: rule.approvers,
    }],
    field_catalog: {
      status: { id: "status", label: "Status", type: "dropdown", options: [{ value: "3", label: "Pending" }] },
      priority: { id: "priority", label: "Priority", type: "dropdown", options: [{ value: "1", label: "Low" }] },
    },
    trigger_fields: [],
    sender_emails: [{ value: "support@example.com", label: "Support" }],
    approver_agent_options: [{ value: "agent@example.com", label: "Agent" }],
    helper: { email_placeholders: ["{{ticket_id}}", "{{ticket_subject}}"] },
  };

  beforeEach(() => {
    installHtmlFixture("app/index.html");
    const client = createClient();
    client.request.invoke.mockImplementation(async (name) => ({
      response: JSON.stringify(name === "getApprovalDashboardData" ? dashboard : { success: true }),
    }));
    globalThis.app = { initialized: vi.fn(async () => client) };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("exposes its DOM initializer to the unit harness", () => {
    expect(appCore.init).toBeTypeOf("function");
  });

  test("provides stable formatting helpers", () => {
    expect(appCore.normalizeEmail(" Agent@Example.COM ")).toBe("agent@example.com");
    expect(appCore.isValidEmail("agent@example.com")).toBe(true);
    expect(appCore.isValidEmail("invalid")).toBe(false);
    expect(appCore.updateStringSelection(["a"], "b", true)).toEqual(["a", "b"]);
    expect(appCore.updateStringSelection(["a", "b"], "a", false)).toEqual(["b"]);
    expect(appCore.escapeHtml('<b class="x">&</b>')).toBe("&lt;b class=&quot;x&quot;&gt;&amp;&lt;/b&gt;");
  });

  test("initializes and renders a dashboard response", async () => {
    await appCore.init();
    expect(globalThis.app.initialized).toHaveBeenCalledOnce();
    expect(document.getElementById("rulesList").innerHTML).toContain("Manager approval");
  });

  test("runs create, edit, toggle, and delete UI workflows", async () => {
    await appCore.init();
    appCore.openCreateRuleModal();
    appCore.openEditRuleModal(rule);
    expect(appCore.formToPayload()).toEqual(expect.objectContaining({ id: "rule-1" }));

    await appCore.toggleRule(rule);
    await appCore.deleteRule(rule);
    appCore.closeRuleModal();
    appCore.resetFormState();

    const client = await globalThis.app.initialized.mock.results[0].value;
    expect(client.request.invoke).toHaveBeenCalledWith("saveApprovalRule", expect.any(Object));
    expect(client.request.invoke).toHaveBeenCalledWith("deleteApprovalRule", { id: "rule-1" });
  });

  test("handles form and rule-list interactions", async () => {
    await appCore.init();
    appCore.openEditRuleModal(rule);

    const statusCheckbox = document.querySelector("#statusValuesChecklist input[data-status-value]");
    statusCheckbox.checked = true;
    appCore.handleStatusChecklistChange({ target: statusCheckbox });
    const conditionSelect = document.querySelector(".condition-field-select");
    conditionSelect.value = "priority";
    appCore.handleConditionChange({ target: conditionSelect });
    appCore.handleConditionClick({ target: { closest: () => null } });
    appCore.handleApproverChipClick({ target: { closest: () => null } });
    appCore.handleRuleAction({ target: { closest: () => null } });

    await appCore.loadDashboard({ silent: true, keepSuccess: true });
    expect(document.getElementById("rulesList").textContent).toContain("Manager approval");
  });

  test("synchronous UI helpers handle empty and boundary state", () => {
    exerciseSynchronousHelpers(appCore);
    expect(Object.keys(appCore).length).toBeGreaterThan(50);
  });
});
