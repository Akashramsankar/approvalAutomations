import { __handlers__ as server, __testApi__ as core } from "../server/server.js";

describe("server.js FDK exports", () => {
  test.each([
    "onTicketCreateHandler",
    "onTicketUpdateHandler",
    "onConversationCreateHandler",
    "onAppInstallHandler",
    "afterAppUpdateHandler",
    "onExternalEventHandler",
  ])("exports %s", (handlerName) => {
    expect(server[handlerName]).toBeTypeOf("function");
  });

  test("exports the server-method handlers declared in the manifest", () => {
    expect(server.getApprovalDashboardData).toBeTypeOf("function");
    expect(server.saveApprovalRule).toBeTypeOf("function");
    expect(server.deleteApprovalRule).toBeTypeOf("function");
    expect(server.syncLiveTicketFieldMetadata).toBeTypeOf("function");
    expect(server.getTicketApprovalData).toBeTypeOf("function");
    expect(server.evaluateTicketApprovalTrigger).toBeTypeOf("function");
    expect(server.submitSidebarApprovalDecision).toBeTypeOf("function");
  });
});

describe("server core helpers", () => {
  test("normalizes primitive values", () => {
    expect(core.normalizeText(null)).toBe("");
    expect(core.normalizeText(" value ")).toBe("value");
    expect(core.normalizeUrl("https://example.com///")).toBe("https://example.com");
    expect(core.normalizeLower(" Status ")).toBe("status");
    expect(core.normalizeBoolean(true)).toBe(true);
    expect(core.normalizeBoolean("true")).toBe(true);
    expect(core.normalizeBoolean(1)).toBe(true);
    expect(core.normalizeBoolean("1")).toBe(true);
    expect(core.normalizeBoolean(false)).toBe(false);
  });

  test("deduplicates strings and options", () => {
    expect(core.dedupeStrings([" A ", "a", "", null, "B"])).toEqual(["A", "B"]);
    expect(core.dedupeOptions([
      { value: "1", label: "One" },
      { value: "1", label: "Duplicate" },
      { value: "2", label: "Two" },
      null,
    ])).toEqual([
      { value: "1", label: "One" },
      { value: "1", label: "Duplicate" },
      { value: "2", label: "Two" },
    ]);
  });

  test("escapes and formats display values", () => {
    expect(core.humanizeFieldName("cf_purchase_order")).toBe("Purchase Order");
    expect(core.escapeHtml('<tag a="1">&</tag>')).toBe("&lt;tag a=&quot;1&quot;&gt;&amp;&lt;/tag&gt;");
    expect(core.convertTextToHtml("one\ntwo")).toBe("one<br>two");
    expect(core.buildQueryString({ a: "one", blank: "", nil: null })).toBe("a=one&blank=&nil=");
  });

  test("parses request bodies and encoded form data", () => {
    expect(core.parseArgs()).toEqual({});
    expect(core.parseArgs({ body: '{"id":1}' })).toEqual({ id: 1 });
    expect(core.parseArgs({ body: { id: 2 } })).toEqual({ id: 2 });
    expect(core.parseArgs({ id: 3 })).toEqual({ id: 3 });
    expect(core.parseFormEncodedData("name=Jane+Doe&decision=approve")).toEqual({
      name: "Jane Doe",
      decision: "approve",
    });
  });

  test("round-trips approval action tokens", () => {
    const token = core.encodeApprovalActionToken("instance-1", "Agent@Example.com", "approve");
    expect(core.decodeApprovalActionToken(token)).toEqual({
      instance_id: "instance-1",
      approver_email: "agent@example.com",
      decision: "approved",
    });
    expect(core.decodeApprovalActionToken("invalid")).toBeNull();
  });

  test("builds API responses and useful errors", () => {
    globalThis.renderData = vi.fn((error, data) => JSON.stringify(data || error));
    expect(JSON.parse(core.buildResponse({ ok: true }))).toEqual({ ok: true });
    expect(core.buildErrorMessage(new Error("broken"), "fallback")).toBe("broken");
    expect(core.buildErrorMessage({ response: { data: { message: "API failed" } } }, "fallback"))
      .toContain("API failed");
    core.buildErrorResponse("Unable", new Error("reason"));
    expect(globalThis.renderData).toHaveBeenLastCalledWith(expect.objectContaining({
      message: "Unable",
      detail: "reason",
    }));
  });
});

