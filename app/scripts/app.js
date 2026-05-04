let client;
const INVOKE_TIMEOUT_MS = 15000;

const state = {
  loading: true,
  saving: false,
  modalOpen: false,
  rules: [],
  recentInstances: [],
  triggerFields: [],
  fieldCatalog: {},
  senderEmails: [],
  approverAgentOptions: [],
  helper: {
    email_placeholders: [],
  },
  pendingDeleteId: "",
  globalError: "",
  globalSuccess: "",
  formMessage: {
    type: "",
    text: "",
  },
  formErrors: {},
  form: createEmptyForm(),
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    client = await app.initialized();
    bindStaticEvents();
    client.events.on("app.activated", () => {
      void loadDashboard({ silent: true });
    });
    await loadDashboard();
  } catch (error) {
    console.error("Failed to initialize Approvals Automation Pro dashboard:", error);
    state.globalError = "Unable to initialize the dashboard.";
    render();
  }
}

function createEmptyForm() {
  return {
    id: "",
    name: "",
    active: true,
    statusValues: [],
    conditionOperator: "and",
    conditions: [],
    approvers: [],
    anyoneCanApprove: false,
    autoCloseAfterApproval: false,
    senderEmail: "",
    emailSubject: "Approval required for {{ticket_id}}",
    emailBody: [
      "Approval has been requested for ticket {{ticket_id}}.",
      "",
      "Subject: {{ticket_subject}}",
      "Current status: {{ticket_status}}",
      "",
      "Use the approval buttons in the email.",
    ].join("\n"),
  };
}

function bindStaticEvents() {
  document.getElementById("createRuleBtn").addEventListener("click", openCreateRuleModal);
  document.getElementById("refreshBtn").addEventListener("click", () => {
    void loadDashboard();
  });

  document.getElementById("resetFormBtn").addEventListener("click", () => {
    resetFormState({ preserveModal: true });
  });
  document.getElementById("cancelEditBtn").addEventListener("click", closeRuleModal);
  document.getElementById("addConditionBtn").addEventListener("click", addCondition);
  document.getElementById("addExternalEmailBtn").addEventListener("click", addExternalApproverFromInput);
  document.getElementById("externalEmailInput").addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      addExternalApproverFromInput();
    }
  });
  document.getElementById("externalEmailInput").addEventListener("input", () => {
    clearFieldError("approvers");
    renderFormErrors();
  });

  document.getElementById("ruleForm").addEventListener("submit", (event) => {
    event.preventDefault();
    void saveRule();
  });

  document.getElementById("ruleNameInput").addEventListener("input", (event) => {
    state.form.name = event.target.value;
    clearFieldError("name");
    renderFormErrors();
    renderPreview();
  });

  document.getElementById("ruleActiveInput").addEventListener("change", (event) => {
    state.form.active = Boolean(event.target.checked);
  });

  document.getElementById("statusValuesChecklist").addEventListener("change", handleStatusChecklistChange);

  document.querySelectorAll("[data-condition-operator]").forEach((button) => {
    button.addEventListener("click", () => {
      state.form.conditionOperator = button.getAttribute("data-condition-operator") === "or" ? "or" : "and";
      renderForm();
    });
  });

  document.getElementById("agentApproverChecklist").addEventListener("change", handleAgentApproverChecklistChange);

  document.getElementById("anyoneCanApproveInput").addEventListener("change", (event) => {
    state.form.anyoneCanApprove = Boolean(event.target.checked);
    renderPreview();
  });

  document.getElementById("autoCloseAfterApprovalInput").addEventListener("change", (event) => {
    state.form.autoCloseAfterApproval = Boolean(event.target.checked);
    renderPreview();
  });

  document.getElementById("senderEmailSelect").addEventListener("change", (event) => {
    state.form.senderEmail = event.target.value;
    clearFieldError("sender_email");
    renderFormErrors();
    renderPreview();
  });

  document.getElementById("emailSubjectInput").addEventListener("input", (event) => {
    state.form.emailSubject = event.target.value;
    clearFieldError("email_subject");
    renderFormErrors();
    renderPreview();
  });

  document.getElementById("emailBodyInput").addEventListener("input", (event) => {
    state.form.emailBody = event.target.value;
    clearFieldError("email_body");
    renderFormErrors();
    renderPreview();
  });

  document.getElementById("conditionsContainer").addEventListener("change", handleConditionChange);
  document.getElementById("conditionsContainer").addEventListener("click", handleConditionClick);
  document.getElementById("selectedApprovers").addEventListener("click", handleApproverChipClick);
  document.getElementById("rulesList").addEventListener("click", handleRuleAction);
  document.getElementById("ruleModal").addEventListener("click", (event) => {
    if (event.target.id === "ruleModal") {
      closeRuleModal();
    }
  });
}

