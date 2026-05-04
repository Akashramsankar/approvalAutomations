let client;
let refreshIntervalId;

const INVOKE_TIMEOUT_MS = 15000;
const AUTO_REFRESH_MS = 10000;
const POST_UPDATE_REFRESH_MS = 1500;
const POST_UPDATE_REFRESH_ATTEMPTS = 10;
const POST_UPDATE_FALLBACK_ATTEMPT = 4;

const TRACKED_TICKET_EVENTS = [
  { eventName: "ticket.statusChanged", fieldId: "status" },
  { eventName: "ticket.priorityChanged", fieldId: "priority" },
  { eventName: "ticket.groupChanged", fieldId: "group" },
  { eventName: "ticket.agentChanged", fieldId: "agent" },
  { eventName: "ticket.typeChanged", fieldId: "ticket_type" },
];

const state = {
  loading: true,
  ticketId: 0,
  currentTicket: null,
  instances: [],
  loggedInAgent: {
    id: 0,
    email: "",
    name: "",
  },
  pendingFieldChanges: {},
  postUpdateProbeToken: 0,
  postUpdateRefreshActive: false,
  loadRequestToken: 0,
  lastLiveFieldSyncSignature: "",
  emptyStateRecoveryTicketId: 0,
  actionInFlight: "",
  message: {
    type: "",
    text: "",
  },
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    client = await app.initialized();
    bindEvents();
    await loadSidebar();

    client.events.on("app.activated", async () => {
      await resolveTicketContext();
      void loadSidebar({ silent: true });
    });

    refreshIntervalId = window.setInterval(() => {
      void loadSidebar({ silent: true });
    }, AUTO_REFRESH_MS);
  } catch (error) {
    console.error("Failed to initialize approval sidebar:", error);
    state.loading = false;
    setMessage("Unable to initialize the approval sidebar.", "error");
    render();
  }
}

function bindEvents() {
  document.getElementById("refreshBtn").addEventListener("click", () => {
    void loadSidebar();
  });
  document.getElementById("approvalList").addEventListener("click", handleSummaryActionClick);

  TRACKED_TICKET_EVENTS.forEach(({ eventName, fieldId }) => {
    client.events.on(eventName, (event) => {
      void handleTicketFieldChanged(fieldId, event);
    });
  });

  client.events.on("ticket.propertiesUpdated", (event) => {
    void handleTicketPropertiesUpdated(event);
  });

  window.addEventListener("beforeunload", () => {
    if (refreshIntervalId) {
      window.clearInterval(refreshIntervalId);
    }
  });
}

async function resolveTicketContext() {
  const previousTicketId = state.ticketId;
  const [ticketResult, userResult] = await Promise.all([
    client.data.get("ticket"),
    client.data.get("loggedInUser"),
  ]);
  const result = ticketResult;
  const ticket = result && result.ticket ? result.ticket : result;
  state.currentTicket = ticket || null;
  state.ticketId = Number(ticket && ticket.id);
  state.loggedInAgent = extractLoggedInAgent(userResult);

  if (!state.ticketId) {
    throw new Error("Ticket context is unavailable.");
  }

  return previousTicketId !== state.ticketId;
}

async function loadSidebar(options) {
  const ticketChanged = await resolveTicketContext();
  if (ticketChanged) {
    state.instances = [];
    state.pendingFieldChanges = {};
    state.postUpdateProbeToken += 1;
    state.postUpdateRefreshActive = false;
    state.emptyStateRecoveryTicketId = 0;
    state.actionInFlight = "";
  }

  const requestTicketId = state.ticketId;
  state.loadRequestToken += 1;
  const loadToken = state.loadRequestToken;

  if (!options || !options.silent || ticketChanged) {
    state.loading = true;
  }

  if (!options || !options.keepMessage) {
    clearMessage();
  }

  render();

  try {
    void syncLiveTicketFieldMetadata({ force: ticketChanged });
    const response = await invokeWithTimeout("getTicketApprovalData", {
      ticket_id: requestTicketId,
    });
    const payload = parseInvokeResponse(response);

    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to load ticket approval data.");
    }

    if (loadToken !== state.loadRequestToken || requestTicketId !== state.ticketId) {
      return;
    }

    const nextInstances = sortInstances(Array.isArray(payload.instances) ? payload.instances : []);
    if (shouldPreserveCurrentInstances(nextInstances, options)) {
      return;
    }

    state.instances = nextInstances;

    if (!nextInstances.length && shouldAttemptEmptyStateRecovery(options)) {
      state.emptyStateRecoveryTicketId = state.ticketId;
      await attemptEmptyStateRecovery();
      return;
    }
  } catch (error) {
    if (loadToken !== state.loadRequestToken || requestTicketId !== state.ticketId) {
      return;
    }

    console.error("Failed to load sidebar data:", error);
    setMessage(resolveErrorMessage(error, "Unable to load ticket approval data."), "error");
  } finally {
    if (loadToken === state.loadRequestToken && requestTicketId === state.ticketId) {
      state.loading = false;
      render();
    }
  }
}