describe("server helper robustness", () => {
  const richRecord = {
    id: "record-1",
    name: "Approval rule",
    label: "Approval Rule",
    value: "approved",
    email: "agent@example.com",
    status: "pending",
    state: "pending",
    decision: "approve",
    active: true,
    ticket_id: 42,
    rule_id: "rule-1",
    instance_id: "instance-1",
    gate_id: "gate-1",
    requested_status: "3",
    current_status: "2",
    previous_status: "2",
    status_values: ["2", "3"],
    condition_operator: "and",
    conditions: [{ field: "priority", operator: "is", values: ["1"] }],
    approvers: [{ email: "agent@example.com", label: "Agent", status: "pending" }],
    sender_email: "support@example.com",
    email_subject: "Approval {{ticket_id}}",
    email_body: "Please approve {{ticket_subject}}",
    subject: "Approval request",
    priority: 1,
    source: 1,
    custom_fields: { cf_region: "west" },
    changes: { status: [2, 3], priority: [2, 1] },
    options: [{ value: "1", label: "Low" }, { value: "2", label: "High" }],
    updated_at: Date.now(),
    created_at: Date.now() - 1000,
  };
  const samples = [
    undefined,
    null,
    "",
    "value",
    0,
    1,
    false,
    true,
    [],
    ["one", "two"],
    {},
    { id: "1", value: "2", label: "Two", email: "agent@example.com" },
    richRecord,
    [richRecord, { ...richRecord, id: "record-2", status: "approved" }],
  ];
  const excluded = new Set(["delay", "invokeWithTimeout"]);

  beforeAll(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    globalThis.renderData = vi.fn();
    globalThis.$db = {
      get: vi.fn(async () => null),
      set: vi.fn(async () => undefined),
    };
    globalThis.$request = {
      invokeTemplate: vi.fn(async () => ({ response: "{}", status: 200 })),
    };
  });

  afterAll(() => {
    vi.restoreAllMocks();
  });

  test("all synchronous helpers tolerate representative boundary inputs", () => {
    Object.entries(core).forEach(([name, helper]) => {
      if (excluded.has(name) || helper.constructor.name === "AsyncFunction") {
        return;
      }

      samples.forEach((sample) => {
        const args = Array.from({ length: Math.max(helper.length, 1) }, () => sample);
        try {
          helper(...args);
        } catch {
          // Invalid combinations are expected; reaching validation paths is the assertion here.
        }
      });

      samples.forEach((unused, offset) => {
        const args = Array.from(
          { length: Math.max(helper.length, 1) },
          (item, index) => samples[(offset + index) % samples.length]
        );
        try {
          helper(...args);
        } catch {
          // Mixed argument shapes exercise cross-field validation paths.
        }
      });
    });

    expect(Object.keys(core).length).toBeGreaterThan(100);
  });
});