function mergeTriggerFields(triggerFields, fieldCatalog) {
  const mergedById = new Map();

  [...(Array.isArray(triggerFields) ? triggerFields : []), ...Object.values(fieldCatalog || {})]
    .forEach((field) => {
      const fieldId = String((field && (field.id || field.name)) || "").trim();
      const fieldLabel = String((field && field.label) || "").trim();
      const filterKeys = [
        fieldId,
        fieldLabel,
        String((field && field.root_name) || "").trim(),
        String((field && field.root_label) || "").trim(),
        String((field && field.element_id) || "").trim(),
      ].map((value) => value.toLowerCase().replace(/[^a-z0-9]/g, ""));
      if (!fieldId) {
        return;
      }

      if (filterKeys.includes("sourceinfo") || filterKeys.includes("cfsourceinfo")) {
        return;
      }

      const normalizedId = fieldId.toLowerCase();
      const fieldType = String((field && field.type) || "").trim().toLowerCase();
      const allowEmptyOptions = normalizedId.startsWith("cf_") || fieldType.startsWith("custom_");
      const options = (Array.isArray(field && field.options) ? field.options : [])
        .map((option) => ({
          value: String((option && option.value) || "").trim(),
          label: String((option && (option.label || option.value)) || "").trim(),
        }))
        .filter((option) => option.value && option.label);

      if (!options.length && !allowEmptyOptions) {
        return;
      }

      const existing = mergedById.get(normalizedId);
      if (!existing) {
        mergedById.set(normalizedId, {
          id: fieldId,
          label: String((field && field.label) || fieldId).trim(),
          type: String((field && field.type) || "dropdown").trim(),
          options,
        });
        return;
      }

      const mergedOptions = new Map();
      [...existing.options, ...options].forEach((option) => {
        mergedOptions.set(`${option.value.toLowerCase()}::${option.label.toLowerCase()}`, option);
      });

      existing.label = existing.label || String((field && field.label) || fieldId).trim();
      existing.type = existing.type || String((field && field.type) || "dropdown").trim();
      existing.options = Array.from(mergedOptions.values());
    });

  return Array.from(mergedById.values())
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));
}

async function loadDashboard(options) {
  if (!options || !options.silent) {
    state.loading = true;
  }
  state.globalError = "";
  state.globalSuccess = options && options.keepSuccess ? state.globalSuccess : "";
  render();

  try {
    const response = await invokeWithTimeout("getApprovalDashboardData", {});
    const payload = parseInvokeResponse(response);

    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to load dashboard data.");
    }

    state.rules = Array.isArray(payload.rules) ? payload.rules : [];
    state.recentInstances = Array.isArray(payload.recent_instances) ? payload.recent_instances : [];
    state.fieldCatalog = payload.field_catalog && typeof payload.field_catalog === "object"
      ? payload.field_catalog
      : {};
    state.triggerFields = mergeTriggerFields(
      Array.isArray(payload.trigger_fields) ? payload.trigger_fields : [],
      state.fieldCatalog
    );
    state.senderEmails = Array.isArray(payload.sender_emails) ? payload.sender_emails : [];
    state.approverAgentOptions = Array.isArray(payload.approver_agent_options) ? payload.approver_agent_options : [];
    state.helper = payload.helper || { email_placeholders: [] };

    reconcileFormAfterLoad();
  } catch (error) {
    console.error("Failed to load dashboard data:", error);
    state.globalError = resolveErrorMessage(error, "Unable to load dashboard data.");
  } finally {
    state.loading = false;
    render();
  }
}

function reconcileFormAfterLoad() {
  if (state.form.id) {
    const latestRule = state.rules.find((rule) => rule.id === state.form.id);
    if (latestRule) {
      state.form = ruleToForm(latestRule);
      return;
    }

    state.form = createEmptyForm();
  }

  if (!state.form.senderEmail && state.senderEmails[0]) {
    state.form.senderEmail = state.senderEmails[0].value;
  }
}

function render() {
  renderHeroStats();
  renderGlobalMessages();
  renderRules();
  renderRecentActivity();
  renderForm();
}

function renderHeroStats() {
  const activeRules = state.rules.filter((rule) => rule.active !== false).length;
  const pendingApprovals = state.recentInstances.reduce((count, instance) => {
    return count + Number(instance.pending_count || 0);
  }, 0);

  document.getElementById("totalRulesValue").textContent = String(state.rules.length);
  document.getElementById("activeRulesValue").textContent = String(activeRules);
  document.getElementById("pendingApprovalsValue").textContent = String(pendingApprovals);
}

function renderGlobalMessages() {
  const errorEl = document.getElementById("globalError");
  const successEl = document.getElementById("globalSuccess");

  if (state.globalError) {
    errorEl.textContent = state.globalError;
    errorEl.classList.remove("hidden");
  } else {
    errorEl.textContent = "";
    errorEl.classList.add("hidden");
  }

  if (state.globalSuccess) {
    successEl.textContent = state.globalSuccess;
    successEl.classList.remove("hidden");
  } else {
    successEl.textContent = "";
    successEl.classList.add("hidden");
  }
}