function shouldAttemptEmptyStateRecovery(options) {
  return Boolean(
    state.ticketId &&
    state.currentTicket &&
    state.emptyStateRecoveryTicketId !== state.ticketId &&
    !(options && options.skipEmptyRecovery)
  );
}

async function attemptEmptyStateRecovery() {
  try {
    const ticket = buildFallbackTicketPayload(state.currentTicket || await getCurrentTicket());
    const response = await invokeWithTimeout("evaluateTicketApprovalTrigger", {
      source: "ticket_sidebar_empty_state_recovery",
      ticket,
      changes: buildCreateFallbackChanges(ticket),
    });
    const payload = parseInvokeResponse(response);

    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Empty-state trigger recovery failed.");
    }
  } catch (error) {
    console.error("Failed to recover sidebar empty state:", error);
  }

  await loadSidebar({ silent: true, keepMessage: true, skipEmptyRecovery: true });
}

function render() {
  renderMessage();
  renderApprovalList();
}

function renderMessage() {
  const banner = document.getElementById("messageBanner");

  if (!state.message.text) {
    banner.textContent = "";
    banner.className = "banner hidden";
    return;
  }

  banner.textContent = state.message.text;
  banner.className = `banner ${state.message.type === "error" ? "banner-error" : "banner-info"}`;
}

function renderApprovalList() {
  const loadingEl = document.getElementById("loadingState");
  const emptyEl = document.getElementById("emptyState");
  const approvalList = document.getElementById("approvalList");

  if (state.loading) {
    loadingEl.classList.remove("hidden");
    emptyEl.classList.add("hidden");
    approvalList.classList.add("hidden");
    approvalList.innerHTML = "";
    return;
  }

  loadingEl.classList.add("hidden");

  if (!state.instances.length) {
    emptyEl.classList.remove("hidden");
    approvalList.classList.add("hidden");
    approvalList.innerHTML = "";
    return;
  }

  const primaryInstance = getPrimaryInstance(state.instances);
  approvalList.innerHTML = `
    ${renderApprovalProgress(primaryInstance)}
    <div class="approver-list">
      ${(primaryInstance.approvers || []).map((approver) => renderApproverRow(primaryInstance, approver)).join("")}
    </div>
  `;

  emptyEl.classList.add("hidden");
  approvalList.classList.remove("hidden");
}

function formatApproverLine(approver) {
  const email = String((approver && approver.email) || "").trim();
  const label = String((approver && approver.label) || "").trim();
  if (label && normalizeEmail(label) !== normalizeEmail(email)) {
    return label;
  }

  if (!email) {
    return "Approver";
  }

  return humanizeApproverNameFromEmail(email);
}