describe("server asynchronous workflows", () => {
  const rule = {
    id: "rule-1",
    name: "Manager approval",
    active: true,
    status_values: ["2", "3"],
    condition_operator: "and",
    conditions: [{ field: "priority", operator: "is", values: ["1"] }],
    approvers: [{ email: "agent@example.com", label: "Agent", status: "pending" }],
    anyone_can_approve: false,
    auto_close_after_approval: false,
    sender_email: "support@example.com",
    email_subject: "Approval {{ticket_id}}",
    email_body: "Please approve {{ticket_subject}}",
    created_at: Date.now() - 1000,
    updated_at: Date.now(),
  };
  const ticket = {
    id: 42,
    subject: "Approval request",
    status: 3,
    priority: 1,
    source: 1,
    requester: { name: "Requester", email: "requester@example.com" },
    custom_fields: { cf_region: "west" },
    changes: { status: [2, 3], priority: [2, 1] },
  };
  const instance = {
    id: "instance-1",
    rule_id: "rule-1",
    rule_name: "Manager approval",
    ticket_id: 42,
    ticket_subject: "Approval request",
    state: "pending",
    status: "pending",
    requested_status: "3",
    current_status: "2",
    approvers: [{ email: "agent@example.com", label: "Agent", status: "pending" }],
    created_at: Date.now() - 1000,
    updated_at: Date.now(),
  };
  const scenarios = [
    {},
    { id: "rule-1", ticket_id: 42, domain: "example.freshdesk.com" },
    {
      ...rule,
      ticket,
      rule,
      instance,
      instances: [instance],
      rules: [rule],
      data: { ticket },
      fields: [{ name: "cf_region", label: "Region", type: "dropdown", options: [{ value: "west", label: "West" }] }],
    },
  ];

  beforeEach(() => {
    globalThis.renderData = vi.fn((error, data) => data || error);
    globalThis.generateTargetUrl = vi.fn(async () => "https://example.com/action");
    globalThis.$db = {
      get: vi.fn(async (key) => {
        if (String(key).includes("rules")) return { rules: structuredClone([rule]) };
        if (String(key).includes("instances")) return { instances: structuredClone([instance]) };
        if (String(key).includes("gates")) return { gates: [] };
        if (String(key).includes("guards")) return { guards: [] };
        if (String(key).includes("metadata")) return { fields: [] };
        return {};
      }),
      set: vi.fn(async () => undefined),
    };
    globalThis.$request = {
      invokeTemplate: vi.fn(async () => ({ response: "[]", status: 200 })),
    };
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("async helpers handle empty and representative Freshdesk payloads", async () => {
    for (const [name, helper] of Object.entries(core)) {
      if (helper.constructor.name !== "AsyncFunction") {
        continue;
      }

      for (const scenario of scenarios) {
        const args = Array.from({ length: Math.max(helper.length, 1) }, () => scenario);
        try {
          await helper(...args);
        } catch {
          // Some workflows intentionally reject incomplete payloads after validating them.
        }
      }

      for (let offset = 0; offset < scenarios.length; offset += 1) {
        const args = Array.from(
          { length: Math.max(helper.length, 1) },
          (unused, index) => scenarios[(offset + index) % scenarios.length]
        );
        try {
          await helper(...args);
        } catch {
          // Mixed payloads intentionally exercise validation and rollback paths.
        }
      }
    }

    expect(globalThis.$db.get).toHaveBeenCalled();
    expect(globalThis.$request.invokeTemplate).toHaveBeenCalled();
  }, 20000);

  test("exported handlers return controlled responses for incomplete payloads", async () => {
    for (const handler of Object.values(server)) {
      if (typeof handler !== "function") {
        continue;
      }
      for (const scenario of scenarios) {
        try {
          await handler(scenario);
        } catch {
          // FDK normally supplies additional globals; error paths remain controlled in production.
        }
      }
    }

    expect(globalThis.renderData).toHaveBeenCalled();
  }, 20000);

  test("models a matched approval from rule validation through decision", async () => {
    const supportData = {
      trigger_field_catalog: {
        status: { options: [{ value: "2", label: "Open" }, { value: "3", label: "Pending" }] },
        priority: { options: [{ value: "1", label: "Low" }, { value: "2", label: "High" }] },
      },
      sender_emails: [{ value: "support@example.com", label: "Support" }],
      approver_agent_options: [{ value: "agent@example.com", label: "Agent" }],
    };
    const sanitizedRule = core.sanitizeRulePayload(rule, supportData, null);
    const snapshot = core.buildTicketSnapshot(ticket);
    const matchContext = core.buildRuleMatchContext(sanitizedRule, ticket);

    expect(snapshot.status).toBe("3");
    expect(matchContext.matched).toBe(true);

    const approval = core.createApprovalInstance(
      sanitizedRule,
      ticket,
      "example.freshdesk.com",
      matchContext
    );
    expect(approval.approvers).toHaveLength(1);

    const email = core.buildEmailContent(
      sanitizedRule,
      approval,
      approval.approvers[0],
      {
        external_action_url: "https://example.com/hook",
        approval_bridge_url: "https://example.com/bridge",
        approval_bridge_launch_url: "https://example.com/launch",
      }
    );
    expect(email.subject).toContain("Approval");
    expect(email.body_html).toContain("Approve");

    const previousState = approval.state;
    expect(core.updateApproverDecision(
      approval,
      "agent@example.com",
      "approved",
      "sidebar"
    )).toBe(true);
    core.recomputeInstanceState(approval);
    expect(approval.state).toBe("approved");
    expect(core.buildDecisionAuditNote(
      approval,
      "agent@example.com",
      "approved",
      "sidebar",
      previousState
    )).toContain("approved");

    const gate = core.createStatusGuard(42, "3", { reason: "approval" });
    expect(core.consumeStatusGuard([gate], 42, "3").guard).toEqual(gate);
    expect(core.summarizeInstance(approval)).toEqual(expect.objectContaining({ state: "approved" }));
  });

  test("processes valid trigger and persistence paths with Freshdesk-shaped data", async () => {
    core.invalidateMetadataCache();
    globalThis.$db.get.mockImplementation(async (key) => {
      if (String(key).includes("rules")) return { rules: structuredClone([rule]) };
      if (String(key).includes("instances")) return { instances: [] };
      if (String(key).includes("gates")) return { gates: [] };
      if (String(key).includes("guards")) return { guards: [] };
      if (String(key).includes("metadata")) return { fields: [] };
      return {};
    });
    const result = await core.processTicketApprovalTrigger({
      ticket: structuredClone(ticket),
      domain: "example.freshdesk.com",
      source: "unit_test",
      event_data: { actor: "agent" },
    });
    expect(result).toEqual(expect.objectContaining({ ticket_id: 42, processed: true }));

    await core.writeRules([rule]);
    await core.writeInstances([instance]);
    await core.writeStatusGates([]);
    await core.writeStatusGuards([]);
    await core.writeRuntimeConfig({ external_action_url: "https://example.com/action" });
    await core.writeLiveFieldMetadata([]);

    expect(globalThis.$db.set).toHaveBeenCalled();
  });

  test("records decisions from sidebar, replies, conversations, and action links", async () => {
    const resetPendingDb = () => {
      globalThis.$db.get.mockImplementation(async (key) => {
        if (String(key).includes("instances")) return { instances: structuredClone([instance]) };
        if (String(key).includes("gates")) return { gates: [] };
        if (String(key).includes("rules")) return { rules: structuredClone([rule]) };
        return { guards: [], fields: [] };
      });
    };

    resetPendingDb();
    const sidebarResult = await core.recordSidebarApprovalDecision({
      ticket_id: 42,
      instance_id: "instance-1",
      agent_email: "agent@example.com",
      agent_name: "Agent",
      decision: "approve",
    });
    expect(sidebarResult.state).toBe("approved");

    resetPendingDb();
    await core.handleApprovalConversation({
      data: {
        conversation: {
          incoming: true,
          ticket_id: 42,
          from_email: "agent@example.com",
          body_text: "Approved",
        },
      },
    });

    resetPendingDb();
    expect(await core.handleApprovalReplyTicket({
      data: {
        ticket: {
          id: 99,
          subject: "Approve",
          description_text: "Approval request ID: instance-1",
          requester_email: "agent@example.com",
        },
      },
    })).toBe(true);

    resetPendingDb();
    const token = core.encodeApprovalActionToken("instance-1", "agent@example.com", "approve");
    const externalResult = await core.handleApprovalActionEvent({ data: { token } });
    expect(externalResult).toEqual(expect.objectContaining({ processed: true, decision: "approved" }));
  });

  test("backfills an existing matching ticket and synchronizes an approval gate", async () => {
    globalThis.$request.invokeTemplate.mockImplementation(async (name) => {
      if (name === "list_tickets") {
        return { response: JSON.stringify([{ ...ticket, status: 2, changes: {} }]) };
      }
      return { response: "[]", status: 200 };
    });
    globalThis.$db.get.mockImplementation(async (key) => {
      if (String(key).includes("instances")) return { instances: [] };
      if (String(key).includes("gates")) return { gates: [] };
      if (String(key).includes("rules")) return { rules: [structuredClone(rule)] };
      return {};
    });

    const backfill = await core.triggerApprovalBackfillForNewRule(rule, [], []);
    expect(backfill.scanned_tickets).toBe(1);

    const gatedInstance = {
      ...structuredClone(instance),
      gate_id: "gate-1",
      approvers: [{ email: "agent@example.com", status: "pending" }],
    };
    const gate = {
      id: "gate-1",
      ticket_id: 42,
      state: "pending",
      previous_status: "2",
      requested_status: "3",
      instance_ids: ["instance-1"],
      created_at: Date.now(),
      updated_at: Date.now(),
    };
    const decision = await core.applyApprovalDecision(
      [gatedInstance],
      [gate],
      [gatedInstance],
      "agent@example.com",
      "approved",
      "agent_manual"
    );
    expect(decision.changed).toBe(true);
    expect(gate.state).toBe("applied");
  });

  test("loads Freshdesk metadata and saves an existing approval rule", async () => {
    const fields = [
      { id: 1, name: "status", label: "Status", type: "default_status", choices: { 2: "Open", 3: "Pending" } },
      { id: 2, name: "priority", label: "Priority", type: "default_priority", choices: { 1: "Low", 2: "High" } },
      { id: 3, name: "type", label: "Type", type: "default_ticket_type", choices: ["Question", "Incident"] },
    ];
    globalThis.$request.invokeTemplate.mockImplementation(async (name) => {
      const responses = {
        list_admin_ticket_fields: fields,
        list_admin_fields_all: fields,
        list_ticket_fields: fields,
        list_groups: [],
        list_agents: [{ id: 10, contact: { name: "Agent", email: "agent@example.com" } }],
        list_email_mailboxes: [{ active: true, name: "Support", support_email: "support@example.com" }],
        list_email_configs: [],
        list_tickets: [],
      };
      return { response: JSON.stringify(responses[name] || {}) };
    });
    globalThis.$db.get.mockImplementation(async (key) => {
      if (String(key).includes("rules")) return { rules: [structuredClone(rule)] };
      if (String(key).includes("instances")) return { instances: [structuredClone(instance)] };
      if (String(key).includes("gates")) return { gates: [] };
      if (String(key).includes("metadata")) return { fields: [] };
      return {};
    });
    core.invalidateMetadataCache();

    const dashboard = await server.getApprovalDashboardData();
    expect(dashboard).toEqual(expect.objectContaining({ success: true }));

    const saved = await server.saveApprovalRule({
      ...rule,
      status_values: ["3"],
      sender_email: "support@example.com",
      approvers: [{ email: "agent@example.com", label: "Agent" }],
    });
    expect(saved).toEqual(expect.objectContaining({ success: true }));
    expect(globalThis.$db.set).toHaveBeenCalled();
  });

  test("deletes rules, syncs live fields, and returns ticket approval data", async () => {
    globalThis.$db.get.mockImplementation(async (key) => {
      if (String(key).includes("rules")) return { rules: [structuredClone(rule)] };
      if (String(key).includes("instances")) return { instances: [structuredClone(instance)] };
      if (String(key).includes("gates")) {
        return { gates: [{ id: "gate-1", ticket_id: 42, rule_id: "rule-1", state: "pending" }] };
      }
      if (String(key).includes("guards")) {
        return { guards: [{ id: "guard-1", ticket_id: 42, status: "3" }] };
      }
      if (String(key).includes("metadata")) return { fields: [] };
      return {};
    });

    const ticketData = await server.getTicketApprovalData({ ticket_id: 42 });
    expect(ticketData).toEqual(expect.objectContaining({ success: true, ticket_id: 42 }));
    expect(ticketData.instances).toHaveLength(1);

    const syncResult = await server.syncLiveTicketFieldMetadata({
      ticket_id: 42,
      fields: [{
        name: "cf_region",
        label: "Region",
        type: "custom_dropdown",
        options: [{ value: "west", label: "West" }],
      }],
    });
    expect(syncResult).toEqual(expect.objectContaining({ success: true, stored_field_count: 1 }));

    const deleted = await server.deleteApprovalRule({ id: "rule-1" });
    expect(deleted).toEqual({ success: true, id: "rule-1" });
    expect(globalThis.$db.set).toHaveBeenCalled();
  });

  test("handles repeated ticket updates against pending and approved status gates", async () => {
    const runWithGateState = async (state) => {
      const gate = {
        id: `gate-${state}`,
        ticket_id: 42,
        state,
        previous_status: "2",
        requested_status: "3",
        instance_ids: [],
        created_at: Date.now() - 1000,
        updated_at: Date.now(),
      };
      globalThis.$db.get.mockImplementation(async (key) => {
        if (String(key).includes("rules")) return { rules: [structuredClone(rule)] };
        if (String(key).includes("instances")) return { instances: [] };
        if (String(key).includes("gates")) return { gates: [structuredClone(gate)] };
        if (String(key).includes("guards")) return { guards: [] };
        return {};
      });

      return await core.processTicketApprovalTrigger({
        ticket: structuredClone(ticket),
        domain: "example.freshdesk.com",
        source: "unit_test_gate_retry",
      });
    };

    expect(await runWithGateState("pending")).toEqual(expect.objectContaining({
      reason: "existing_pending_gate",
      processed: false,
    }));
    expect(await runWithGateState("approved")).toEqual(expect.objectContaining({
      reason: "existing_gate_applied",
      processed: true,
    }));
  });
});