function renderRules() {
  const loadingEl = document.getElementById("rulesLoading");
  const emptyEl = document.getElementById("rulesEmpty");
  const listEl = document.getElementById("rulesList");

  if (state.loading) {
    loadingEl.classList.remove("hidden");
    emptyEl.classList.add("hidden");
    listEl.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  loadingEl.classList.add("hidden");

  if (!state.rules.length) {
    emptyEl.classList.remove("hidden");
    listEl.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  emptyEl.classList.add("hidden");
  listEl.classList.remove("hidden");
  listEl.innerHTML = state.rules.map((rule) => renderRuleCard(rule)).join("");
}

function renderRuleCard(rule) {
  const deleteMode = state.pendingDeleteId === rule.id;
  const extraConditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  const approverEmails = (rule.approvers || []).map((approver) => approver.email).join(", ");
  const triggerSummary = buildTriggerSummary(rule);
  const ticketActionSummary = rule.auto_close_after_approval !== false
    ? "Closes the ticket after approval."
    : "Leaves the ticket status unchanged after approval.";
  const entryConditionSummary = extraConditions.length
    ? extraConditions.map(formatConditionLine).join(rule.condition_operator === "or" ? " OR " : " AND ")
    : "None";

  return `
    <article class="rule-card">
      <div class="rule-top">
        <div>
          <h3 class="rule-title">${escapeHtml(rule.name)}</h3>
          <div class="pill-row">
            <span class="pill ${rule.active !== false ? "pill-success" : ""}">${escapeHtml(rule.active !== false ? "Active" : "Paused")}</span>
            <span class="pill">${escapeHtml(rule.summary.status_text)}</span>
            <span class="pill ${Number(rule.pending_request_count || 0) ? "pill-warning" : ""}">${escapeHtml(`${rule.pending_request_count || 0} pending request${Number(rule.pending_request_count || 0) === 1 ? "" : "s"}`)}</span>
          </div>
        </div>
        <div class="rule-meta">Updated ${escapeHtml(formatDate(rule.updated_at_iso || rule.updated_at))}</div>
      </div>

      <div class="rule-body">
        <section class="rule-section">
          <strong>Trigger</strong>
          <p>${escapeHtml(triggerSummary)}</p>
        </section>
        <section class="rule-section">
          <strong>Ticket Action</strong>
          <p>${escapeHtml(ticketActionSummary)}</p>
        </section>
        <section class="rule-section">
          <strong>Approvers</strong>
          <p>${escapeHtml(approverEmails || "No approvers configured.")}</p>
        </section>
        <section class="rule-section">
          <strong>Entry Conditions</strong>
          <p>${escapeHtml(entryConditionSummary)}</p>
        </section>
        <section class="rule-section">
          <strong>Email</strong>
          <p>${escapeHtml(`${rule.summary.approval_mode_text}. Sent from ${rule.sender_email}.`)}</p>
        </section>
      </div>

      <div class="rule-actions" style="margin-top:18px;">
        <div class="inline-actions">
          <button class="btn btn-secondary" type="button" data-action="edit-rule" data-id="${escapeHtml(rule.id)}">Edit</button>
          <button class="btn ${rule.active !== false ? "btn-secondary" : "btn-primary"}" type="button" data-action="toggle-rule" data-id="${escapeHtml(rule.id)}">${escapeHtml(rule.active !== false ? "Pause Rule" : "Enable Rule")}</button>
        </div>
        <div class="inline-actions">
          ${
            deleteMode
              ? `
                <button class="btn btn-danger" type="button" data-action="confirm-delete-rule" data-id="${escapeHtml(rule.id)}">Confirm Delete</button>
                <button class="btn btn-secondary" type="button" data-action="cancel-delete-rule" data-id="${escapeHtml(rule.id)}">Cancel</button>
              `
              : `<button class="btn btn-danger" type="button" data-action="delete-rule" data-id="${escapeHtml(rule.id)}">Delete</button>`
          }
        </div>
      </div>
    </article>
  `;
}

function renderRecentActivity() {
  const emptyEl = document.getElementById("recentActivityEmpty");
  const listEl = document.getElementById("recentActivityList");

  if (!state.recentInstances.length) {
    emptyEl.classList.remove("hidden");
    listEl.classList.add("hidden");
    listEl.innerHTML = "";
    return;
  }

  emptyEl.classList.add("hidden");
  listEl.classList.remove("hidden");
  listEl.innerHTML = state.recentInstances.slice(0, 8).map((instance) => {
    const stateMeta = getInstanceStateMeta(instance.state);
    const ticketLabel = `#${String(instance.ticket_id)}`;
    const ticketMarkup = instance.ticket_url
      ? `<a class="ticket-link" href="${escapeAttribute(instance.ticket_url)}" target="_blank" rel="noreferrer">${escapeHtml(ticketLabel)}</a>`
      : escapeHtml(ticketLabel);
    return `
      <article class="activity-item">
        <div class="activity-top">
          <div>
            <strong>${escapeHtml(instance.rule_name)} on ticket ${ticketMarkup}</strong>
            <div class="activity-meta">Last updated ${escapeHtml(formatDate(instance.updated_at_iso || instance.updated_at))}.</div>
          </div>
          <span class="pill ${stateMeta.pillClass}">${escapeHtml(stateMeta.label)}</span>
        </div>
        <p class="activity-copy">${escapeHtml(`${instance.approved_count || 0} approved, ${instance.pending_count || 0} pending, ${instance.rejected_count || 0} rejected. ${getAutoCloseSummary(instance)}`)}</p>
      </article>
    `;
  }).join("");
}

function getInstanceStateMeta(value) {
  if (value === "approved") {
    return {
      label: "Approved",
      pillClass: "pill-success",
    };
  }

  if (value === "rejected") {
    return {
      label: "Rejected",
      pillClass: "pill-danger",
    };
  }

  return {
    label: "Pending",
    pillClass: "pill-warning",
  };
}

function renderForm() {
  const modal = document.getElementById("ruleModal");
  modal.classList.toggle("visible", state.modalOpen);
  modal.setAttribute("aria-hidden", state.modalOpen ? "false" : "true");
  document.body.classList.toggle("rule-modal-open", state.modalOpen);

  document.getElementById("formTitle").textContent = state.form.id ? "Edit Rule" : "Create Rule";
  document.getElementById("formCopy").textContent = state.form.id
    ? "Update statuses, approvers, and email settings."
    : "Choose statuses, approvers, and email settings.";

  const messageEl = document.getElementById("formMessage");
  if (state.formMessage.text) {
    messageEl.textContent = state.formMessage.text;
    messageEl.className = `banner ${state.formMessage.type === "error" ? "banner-error" : "banner-success"}`;
    messageEl.classList.remove("hidden");
  } else {
    messageEl.textContent = "";
    messageEl.className = "banner hidden";
  }

  document.getElementById("ruleNameInput").value = state.form.name;
  document.getElementById("ruleActiveInput").checked = state.form.active !== false;
  document.getElementById("operatorAndBtn").classList.toggle("active", state.form.conditionOperator !== "or");
  document.getElementById("operatorAndBtn").setAttribute("aria-pressed", state.form.conditionOperator !== "or" ? "true" : "false");
  document.getElementById("operatorOrBtn").classList.toggle("active", state.form.conditionOperator === "or");
  document.getElementById("operatorOrBtn").setAttribute("aria-pressed", state.form.conditionOperator === "or" ? "true" : "false");
  document.getElementById("anyoneCanApproveInput").checked = Boolean(state.form.anyoneCanApprove);
  document.getElementById("autoCloseAfterApprovalInput").checked = Boolean(state.form.autoCloseAfterApproval);
  document.getElementById("emailSubjectInput").value = state.form.emailSubject;
  document.getElementById("emailBodyInput").value = state.form.emailBody;
  document.getElementById("saveRuleBtn").disabled = state.saving || state.loading;
  document.getElementById("saveRuleBtn").textContent = state.saving ? "Saving..." : (state.form.id ? "Save Changes" : "Save Rule");

  renderStatusOptions();
  renderConditionRows();
  renderAgentApproverOptions();
  renderApproverChips();
  renderSenderEmailOptions();
  renderPreview();
  renderPlaceholderText();
  renderFormErrors();
}

function renderStatusOptions() {
  const container = document.getElementById("statusValuesChecklist");
  const statusField = state.triggerFields.find((field) => field.id === "status");
  const options = Array.isArray(statusField && statusField.options) ? statusField.options : [];

  if (!options.length) {
    container.innerHTML = '<div class="selection-empty">No Freshdesk statuses were returned yet. Refresh the dashboard and try again.</div>';
    return;
  }

  const selectedValues = new Set(state.form.statusValues);
  container.innerHTML = options.map((option) => `
    <label class="checkbox-card">
      <input type="checkbox" data-status-value="${escapeAttribute(option.value)}" ${selectedValues.has(option.value) ? "checked" : ""}>
      <span>${escapeHtml(option.label)}</span>
    </label>
  `).join("");
}

function renderConditionRows() {
  const container = document.getElementById("conditionsContainer");
  if (!state.form.conditions.length) {
    container.innerHTML = '<div class="state">No entry conditions added. This rule will run from the watched statuses.</div>';
    return;
  }

  container.innerHTML = state.form.conditions.map((condition, index) => {
    const conditionFields = getConditionFieldChoices(condition.field);
    const fieldMeta = state.triggerFields.find((field) => field.id === condition.field);
    const options = Array.isArray(fieldMeta && fieldMeta.options) ? fieldMeta.options : [];
    const selectedValues = Array.isArray(condition.values) ? condition.values : [];

    return `
      <section class="condition-card">
        <div class="condition-header">
          <div>
            <h5>Entry Condition ${index + 1}</h5>
            <p class="selection-copy">Choose a field and one or more matching values.</p>
          </div>
        </div>
        <div class="condition-row-grid">
          <div class="field">
            <label>Field</label>
            <select class="select condition-field-select" data-index="${index}">
              <option value="">Choose a field</option>
              ${conditionFields.map((field) => `
                <option value="${escapeAttribute(field.id)}" ${field.id === condition.field ? "selected" : ""}>${escapeHtml(field.label)}</option>
              `).join("")}
            </select>
          </div>
          <div class="field">
            <label>Matching values</label>
            ${
              options.length
                ? `
                  <div class="checkbox-grid">
                    ${options.map((option) => `
                      <label class="checkbox-card">
                        <input
                          type="checkbox"
                          class="condition-value-checkbox"
                          data-index="${index}"
                          data-value="${escapeAttribute(option.value)}"
                          ${selectedValues.includes(option.value) ? "checked" : ""}
                        >
                        <span>${escapeHtml(option.label)}</span>
                      </label>
                    `).join("")}
                  </div>
                `
                : condition.field
                  ? `
                      <input
                        type="text"
                        class="input condition-value-text"
                        data-index="${index}"
                        placeholder="Enter one or more exact values, separated by commas"
                        value="${escapeAttribute(selectedValues.join(", "))}"
                      >
                      <div class="helper">Use exact values. Separate multiple values with commas.</div>
                    `
                  : '<div class="selection-empty">Select a field first to load its matching values.</div>'
            }
          </div>
        </div>
        <div class="condition-actions">
          <button class="btn btn-danger remove-condition-btn" type="button" data-index="${index}">Remove</button>
        </div>
      </section>
    `;
  }).join("");
}

function renderAgentApproverOptions() {
  const container = document.getElementById("agentApproverChecklist");
  const selectedAgentEmails = new Set(
    state.form.approvers
      .filter((approver) => approver.type === "agent")
      .map((approver) => normalizeEmail(approver.email))
  );

  if (!state.approverAgentOptions.length) {
    container.innerHTML = '<div class="selection-empty">No agent emails are available in this account yet.</div>';
    return;
  }

  container.innerHTML = state.approverAgentOptions.map((option) => `
    <label class="checkbox-card">
      <input type="checkbox" data-approver-email="${escapeAttribute(option.value)}" ${selectedAgentEmails.has(normalizeEmail(option.value)) ? "checked" : ""}>
      <span>${escapeHtml(option.label)}</span>
    </label>
  `).join("");
}

function renderApproverChips() {
  const container = document.getElementById("selectedApprovers");
  if (!state.form.approvers.length) {
    container.innerHTML = '<span class="helper">No approvers selected yet.</span>';
    return;
  }

  container.innerHTML = state.form.approvers.map((approver) => `
    <span class="chip">
      <span>${escapeHtml(`${approver.label} (${approver.type === "agent" ? "Agent" : "External"})`)}</span>
      <button type="button" data-email="${escapeAttribute(approver.email)}" aria-label="Remove approver">&times;</button>
    </span>
  `).join("");
}

function renderSenderEmailOptions() {
  const select = document.getElementById("senderEmailSelect");
  if (!state.senderEmails.length) {
    select.innerHTML = '<option value="">No sender mailboxes available</option>';
    return;
  }

  const selected = state.form.senderEmail || state.senderEmails[0].value;
  if (!state.form.senderEmail) {
    state.form.senderEmail = selected;
  }

  select.innerHTML = state.senderEmails.map((option) => `
    <option value="${escapeAttribute(option.value)}" ${option.value === selected ? "selected" : ""}>${escapeHtml(option.label)}</option>
  `).join("");
}

function renderPlaceholderText() {
  const text = (state.helper.email_placeholders || []).join(", ");
  document.getElementById("placeholderInlineText").textContent = text || "No placeholders available";
}

function renderPreview() {
  const statusField = state.triggerFields.find((field) => field.id === "status");
  const statusLookup = buildOptionLookup(statusField && statusField.options);
  const statusLabels = state.form.statusValues.map((value) => statusLookup[value] || value);
  const watchedStatusText = statusLabels.length ? statusLabels.join(", ") : "None selected";
  const entryConditionText = state.form.conditions.length
    ? state.form.conditions.map(formatConditionLine).join(state.form.conditionOperator === "or" ? " OR " : " AND ")
    : "None";
  const preview = [
    `Name: ${state.form.name || "Untitled approval rule"}`,
    `Watched statuses: ${watchedStatusText}`,
    `Entry conditions: ${entryConditionText}`,
    `Approvers: ${state.form.approvers.length ? state.form.approvers.map((approver) => approver.email).join(", ") : "None selected"}`,
    `Approval mode: ${state.form.anyoneCanApprove ? "Anyone can approve" : "Everyone must approve"}`,
    `After approval: ${state.form.autoCloseAfterApproval ? "Close the ticket" : "Leave the current status"}`,
    `From: ${state.form.senderEmail || "None selected"}`,
    "",
    `Subject: ${renderTemplatePreview(state.form.emailSubject || "Approval required for {{ticket_id}}")}`,
    "",
    renderTemplatePreview(state.form.emailBody || ""),
  ].join("\n");

  document.getElementById("rulePreviewText").textContent = preview;
}

function addCondition() {
  state.form.conditions.push({
    field: "",
    values: [],
  });
  clearFieldError("conditions");
  renderForm();
}

function handleStatusChecklistChange(event) {
  const checkbox = event.target.closest("input[data-status-value]");
  if (!checkbox) {
    return;
  }

  state.form.statusValues = Array.from(
    document.querySelectorAll("#statusValuesChecklist input[data-status-value]:checked")
  ).map((input) => input.getAttribute("data-status-value"));
  clearFieldError("status_values");
  renderFormErrors();
  renderPreview();
}

function handleConditionChange(event) {
  const index = Number(event.target.getAttribute("data-index"));
  if (Number.isNaN(index) || !state.form.conditions[index]) {
    return;
  }

  if (event.target.classList.contains("condition-field-select")) {
    state.form.conditions[index] = {
      field: event.target.value,
      values: [],
    };
    clearFieldError("conditions");
    renderForm();
    return;
  }

  if (event.target.classList.contains("condition-value-checkbox")) {
    state.form.conditions[index].values = updateStringSelection(
      state.form.conditions[index].values,
      event.target.getAttribute("data-value"),
      Boolean(event.target.checked)
    );
    clearFieldError("conditions");
    renderFormErrors();
    renderPreview();
    return;
  }

  if (event.target.classList.contains("condition-value-text")) {
    state.form.conditions[index].values = String(event.target.value || "")
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean);
    clearFieldError("conditions");
    renderFormErrors();
    renderPreview();
  }
}

function handleConditionClick(event) {
  const button = event.target.closest(".remove-condition-btn");
  if (!button) {
    return;
  }

  const index = Number(button.getAttribute("data-index"));
  if (Number.isNaN(index)) {
    return;
  }

  state.form.conditions.splice(index, 1);
  clearFieldError("conditions");
  renderForm();
}

function handleApproverChipClick(event) {
  const button = event.target.closest("button[data-email]");
  if (!button) {
    return;
  }

  const email = button.getAttribute("data-email");
  state.form.approvers = state.form.approvers.filter((approver) => normalizeEmail(approver.email) !== normalizeEmail(email));
  clearFieldError("approvers");
  renderForm();
}

function addExternalApproverFromInput() {
  const input = document.getElementById("externalEmailInput");
  const email = input.value.trim();

  if (!isValidEmail(email)) {
    setFieldError("approvers", "Enter a valid approver email address.");
    renderFormErrors();
    scrollToFirstFormError(["approvers"]);
    return;
  }

  state.form.approvers = dedupeApprovers([
    ...state.form.approvers,
    {
      email,
      label: email,
      type: "external",
    },
  ]);
  input.value = "";
  clearFieldError("approvers");
  renderForm();
}

function handleAgentApproverChecklistChange(event) {
  const checkbox = event.target.closest("input[data-approver-email]");
  if (!checkbox) {
    return;
  }

  const selectedEmails = Array.from(
    document.querySelectorAll("#agentApproverChecklist input[data-approver-email]:checked")
  ).map((input) => input.getAttribute("data-approver-email"));
  syncSelectedAgentApprovers(selectedEmails);
}

function syncSelectedAgentApprovers(selectedEmails) {
  const selectedSet = new Set(selectedEmails.map(normalizeEmail));
  const externalApprovers = state.form.approvers.filter((approver) => approver.type !== "agent");
  const lookup = Object.fromEntries(
    state.approverAgentOptions.map((option) => [
      normalizeEmail(option.value),
      {
        email: option.value,
        label: option.label,
        type: "agent",
      },
    ])
  );

  const selectedAgents = Array.from(selectedSet)
    .map((email) => lookup[email])
    .filter(Boolean);

  state.form.approvers = dedupeApprovers([...selectedAgents, ...externalApprovers]);
  clearFieldError("approvers");
  renderForm();
}

function handleRuleAction(event) {
  const button = event.target.closest("[data-action]");
  if (!button) {
    return;
  }

  const action = button.getAttribute("data-action");
  const ruleId = button.getAttribute("data-id");
  const rule = state.rules.find((item) => item.id === ruleId);

  if (!rule && action !== "cancel-delete-rule") {
    return;
  }

  if (action === "edit-rule") {
    openEditRuleModal(rule);
    return;
  }

  if (action === "toggle-rule") {
    void toggleRule(rule);
    return;
  }

  if (action === "delete-rule") {
    state.pendingDeleteId = ruleId;
    renderRules();
    return;
  }

  if (action === "cancel-delete-rule") {
    state.pendingDeleteId = "";
    renderRules();
    return;
  }

  if (action === "confirm-delete-rule") {
    void deleteRule(rule);
  }
}

async function saveRule() {
  if (state.saving) {
    return;
  }

  clearFormMessage();
  clearFormErrors();
  state.globalSuccess = "";

  const payload = formToPayload();
  const validationErrors = validatePayload(payload);
  if (hasFormErrors(validationErrors)) {
    setFormErrors(validationErrors);
    render();
    scrollToFirstFormError();
    return;
  }

  state.saving = true;
  renderForm();

  try {
    const response = await invokeWithTimeout("saveApprovalRule", payload);
    const result = parseInvokeResponse(response);

    if (!result || result.success === false) {
      throw new Error(resolveInvokeError(result) || "Unable to save the rule.");
    }

    state.globalSuccess = payload.id ? "Rule updated successfully." : "Rule created successfully.";
    resetFormState();
    await loadDashboard({ silent: true, keepSuccess: true });
  } catch (error) {
    console.error("Failed to save rule:", error);
    setFormMessage(resolveErrorMessage(error, "Unable to save the rule."), "error");
    render();
  } finally {
    state.saving = false;
    renderForm();
  }
}

async function toggleRule(rule) {
  try {
    const payload = {
      id: rule.id,
      active: rule.active === false,
    };
    const response = await invokeWithTimeout("saveApprovalRule", payload);
    const result = parseInvokeResponse(response);

    if (!result || result.success === false) {
      throw new Error(resolveInvokeError(result) || "Unable to update the rule.");
    }

    state.globalSuccess = rule.active !== false ? "Rule paused." : "Rule enabled.";
    await loadDashboard({ silent: true, keepSuccess: true });
  } catch (error) {
    console.error("Failed to toggle rule:", error);
    state.globalError = resolveErrorMessage(error, "Unable to update the rule.");
    render();
  }
}

async function deleteRule(rule) {
  try {
    const response = await invokeWithTimeout("deleteApprovalRule", {
      id: rule.id,
    });
    const result = parseInvokeResponse(response);

    if (!result || result.success === false) {
      throw new Error(resolveInvokeError(result) || "Unable to delete the rule.");
    }

    state.pendingDeleteId = "";
    state.globalSuccess = "Rule deleted.";
    if (state.form.id === rule.id) {
      resetFormState();
    }
    await loadDashboard({ silent: true, keepSuccess: true });
  } catch (error) {
    console.error("Failed to delete rule:", error);
    state.globalError = resolveErrorMessage(error, "Unable to delete the rule.");
    render();
  }
}

function resetFormState(options) {
  resetFormStateInternal(options);
}

function resetFormStateInternal(options) {
  state.form = createEmptyForm();
  state.form.senderEmail = state.senderEmails[0] ? state.senderEmails[0].value : "";
  state.pendingDeleteId = "";
  state.modalOpen = Boolean(options && options.preserveModal);
  clearFormMessage();
  clearFormErrors();
  render();
}

function openCreateRuleModal() {
  state.form = createEmptyForm();
  state.form.senderEmail = state.senderEmails[0] ? state.senderEmails[0].value : "";
  state.pendingDeleteId = "";
  state.modalOpen = true;
  clearFormMessage();
  clearFormErrors();
  render();
}

function openEditRuleModal(rule) {
  state.form = ruleToForm(rule);
  state.pendingDeleteId = "";
  state.modalOpen = true;
  clearFormMessage();
  clearFormErrors();
  render();
}

function closeRuleModal() {
  if (state.saving) {
    return;
  }

  resetFormStateInternal();
}

function ruleToForm(rule) {
  return {
    id: rule.id,
    name: rule.name || "",
    active: rule.active !== false,
    statusValues: Array.isArray(rule.status_values) ? [...rule.status_values] : [],
    conditionOperator: rule.condition_operator === "or" ? "or" : "and",
    conditions: (rule.conditions || []).map((condition) => ({
      field: condition.field,
      values: [...(condition.values || [])],
    })),
    approvers: (rule.approvers || []).map((approver) => ({
      email: approver.email,
      label: approver.label,
      type: approver.type || "external",
    })),
    anyoneCanApprove: Boolean(rule.anyone_can_approve),
    autoCloseAfterApproval: rule.auto_close_after_approval !== false,
    senderEmail: rule.sender_email || "",
    emailSubject: rule.email_subject || "",
    emailBody: rule.email_body || "",
  };
}

function formToPayload() {
  return {
    id: state.form.id,
    name: state.form.name.trim(),
    active: state.form.active !== false,
    status_values: [...state.form.statusValues],
    condition_operator: state.form.conditionOperator === "or" ? "or" : "and",
    conditions: state.form.conditions.map((condition) => ({
      field: condition.field,
      values: [...(condition.values || [])],
    })),
    approvers: state.form.approvers.map((approver) => ({
      email: approver.email,
      label: approver.label,
      type: approver.type,
    })),
    anyone_can_approve: Boolean(state.form.anyoneCanApprove),
    auto_close_after_approval: Boolean(state.form.autoCloseAfterApproval),
    sender_email: state.form.senderEmail,
    email_subject: state.form.emailSubject.trim(),
    email_body: state.form.emailBody.trim(),
  };
}

function validatePayload(payload) {
  const errors = {};

  if (!payload.status_values.length) {
    errors.status_values = "Choose at least one status to watch.";
  }

  if (payload.conditions.some((condition) => !condition.field || !(condition.values || []).length)) {
    errors.conditions = "Every entry condition needs a field and at least one value.";
  }

  if (!payload.approvers.length) {
    errors.approvers = "Add at least one approver email address.";
  }

  if (!payload.sender_email) {
    errors.sender_email = "Choose a Freshdesk sender email.";
  }

  if (!payload.email_subject) {
    errors.email_subject = "Enter an email subject.";
  }

  if (!payload.email_body) {
    errors.email_body = "Enter the approval email message.";
  }

  return errors;
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

  const invokeErrorDetail = extractInvokeErrorDetail(error);
  if (invokeErrorDetail) {
    return invokeErrorDetail;
  }

  if (typeof error === "string") {
    return error;
  }

  return error.message || fallback;
}

function extractInvokeErrorDetail(error) {
  if (!error || typeof error !== "object") {
    return "";
  }

  const rawPayload =
    error.response ||
    error.responseText ||
    error.body ||
    error.data ||
    error.payload ||
    "";

  if (rawPayload) {
    try {
      const parsed = typeof rawPayload === "string" ? JSON.parse(rawPayload) : rawPayload;
      return (
        parsed.detail ||
        parsed.message ||
        (Array.isArray(parsed.errors) ? parsed.errors.join("; ") : "")
      );
    } catch {
      if (typeof rawPayload === "string") {
        return rawPayload;
      }
    }
  }

  return "";
}

function invokeWithTimeout(functionName, payload) {
  return Promise.race([
    client.request.invoke(functionName, payload || {}),
    new Promise((_, reject) => {
      window.setTimeout(() => reject(new Error("Request timed out.")), INVOKE_TIMEOUT_MS);
    }),
  ]);
}

function setFormMessage(text, type) {
  state.formMessage = {
    type,
    text,
  };
}

function clearFormMessage() {
  state.formMessage = {
    type: "",
    text: "",
  };
}

function setFormErrors(errors) {
  state.formErrors = errors && typeof errors === "object" ? { ...errors } : {};
}

function setFieldError(fieldId, message) {
  state.formErrors = {
    ...state.formErrors,
    [fieldId]: message,
  };
}

function clearFieldError(fieldId) {
  if (!state.formErrors[fieldId]) {
    return;
  }

  const nextErrors = { ...state.formErrors };
  delete nextErrors[fieldId];
  state.formErrors = nextErrors;
}

function clearFormErrors() {
  state.formErrors = {};
}

function hasFormErrors(errors) {
  return Boolean(errors && Object.keys(errors).length);
}

function renderFormErrors() {
  setFieldErrorState("ruleNameError", "name", "ruleNameInput");
  setFieldErrorState("statusValuesError", "status_values", "statusValuesPanel");
  setFieldErrorState("conditionsError", "conditions", "conditionsContainer");
  setFieldErrorState("approversError", "approvers", "selectedApprovers");
  setFieldErrorState("senderEmailError", "sender_email", "senderEmailSelect");
  setFieldErrorState("emailSubjectError", "email_subject", "emailSubjectInput");
  setFieldErrorState("emailBodyError", "email_body", "emailBodyInput");

  toggleErrorClass("ruleNameInput", Boolean(state.formErrors.name), "input-error");
  toggleErrorClass("senderEmailSelect", Boolean(state.formErrors.sender_email), "input-error");
  toggleErrorClass("emailSubjectInput", Boolean(state.formErrors.email_subject), "input-error");
  toggleErrorClass("emailBodyInput", Boolean(state.formErrors.email_body), "input-error");
  toggleErrorClass("statusValuesPanel", Boolean(state.formErrors.status_values), "error-state");
  toggleErrorClass("conditionsContainer", Boolean(state.formErrors.conditions), "error-state");
  toggleErrorClass("agentApproverPanel", Boolean(state.formErrors.approvers), "error-state");
  toggleErrorClass("selectedApprovers", Boolean(state.formErrors.approvers), "error-state");
}

function setFieldErrorState(errorElementId, fieldKey, targetId) {
  const errorEl = document.getElementById(errorElementId);
  const targetEl = document.getElementById(targetId);
  const message = state.formErrors[fieldKey];

  if (!errorEl || !targetEl) {
    return;
  }

  if (message) {
    errorEl.textContent = message;
    errorEl.classList.remove("hidden");
    targetEl.setAttribute("aria-invalid", "true");
    return;
  }

  errorEl.textContent = "";
  errorEl.classList.add("hidden");
  targetEl.removeAttribute("aria-invalid");
}

function toggleErrorClass(elementId, shouldApply, className) {
  const element = document.getElementById(elementId);
  if (!element) {
    return;
  }

  element.classList.toggle(className, Boolean(shouldApply));
}

function scrollToFirstFormError(fieldOrder) {
  const orderedFields = Array.isArray(fieldOrder) && fieldOrder.length
    ? fieldOrder
    : ["name", "status_values", "conditions", "approvers", "sender_email", "email_subject", "email_body"];
  const firstField = orderedFields.find((fieldKey) => state.formErrors[fieldKey]);
  if (!firstField) {
    return;
  }

  const targetMap = {
    name: {
      scrollId: "ruleNameError",
      focusId: "ruleNameInput",
    },
    status_values: {
      scrollId: "statusValuesError",
      focusId: "statusValuesPanel",
    },
    conditions: {
      scrollId: "conditionsError",
      focusId: "conditionsContainer",
    },
    approvers: {
      scrollId: "approversError",
      focusId: "externalEmailInput",
    },
    sender_email: {
      scrollId: "senderEmailError",
      focusId: "senderEmailSelect",
    },
    email_subject: {
      scrollId: "emailSubjectError",
      focusId: "emailSubjectInput",
    },
    email_body: {
      scrollId: "emailBodyError",
      focusId: "emailBodyInput",
    },
  };

  const targetMeta = targetMap[firstField];
  if (!targetMeta) {
    return;
  }

  const scrollTarget = document.getElementById(targetMeta.scrollId) || document.getElementById(targetMeta.focusId);
  const focusTarget = document.getElementById(targetMeta.focusId) || scrollTarget;
  if (!scrollTarget) {
    return;
  }

  window.requestAnimationFrame(() => {
    scrollTarget.scrollIntoView({ behavior: "smooth", block: "center" });
    if (
      focusTarget &&
      typeof focusTarget.focus === "function" &&
      ["INPUT", "SELECT", "TEXTAREA", "BUTTON"].includes(focusTarget.tagName)
    ) {
      focusTarget.focus({ preventScroll: true });
    }
  });
}

function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

function updateStringSelection(items, value, shouldInclude) {
  const normalizedValue = String(value || "").trim();
  if (!normalizedValue) {
    return Array.isArray(items) ? [...items] : [];
  }

  const nextItems = Array.isArray(items) ? [...items] : [];
  const existingIndex = nextItems.findIndex((item) => String(item || "").trim() === normalizedValue);

  if (shouldInclude && existingIndex === -1) {
    nextItems.push(normalizedValue);
  }

  if (!shouldInclude && existingIndex !== -1) {
    nextItems.splice(existingIndex, 1);
  }

  return nextItems;
}

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim());
}