function humanizeApproverNameFromEmail(email) {
  const localPart = String(email || "").split("@")[0] || "";
  const normalized = localPart
    .replace(/[._+-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) {
    return "Approver";
  }

  return normalized
    .split(" ")
    .map((part) => {
      return part ? part.charAt(0).toUpperCase() + part.slice(1) : "";
    })
    .join(" ");
}

function sortInstances(instances) {
  return [...(Array.isArray(instances) ? instances : [])].sort((left, right) => {
    const leftPending = left && left.state === "pending" ? 1 : 0;
    const rightPending = right && right.state === "pending" ? 1 : 0;

    if (leftPending !== rightPending) {
      return rightPending - leftPending;
    }

    return Number(right.updated_at || 0) - Number(left.updated_at || 0);
  });
}

function getPrimaryInstance(instances) {
  const pendingInstance = (instances || []).find((instance) => instance.state === "pending");
  return pendingInstance || (instances || [])[0];
}

function getApprovalProgressMetrics(instance) {
  const approvers = Array.isArray(instance && instance.approvers) ? instance.approvers : [];
  const total = approvers.length;
  const approved = Number(instance && instance.approved_count) || approvers.filter((approver) => approver && approver.status === "approved").length;
  const rejected = Number(instance && instance.rejected_count) || approvers.filter((approver) => approver && approver.status === "rejected").length;
  const pending = Number(instance && instance.pending_count) || Math.max(total - approved - rejected, 0);
  const reviewed = approved + rejected;
  const percent = total ? Math.round((reviewed / total) * 100) : 0;

  return {
    total,
    approved,
    rejected,
    pending,
    reviewed,
    percent,
  };
}

function renderApprovalProgress(instance) {
  const metrics = getApprovalProgressMetrics(instance);
  let label = `${metrics.approved} of ${metrics.total} approved`;
  if (!metrics.total) {
    label = "No approvers assigned";
  } else if (metrics.rejected > 0) {
    label = `${metrics.reviewed} of ${metrics.total} reviewed`;
  } else if (metrics.approved === metrics.total) {
    label = `${metrics.total} of ${metrics.total} approved`;
  }

  let meta = "Waiting to start";
  if (metrics.total) {
    meta = `${metrics.pending} pending`;
    if (!metrics.pending && metrics.rejected > 0) {
      meta = `${metrics.rejected} rejected`;
    } else if (!metrics.pending) {
      meta = "Complete";
    }
  }

  return `
    <div class="approval-progress">
      <div class="approval-progress-top">
        <span class="approval-progress-label">${label}</span>
        <span class="approval-progress-meta">${meta}</span>
      </div>
      <div class="approval-progress-track" aria-hidden="true">
        <span class="approval-progress-fill" style="width:${metrics.percent}%"></span>
      </div>
    </div>
  `;
}

function getApproverStateMeta(value) {
  if (value === "approved") {
    return {
      label: "Approved",
      dotClass: "status-approved",
      pillClass: "pill-approved",
    };
  }

  if (value === "rejected") {
    return {
      label: "Rejected",
      dotClass: "status-rejected",
      pillClass: "pill-rejected",
    };
  }

  return {
    label: "Awaiting Reply",
    dotClass: "status-pending",
    pillClass: "pill-neutral",
  };
}

function renderApproverRow(instance, approver) {
  const statusMeta = getApproverStateMeta(approver.status);
  const approverLine = formatApproverLine(approver);
  const canAct = canLoggedInAgentAct(instance, approver, state.loggedInAgent);

  return `
    <div class="approver-row">
      <div class="approver-main">
        <span class="status-dot ${statusMeta.dotClass}"></span>
        <div class="approver-copy">
          <div class="approver-line" title="${escapeHtml(approverLine)}">${escapeHtml(approverLine)}</div>
        </div>
      </div>
      <div class="approver-actions">
        <span class="row-pill ${statusMeta.pillClass}">${escapeHtml(statusMeta.label)}</span>
        ${canAct ? renderActionButtons(instance, approver) : ""}
      </div>
    </div>
  `;
}

async function handleTicketFieldChanged(fieldId, event) {
  const eventData = await resolveEventData(event);
  const oldValue = normalizeTicketEventValue(fieldId, eventData && eventData.old);
  const newValue = normalizeTicketEventValue(fieldId, eventData && eventData.new);

  state.pendingFieldChanges[fieldId] = {
    field: fieldId,
    old: oldValue,
    new: newValue,
    captured_at: Date.now(),
  };
}

async function handleTicketPropertiesUpdated(event) {
  const eventData = await resolveEventData(event);
  const syntheticChanges = buildSyntheticChangesPayload();

  void startPostUpdateProbe(eventData, syntheticChanges);
}

async function startPostUpdateProbe(eventData, syntheticChanges) {
  state.postUpdateProbeToken += 1;
  state.postUpdateRefreshActive = true;
  const probeToken = state.postUpdateProbeToken;
  const baselineSignature = buildInstanceSignature(state.instances);

  try {
    for (let attempt = 1; attempt <= POST_UPDATE_REFRESH_ATTEMPTS; attempt += 1) {
      if (probeToken !== state.postUpdateProbeToken) {
        return;
      }

      await loadSidebar({ silent: true, keepMessage: true });
      const currentSignature = buildInstanceSignature(state.instances);

      if (currentSignature && currentSignature !== baselineSignature) {
        clearPendingFieldChanges();
        return;
      }

      if (
        attempt === POST_UPDATE_FALLBACK_ATTEMPT &&
        shouldInvokeFallbackTrigger(syntheticChanges, eventData)
      ) {
        await invokeFallbackTriggerEvaluation(syntheticChanges, eventData);
        await loadSidebar({ silent: true, keepMessage: true });

        const afterFallbackSignature = buildInstanceSignature(state.instances);
        if (afterFallbackSignature && afterFallbackSignature !== baselineSignature) {
          clearPendingFieldChanges();
          return;
        }
      }

      if (attempt < POST_UPDATE_REFRESH_ATTEMPTS) {
        await delay(POST_UPDATE_REFRESH_MS);
      }
    }
    clearPendingFieldChanges();
  } finally {
    if (probeToken === state.postUpdateProbeToken) {
      state.postUpdateRefreshActive = false;
    }
  }
}

async function invokeFallbackTriggerEvaluation(syntheticChanges, eventData) {
  try {
    let ticket = buildFallbackTicketPayload(await getCurrentTicket());

    const response = await invokeWithTimeout("evaluateTicketApprovalTrigger", {
      source: "sidebar_properties_updated_fallback",
      ticket,
      changes: syntheticChanges,
      event_data: eventData,
    });
    const payload = parseInvokeResponse(response);

    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Fallback trigger evaluation failed.");
    }
  } catch (error) {
    console.error("Failed to invoke fallback trigger evaluation:", error);
  }
}

function buildSyntheticChangesPayload() {
  const payload = {};
  const fieldKeyMap = {
    status: "status",
    priority: "priority",
    group: "group_id",
    agent: "responder_id",
    ticket_type: "type",
  };

  Object.keys(state.pendingFieldChanges).forEach((fieldId) => {
    const change = state.pendingFieldChanges[fieldId];
    const changeKey = fieldKeyMap[fieldId];
    if (!changeKey) {
      return;
    }

    payload[changeKey] = [change.old, change.new];
  });

  return payload;
}

function extractLoggedInAgent(result) {
  const rawUser = result && result.loggedInUser ? result.loggedInUser : result;
  const contact = rawUser && rawUser.contact && typeof rawUser.contact === "object" ? rawUser.contact : {};
  return {
    id: Number(rawUser && rawUser.id) || 0,
    email: normalizeEmail(contact.email || rawUser && rawUser.email),
    name: String(contact.name || rawUser && rawUser.name || "").trim(),
  };
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function canLoggedInAgentAct(instance, approver, agent) {
  return Boolean(
    instance &&
    approver &&
    instance.state === "pending" &&
    approver.status === "pending" &&
    normalizeEmail(approver.email) &&
    normalizeEmail(approver.email) === normalizeEmail(agent && agent.email)
  );
}

function renderActionButtons(instance, approver) {
  const approveKey = buildActionKey(instance, approver, "approved");
  const rejectKey = buildActionKey(instance, approver, "rejected");
  const actionPending = Boolean(state.actionInFlight);

  return `
    <button
      class="btn btn-primary btn-compact"
      type="button"
      data-approval-action="approved"
      data-instance-id="${escapeHtml(instance.id)}"
      data-approver-email="${escapeHtml(approver.email)}"
      ${actionPending ? "disabled" : ""}
    >
      ${state.actionInFlight === approveKey ? "Approving..." : "Approve"}
    </button>
    <button
      class="btn btn-danger btn-compact"
      type="button"
      data-approval-action="rejected"
      data-instance-id="${escapeHtml(instance.id)}"
      data-approver-email="${escapeHtml(approver.email)}"
      ${actionPending ? "disabled" : ""}
    >
      ${state.actionInFlight === rejectKey ? "Rejecting..." : "Reject"}
    </button>
  `;
}

function buildActionKey(instance, approver, decision) {
  return [
    String(instance && instance.id || ""),
    String(approver && approver.email || "").toLowerCase(),
    String(decision || ""),
  ].join("::");
}

async function handleSummaryActionClick(event) {
  const button = event.target.closest("[data-approval-action]");
  if (!button) {
    return;
  }

  const decision = button.getAttribute("data-approval-action");
  const instanceId = button.getAttribute("data-instance-id");
  const approverEmail = button.getAttribute("data-approver-email");
  const primaryInstance = getPrimaryInstance(state.instances);
  if (!primaryInstance || !decision || !instanceId) {
    return;
  }

  const approver = (primaryInstance.approvers || []).find((item) => {
    return normalizeEmail(item && item.email) === normalizeEmail(approverEmail);
  });
  if (!approver || !canLoggedInAgentAct(primaryInstance, approver, state.loggedInAgent)) {
    setMessage("Only the assigned pending approver can take action from the sidebar.", "error");
    render();
    return;
  }

  const actionKey = buildActionKey(primaryInstance, approver, decision);
  state.actionInFlight = actionKey;
  clearMessage();
  render();

  try {
    const response = await invokeWithTimeout("submitSidebarApprovalDecision", {
      ticket_id: state.ticketId,
      instance_id: instanceId,
      decision,
      agent_email: state.loggedInAgent.email,
      agent_name: state.loggedInAgent.name,
      agent_id: state.loggedInAgent.id,
    });
    const payload = parseInvokeResponse(response);

    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Failed to record the approval decision.");
    }

    setMessage(decision === "approved" ? "Approval recorded." : "Rejection recorded.", "info");
    await loadSidebar({ silent: true, keepMessage: true });
  } catch (error) {
    console.error("Failed to record sidebar approval action:", error);
    setMessage(resolveErrorMessage(error, "Unable to record the approval decision."), "error");
    render();
  } finally {
    state.actionInFlight = "";
    render();
  }
}