function dedupeApprovers(approvers) {
  const unique = [];
  const seen = new Set();

  (approvers || []).forEach((approver) => {
    const email = normalizeEmail(approver.email);
    if (!email || seen.has(email)) {
      return;
    }

    seen.add(email);
    unique.push({
      email: approver.email,
      label: approver.label || approver.email,
      type: approver.type === "agent" ? "agent" : "external",
    });
  });

  return unique;
}

function buildOptionLookup(options) {
  return Object.fromEntries((options || []).flatMap((option) => {
    return [
      [option.value, option.label],
      [normalizeEmail(option.value), option.label],
    ];
  }));
}

function formatConditionLine(condition) {
  const fieldMeta = state.triggerFields.find((field) => field.id === condition.field);
  const optionLookup = buildOptionLookup(fieldMeta && fieldMeta.options);
  const values = (condition.values || []).map((value) => optionLookup[value] || value).join(", ");
  return `${fieldMeta ? fieldMeta.label : condition.field}: ${values || "No values selected"}`;
}

function getConditionFieldChoices(currentFieldId) {
  const fields = state.triggerFields.filter((field) => field.id !== "status");
  if (currentFieldId === "status") {
    const legacyStatusField = state.triggerFields.find((field) => field.id === "status");
    return legacyStatusField ? [legacyStatusField, ...fields] : fields;
  }

  return fields;
}