function buildInstanceSignature(instances) {
  return (Array.isArray(instances) ? instances : [])
    .map((instance) => `${instance.id}:${instance.updated_at}`)
    .join("|");
}

function shouldPreserveCurrentInstances(nextInstances, options) {
  return Boolean(
    options &&
    options.silent &&
    state.postUpdateRefreshActive &&
    state.instances.length &&
    !nextInstances.length
  );
}

function shouldInvokeFallbackTrigger(syntheticChanges, eventData) {
  return Boolean(
    Object.keys(syntheticChanges || {}).length ||
    Object.keys(eventData || {}).length
  );
}

function clearPendingFieldChanges() {
  state.pendingFieldChanges = {};
}

async function getCurrentTicket() {
  const result = await client.data.get("ticket");
  return result && result.ticket ? result.ticket : result;
}

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function humanizeFieldName(value) {
  return normalizeText(value)
    .replace(/^cf_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function collectOptionRecords(input, bucket) {
  if (input === null || input === undefined) {
    return;
  }

  if (Array.isArray(input)) {
    input.forEach((item) => collectOptionRecords(item, bucket));
    return;
  }

  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    const value = normalizeText(input);
    if (value) {
      bucket.push({ value, label: value });
    }
    return;
  }

  if (typeof input !== "object") {
    return;
  }

  const directValue = normalizeText(
    input.value !== undefined && input.value !== null
      ? input.value
      : input.id
  );
  const directLabel = normalizeText(
    input.label !== undefined && input.label !== null
      ? input.label
      : input.name !== undefined && input.name !== null
        ? input.name
        : input.text !== undefined && input.text !== null
          ? input.text
          : input.display_name !== undefined && input.display_name !== null
            ? input.display_name
            : input.displayName
  );

  if (directValue || directLabel) {
    const value = directValue || directLabel;
    const label = directLabel || directValue;
    if (value && label) {
      bucket.push({ value, label });
    }
  }

  Object.keys(input).forEach((key) => {
    const value = input[key];
    const normalizedKey = normalizeText(key);

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      const normalizedValue = normalizeText(value);
      if (normalizedKey && normalizedValue) {
        bucket.push({ value: normalizedKey, label: normalizedValue });
      }
      return;
    }

    if (value && typeof value === "object") {
      const nestedBucket = [];
      collectOptionRecords(value, nestedBucket);
      if (nestedBucket.length) {
        bucket.push(...nestedBucket);
        return;
      }

      if (normalizedKey) {
        bucket.push({ value: normalizedKey, label: normalizedKey });
      }
    }
  });
}

function dedupeOptionRecords(options) {
  const unique = [];
  const seen = new Set();

  (Array.isArray(options) ? options : []).forEach((option) => {
    const value = normalizeText(option && option.value);
    const label = normalizeText(option && option.label) || value;
    const key = `${value.toLowerCase()}::${label.toLowerCase()}`;
    if (!value || !label || seen.has(key)) {
      return;
    }

    seen.add(key);
    unique.push({ value, label });
  });

  return unique;
}

function extractLiveOptions(input) {
  const options = [];
  collectOptionRecords(input, options);
  return dedupeOptionRecords(options);
}

function getTicketCustomFieldKeys(ticket) {
  const customFields = ticket && typeof ticket === "object"
    ? (ticket.custom_fields || ticket.customFields || {})
    : {};
  return Object.keys(customFields).filter((key) => key && key.startsWith("cf_"));
}

function buildLiveFieldSyncSignature(ticket) {
  const sourceTicket = ticket && typeof ticket === "object" ? ticket : {};
  return [
    normalizeText(sourceTicket.id),
    ...getTicketCustomFieldKeys(sourceTicket).sort(),
  ].join("|");
}

function buildLiveOptionObjectNames(fieldName) {
  if (fieldName === "ticket_type") {
    return ["ticket_type_options", "type_options"];
  }

  return [`${fieldName}_options`];
}

async function fetchLiveFieldOptions(fieldName) {
  const objectNames = buildLiveOptionObjectNames(fieldName);

  for (const objectName of objectNames) {
    try {
      const response = await client.data.get(objectName);
      const rawOptions = response && Object.prototype.hasOwnProperty.call(response, objectName)
        ? response[objectName]
        : response;
      const options = extractLiveOptions(rawOptions);
      if (options.length) {
        return options;
      }
    } catch {
      // Some ticket fields do not expose a matching *_options object in the sidebar runtime.
    }
  }

  return [];
}

async function buildLiveFieldMetadata(ticket) {
  const candidateFieldNames = Array.from(new Set([
    "status",
    "priority",
    "ticket_type",
    ...getTicketCustomFieldKeys(ticket),
  ]));

  const liveFields = [];
  for (const fieldName of candidateFieldNames) {
    const options = await fetchLiveFieldOptions(fieldName);
    if (!options.length && !fieldName.startsWith("cf_")) {
      continue;
    }

    liveFields.push({
      id: fieldName,
      name: fieldName,
      label: fieldName === "ticket_type" ? "Type" : humanizeFieldName(fieldName),
      type: fieldName.startsWith("cf_")
        ? (options.length ? "custom_dropdown" : "custom_field")
        : "dropdown",
      element_id: fieldName,
      options,
      source: "ticket_sidebar_live",
      updated_at: Date.now(),
    });
  }

  return liveFields;
}

async function syncLiveTicketFieldMetadata(options) {
  const ticket = state.currentTicket || await getCurrentTicket();
  const signature = buildLiveFieldSyncSignature(ticket);
  if (!signature) {
    return;
  }

  if (!options || !options.force) {
    if (signature === state.lastLiveFieldSyncSignature) {
      return;
    }
  }

  try {
    const fields = await buildLiveFieldMetadata(ticket);
    const response = await invokeWithTimeout("syncLiveTicketFieldMetadata", {
      ticket_id: state.ticketId,
      fields,
    });
    const payload = parseInvokeResponse(response);
    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to sync live field metadata.");
    }

    state.lastLiveFieldSyncSignature = signature;
  } catch (error) {
    console.error("Failed to sync live ticket field metadata:", error);
  }
}