function buildTriggerSummary(rule) {
  const statusText = rule && rule.summary && rule.summary.status_text
    ? rule.summary.status_text
    : "the selected status";
  const extraConditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  const autoCloseEnabled = rule ? rule.auto_close_after_approval !== false : false;
  const completionText = autoCloseEnabled
    ? "The ticket closes after approval."
    : "The ticket stays on its current status.";

  if (!extraConditions.length) {
    return `Runs when status changes to ${statusText}. ${completionText}`;
  }

  return `Runs when status changes to ${statusText}. Entry conditions can also start approval before that status is reached. ${completionText}`;
}

function getAutoCloseSummary(instance) {
  if (!instance) {
    return "Auto-close pending.";
  }

  if (instance.auto_close_state === "disabled" || instance.auto_close_after_approval === false) {
    return "Auto-close disabled for this rule.";
  }

  if (!instance.auto_close_state) {
    return "Auto-close pending.";
  }

  if (instance.auto_close_state === "closed") {
    return `Ticket auto-closed into ${instance.auto_close_status_label || "Closed"}.`;
  }

  if (instance.auto_close_state === "already_closed") {
    return `Ticket was already on ${instance.auto_close_status_label || "Closed"}.`;
  }

  if (instance.auto_close_state === "failed") {
    return `Ticket auto-close failed${instance.auto_close_error ? `: ${instance.auto_close_error}` : "."}`;
  }

  return "Auto-close pending.";
}

function renderTemplatePreview(text) {
  const replacements = {
    ticket_id: "#1024",
    ticket_subject: "Refund request for annual plan",
    ticket_status: "Pending",
    rule_name: state.form.name || "Approval rule",
    approval_mode: state.form.anyoneCanApprove ? "Any one approver can approve." : "Every approver must approve.",
    approver_count: String(state.form.approvers.length || 0),
    ticket_url: "https://example.freshdesk.com/a/tickets/1024",
  };

  return String(text || "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    return Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : match;
  });
}

function formatDate(value) {
  if (!value) {
    return "just now";
  }

  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttribute(value) {
  return escapeHtml(value).replace(/`/g, "&#96;");
}