function buildFallbackTicketPayload(ticket) {
  const sourceTicket = ticket && typeof ticket === "object" ? ticket : {};
  return {
    id: sourceTicket.id,
    subject: sourceTicket.subject,
    status: sourceTicket.status,
    priority: sourceTicket.priority,
    type: sourceTicket.type,
    ticket_type: sourceTicket.ticket_type,
    group_id: sourceTicket.group_id,
    responder_id: sourceTicket.responder_id,
    source: sourceTicket.source,
    custom_fields: clonePlainObject(sourceTicket.custom_fields || sourceTicket.customFields),
    changes: clonePlainObject(sourceTicket.changes),
  };
}

function buildCreateFallbackChanges(ticket) {
  const sourceTicket = ticket && typeof ticket === "object" ? ticket : {};
  const changes = {};

  if (normalizeText(sourceTicket.status)) {
    changes.status = ["", normalizeText(sourceTicket.status)];
  }

  if (normalizeText(sourceTicket.priority)) {
    changes.priority = ["", normalizeText(sourceTicket.priority)];
  }

  if (normalizeText(sourceTicket.type || sourceTicket.ticket_type)) {
    changes.type = ["", normalizeText(sourceTicket.type || sourceTicket.ticket_type)];
  }

  if (normalizeText(sourceTicket.group_id)) {
    changes.group_id = ["", normalizeText(sourceTicket.group_id)];
  }

  if (normalizeText(sourceTicket.responder_id)) {
    changes.responder_id = ["", normalizeText(sourceTicket.responder_id)];
  }

  if (normalizeText(sourceTicket.source)) {
    changes.source = ["", normalizeText(sourceTicket.source)];
  }

  const customFields = sourceTicket.custom_fields || sourceTicket.customFields || {};
  const customChanges = {};
  Object.keys(customFields).forEach((key) => {
    const value = normalizeTicketEventValue(key, customFields[key]);
    if (!value) {
      return;
    }

    customChanges[key] = ["", value];
  });

  if (Object.keys(customChanges).length) {
    changes.custom_fields = customChanges;
  }

  return changes;
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return JSON.parse(JSON.stringify(value));
}

async function resolveEventData(event) {
  if (!event || !event.helper || typeof event.helper.getData !== "function") {
    return {};
  }

  try {
    return await Promise.resolve(event.helper.getData());
  } catch {
    return {};
  }
}

function normalizeTicketEventValue(fieldId, value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (Array.isArray(value)) {
    return value.length ? normalizeTicketEventValue(fieldId, value[0]) : "";
  }

  if (typeof value === "object") {
    if (fieldId === "group" || fieldId === "agent") {
      return normalizeTicketEventValue(fieldId, value.id || value.value || value.name || value.label);
    }

    return normalizeTicketEventValue(
      fieldId,
      value.value || value.id || value.name || value.label || value.text
    );
  }

  return String(value).trim();
}

function delay(ms) {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

function invokeWithTimeout(functionName, payload) {
  return Promise.race([
    client.request.invoke(functionName, payload || {}),
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error("Request timed out.")), INVOKE_TIMEOUT_MS);
    }),
  ]);
}

function parseInvokeResponse(response) {
  if (response === null || response === undefined) {
    return null;
  }

  if (typeof response === "string") {
    try {
      return JSON.parse(response);
    } catch {
      return response;
    }
  }

  if (response && typeof response === "object" && Object.prototype.hasOwnProperty.call(response, "response")) {
    try {
      return JSON.parse(response.response || "null");
    } catch {
      return response.response;
    }
  }

  return response;
}

function resolveInvokeError(payload) {
  if (!payload) {
    return "";
  }

  return payload.detail || payload.message || "";
}

function resolveErrorMessage(error, fallback) {
  if (!error) {
    return fallback;
  }

  if (typeof error === "string") {
    return error;
  }

  return error.message || fallback;
}

function setMessage(text, type) {
  state.message = { text, type };
}

function clearMessage() {
  state.message = { text: "", type: "" };
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
