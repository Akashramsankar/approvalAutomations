const RULES_KEY = "approval_automation_rules_v1";
const INSTANCES_KEY = "approval_automation_instances_v1";
const RUNTIME_KEY = "approval_automation_runtime_v1";
const GATES_KEY = "approval_automation_status_gates_v1";
const STATUS_GUARDS_KEY = "approval_automation_status_guards_v1";
const LIVE_FIELD_METADATA_KEY = "approval_automation_live_field_metadata_v1";
const PAGE_SIZE = 100;
const METADATA_CACHE_TTL_MS = 60000;
const MAX_INSTANCE_HISTORY = 400;
const MAX_GATE_HISTORY = 300;
const STATUS_GUARD_TTL_MS = 5 * 60 * 1000;
const APPROVAL_ACTION_HOOK_OPTION = "approval-email-action";
const EMAIL_ACTIONS_ENABLED = true;
const DEFAULT_PUBLIC_APPROVAL_BRIDGE_URL = "https://approval-bridge.onrender.com";

const metadataCache = {
  value: null,
  expiresAt: 0,
  promise: null,
};

const DEFAULT_STATUS_OPTIONS = [
  { value: "2", label: "Open" },
  { value: "3", label: "Pending" },
  { value: "4", label: "Resolved" },
  { value: "5", label: "Closed" },
];

const LEGACY_STATUS_LABELS = {
  "6": "Waiting on customer",
  "7": "Waiting on third party",
};

const STATUS_LABELS = {
  ...LEGACY_STATUS_LABELS,
};
const DEFAULT_CLOSED_STATUS_VALUE = "5";

const DEFAULT_PRIORITY_OPTIONS = [
  { value: "1", label: "Low" },
  { value: "2", label: "Medium" },
  { value: "3", label: "High" },
  { value: "4", label: "Urgent" },
];

const DEFAULT_SOURCE_OPTIONS = [
  { value: "1", label: "Email" },
  { value: "2", label: "Portal" },
  { value: "3", label: "Phone" },
  { value: "7", label: "Chat" },
  { value: "9", label: "Feedback Widget" },
  { value: "10", label: "Outbound Email" },
];

const SYSTEM_OPTION_LABELS = {
  status: Object.fromEntries(DEFAULT_STATUS_OPTIONS.map((item) => [item.value, item.label])),
  priority: Object.fromEntries(DEFAULT_PRIORITY_OPTIONS.map((item) => [item.value, item.label])),
  source: Object.fromEntries(DEFAULT_SOURCE_OPTIONS.map((item) => [item.value, item.label])),
};
const BUILT_IN_TRIGGER_FIELD_IDS = new Set([
  "status",
  "priority",
  "ticket_type",
  "type",
  "group",
  "agent",
  "source",
]);
const CUSTOM_FIELD_DEBUG_SAMPLE_LIMIT = 25;

function parseArgs(args) {
  if (!args) {
    return {};
  }

  if (typeof args.body === "string") {
    return JSON.parse(args.body);
  }

  if (args.body && typeof args.body === "object") {
    return args.body;
  }

  return args;
}

function normalizeText(value) {
  return String(value === null || value === undefined ? "" : value).trim();
}

function normalizeUrl(value) {
  return normalizeText(value).replace(/\/+$/, "");
}

function normalizeLower(value) {
  return normalizeText(value).toLowerCase();
}

function normalizeBoolean(value) {
  return value === true || value === "true" || value === 1 || value === "1";
}

function dedupeStrings(items) {
  const unique = [];
  const seen = new Set();

  (Array.isArray(items) ? items : []).forEach((item) => {
    const normalized = normalizeText(item);
    const key = normalized.toLowerCase();
    if (!normalized || seen.has(key)) {
      return;
    }

    seen.add(key);
    unique.push(normalized);
  });

  return unique;
}

function dedupeOptions(items) {
  const unique = [];
  const seen = new Set();

  (Array.isArray(items) ? items : []).forEach((item) => {
    const value = normalizeText(item && item.value);
    const label = normalizeText(item && item.label) || value;
    const key = `${value.toLowerCase()}::${label.toLowerCase()}`;

    if (!value || !label || seen.has(key)) {
      return;
    }

    seen.add(key);
    unique.push({ value, label });
  });

  return unique;
}

function normalizeOptionLookupKey(fieldId, value) {
  const normalized = normalizeLower(value);
  if (!normalized) {
    return "";
  }

  if (normalizeLower(fieldId) === "status") {
    return normalized.replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim();
  }

  return normalized;
}

function humanizeFieldName(value) {
  return normalizeText(value)
    .replace(/^cf_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function createId(prefix) {
  return `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

function formatDateTime(value) {
  if (!value) {
    return "";
  }

  try {
    return new Date(value).toISOString();
  } catch {
    return "";
  }
}

function resolveStatusLabel(value) {
  const normalized = normalizeText(value);
  if (!normalized) {
    return "";
  }

  return (
    SYSTEM_OPTION_LABELS.status[normalized] ||
    STATUS_LABELS[normalized] ||
    normalized
  );
}

function escapeHtml(value) {
  return String(value === null || value === undefined ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function convertTextToHtml(value) {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

function buildQueryString(params) {
  return Object.keys(params || {})
    .filter((key) => normalizeText(key))
    .map((key) => `${encodeURIComponent(key)}=${encodeURIComponent(normalizeText(params[key]))}`)
    .join("&");
}

function parseFormEncodedData(input) {
  const normalized = normalizeText(input);
  if (!normalized) {
    return {};
  }

  return normalized.split("&").reduce((result, pair) => {
    const [rawKey, rawValue] = String(pair).split("=");
    const key = normalizeText(rawKey ? decodeURIComponent(rawKey.replace(/\+/g, " ")) : "");
    if (!key) {
      return result;
    }

    result[key] = decodeURIComponent(normalizeText(rawValue).replace(/\+/g, " "));
    return result;
  }, {});
}

function sanitizeActionTokens(tokens) {
  const normalized = {
    approved: normalizeText(tokens && tokens.approved),
    rejected: normalizeText(tokens && tokens.rejected),
  };

  return {
    approved: normalized.approved,
    rejected: normalized.rejected,
  };
}

function parseApprovalActionTokenParts(instanceId, approverEmail, decision) {
  const normalizedInstanceId = normalizeText(instanceId);
  const normalizedApproverEmail = normalizeLower(approverEmail);
  const normalizedDecision = normalizeLower(decision);

  if (!normalizedInstanceId || !normalizedApproverEmail) {
    return null;
  }

  if (!["approved", "rejected"].includes(normalizedDecision)) {
    return null;
  }

  return {
    instance_id: normalizedInstanceId,
    approver_email: normalizedApproverEmail,
    decision: normalizedDecision,
  };
}

function decodeLegacyBase64UrlToken(token) {
  const normalizedToken = normalizeText(token);
  if (!normalizedToken) {
    return null;
  }

  try {
    if (typeof Buffer !== "undefined" && Buffer && typeof Buffer.from === "function") {
      return Buffer.from(normalizedToken, "base64url").toString("utf8");
    }
  } catch {
    // Fall through to non-Buffer decode helpers.
  }

  try {
    if (typeof atob === "function") {
      const base64 = normalizedToken.replace(/-/g, "+").replace(/_/g, "/");
      const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`;
      const binary = atob(padded);
      if (typeof TextDecoder === "function") {
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
        return new TextDecoder().decode(bytes);
      }
      return binary;
    }
  } catch {
    return null;
  }

  return null;
}

function encodeApprovalActionToken(instanceId, approverEmail, decision) {
  const normalizedDecision = normalizeLower(decision) === "rejected" ? "rejected" : "approved";
  return [
    "a1",
    encodeURIComponent(normalizeText(instanceId)),
    encodeURIComponent(normalizeLower(approverEmail)),
    normalizedDecision,
  ].join(":");
}

function decodeApprovalActionToken(token) {
  const normalizedToken = normalizeText(token);
  if (!normalizedToken) {
    return null;
  }

  if (normalizedToken.startsWith("a1:")) {
    try {
      const [, encodedInstanceId, encodedApproverEmail, encodedDecision] = normalizedToken.split(":");
      return parseApprovalActionTokenParts(
        decodeURIComponent(encodedInstanceId || ""),
        decodeURIComponent(encodedApproverEmail || ""),
        decodeURIComponent(encodedDecision || "")
      );
    } catch {
      return null;
    }
  }

  try {
    const decoded = decodeLegacyBase64UrlToken(normalizedToken);
    if (!decoded) {
      return null;
    }
    const [instanceId, approverEmail, decision] = decoded.split("|");
    return parseApprovalActionTokenParts(instanceId, approverEmail, decision);
  } catch {
    return null;
  }
}

function buildErrorMessage(error, fallback) {
  if (!error) {
    return fallback || "Unknown error.";
  }

  const parts = [];
  if (error.status) {
    parts.push(`Status ${error.status}`);
  }
  if (error.message && error.message !== "UNKNOWN ERROR") {
    parts.push(String(error.message));
  }

  const responseText = error.response || error.responseText || error.body || "";
  if (responseText) {
    try {
      const parsed = typeof responseText === "string" ? JSON.parse(responseText) : responseText;
      const normalizedErrors = Array.isArray(parsed.errors)
        ? parsed.errors.map((item) => {
            if (!item || typeof item !== "object") {
              return String(item);
            }

            const field = normalizeText(item.field);
            const message = normalizeText(item.message || item.code);
            return field && message
              ? `${field}: ${message}`
              : message || JSON.stringify(item);
          }).filter(Boolean)
        : [];
      parts.push(
        parsed.description ||
          parsed.message ||
          (normalizedErrors.length ? normalizedErrors.join("; ") : JSON.stringify(parsed))
      );
      if (normalizedErrors.length) {
        parts.push(normalizedErrors.join("; "));
      }
    } catch {
      parts.push(String(responseText));
    }
  }

  if (!parts.length) {
    parts.push(fallback || "Unknown error.");
  }

  return parts.join(" - ");
}

function stringifyLogDetails(details) {
  try {
    return JSON.stringify(details);
  } catch {
    return String(details);
  }
}

function writeAutomationLog(level, event, details) {
  const message = `[ApprovalsAutomation] ${event} ${stringifyLogDetails(details || {})}`;
  const logger =
    (typeof console !== "undefined" && console && typeof console[level] === "function" && console[level]) ||
    (typeof console !== "undefined" && console && typeof console.log === "function" && console.log) ||
    null;

  if (!logger) {
    return;
  }

  logger.call(console, message);
}

function logAutomationInfo(event, details) {
  writeAutomationLog("log", event, details);
}

function logAutomationWarn(event, details) {
  writeAutomationLog("warn", event, details);
}

function buildResponse(data) {
  return renderData(null, data);
}

function buildErrorResponse(message, error) {
  return renderData({
    message,
    detail: buildErrorMessage(error, message),
    stack: error && error.stack,
  });
}

async function readDbJson(key, fallbackValue) {
  try {
    return await $db.get(key);
  } catch (error) {
    if (error && error.status === 404) {
      return fallbackValue;
    }
    throw error;
  }
}

async function writeDbJson(key, value) {
  await $db.set(key, value);
}

async function invokeRequestTemplate(name, options) {
  const requestOptions = {};

  if (options && Object.prototype.hasOwnProperty.call(options, "context")) {
    requestOptions.context = options.context || {};
  } else {
    requestOptions.context = options || {};
  }

  if (options && Object.prototype.hasOwnProperty.call(options, "body")) {
    requestOptions.body =
      typeof options.body === "string" ? options.body : JSON.stringify(options.body || {});
  }

  let response;
  try {
    response = await $request.invokeTemplate(name, requestOptions);
  } catch (error) {
    error.request_template = name;
    error.request_context = requestOptions.context || {};
    throw error;
  }

  try {
    return JSON.parse(response.response || "null");
  } catch {
    return response.response;
  }
}

async function fetchPaginated(templateName, context) {
  const items = [];

  for (let page = 1; page < 100; page += 1) {
    const pageItems = await invokeRequestTemplate(templateName, {
      ...(context || {}),
      page,
      per_page: PAGE_SIZE,
    });

    if (!Array.isArray(pageItems) || !pageItems.length) {
      break;
    }

    items.push(...pageItems);

    if (pageItems.length < PAGE_SIZE) {
      break;
    }
  }

  return items;
}

function maybeAddOption(bucket, item, settings) {
  if (!item || typeof item !== "object") {
    return false;
  }

  const preferIdValue = Boolean(settings && settings.preferIdValue);
  const value = normalizeText(
    (preferIdValue ? item.id || item.value : item.value || item.id) ||
      item.key ||
      item.name ||
      item.label ||
      item.display_name ||
      item.displayName ||
      item.text ||
      item.title
  );
  const label = normalizeText(
    item.label ||
      item.name ||
      item.display_name ||
      item.displayName ||
      item.text ||
      item.title ||
      item.value ||
      item.id ||
      item.key
  );

  if (!value || !label) {
    return false;
  }

  bucket.push({ value, label });
  return true;
}

function collectChoiceOptions(input, bucket, settings) {
  if (input === null || input === undefined) {
    return;
  }

  if (Array.isArray(input)) {
    input.forEach((item) => collectChoiceOptions(item, bucket, settings));
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

  if (maybeAddOption(bucket, input, settings)) {
    ["children", "choices", "options", "items", "values"].forEach((key) => {
      if (input[key] !== undefined) {
        collectChoiceOptions(input[key], bucket, settings);
      }
    });
    return;
  }

  Object.keys(input).forEach((key) => {
    const value = input[key];
    const normalizedKey = normalizeText(key);

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      const rawValue = normalizedKey;
      const rawLabel = normalizeText(value);
      if (rawValue && rawLabel) {
        bucket.push({ value: rawValue, label: rawLabel });
      }
      return;
    }

    if (Array.isArray(value)) {
      value.forEach((nestedItem) => {
        if (
          typeof nestedItem === "string" ||
          typeof nestedItem === "number" ||
          typeof nestedItem === "boolean"
        ) {
          const label = normalizeText(nestedItem);
          if (label) {
            bucket.push({ value: normalizedKey || label, label });
          }
        } else if (!maybeAddOption(bucket, nestedItem, settings)) {
          collectChoiceOptions(nestedItem, bucket, settings);
        }
      });
      return;
    }

    const nestedBucket = [];
    if (!maybeAddOption(nestedBucket, value, settings)) {
      collectChoiceOptions(value, nestedBucket, settings);
    }

    if (nestedBucket.length) {
      bucket.push(...nestedBucket);
      return;
    }

    if (normalizedKey) {
      bucket.push({
        value: normalizedKey,
        label: normalizedKey,
      });
    }
  });
}

function extractChoiceOptions(input, settings) {
  const options = [];
  collectChoiceOptions(input, options, settings);
  return dedupeOptions(options);
}

function collectChoiceLabels(input, bucket) {
  if (input === null || input === undefined) {
    return;
  }

  if (Array.isArray(input)) {
    input.forEach((item) => collectChoiceLabels(item, bucket));
    return;
  }

  if (typeof input === "string" || typeof input === "number" || typeof input === "boolean") {
    const label = normalizeText(input);
    if (label) {
      bucket.push(label);
    }
    return;
  }

  if (typeof input !== "object") {
    return;
  }

  const preferredLabel = normalizeText(
    input.label ||
      input.text ||
      input.name ||
      input.display_name ||
      input.displayName ||
      input.value
  );

  if (preferredLabel) {
    bucket.push(preferredLabel);
  }

  Object.keys(input).forEach((key) => {
    const value = input[key];

    if (
      typeof value === "string" ||
      typeof value === "number" ||
      typeof value === "boolean"
    ) {
      const normalizedValue = normalizeText(value);
      const normalizedKey = normalizeText(key);

      if (normalizedValue && !preferredLabel) {
        bucket.push(normalizedValue);
      } else if (
        normalizedKey &&
        normalizedValue &&
        normalizedKey !== "id" &&
        normalizedKey !== "value"
      ) {
        bucket.push(normalizedValue);
      }
      return;
    }

    collectChoiceLabels(value, bucket);
  });
}

function extractChoiceLabels(input) {
  const labels = [];
  collectChoiceLabels(input, labels);
  return dedupeStrings(labels);
}

function resolveReadableOptionLabel(fieldId, option) {
  const labelMap = SYSTEM_OPTION_LABELS[normalizeText(fieldId)] || {};
  const reverseLabelMap = Object.fromEntries(
    Object.entries(labelMap).map(([value, label]) => [normalizeOptionLookupKey(fieldId, label), value])
  );
  const rawValue = normalizeText(option && option.value);
  const rawLabel = normalizeText(option && option.label) || rawValue;
  const normalizedRawValue = normalizeOptionLookupKey(fieldId, rawValue);
  const normalizedRawLabel = normalizeOptionLookupKey(fieldId, rawLabel);

  if (labelMap[rawValue]) {
    return labelMap[rawValue];
  }

  if (labelMap[rawLabel]) {
    return labelMap[rawLabel];
  }

  if (rawLabel && !/^\d+$/.test(rawLabel)) {
    return rawLabel;
  }

  if (rawValue && !/^\d+$/.test(rawValue)) {
    return rawValue;
  }

  if (reverseLabelMap[normalizedRawValue]) {
    return labelMap[reverseLabelMap[normalizedRawValue]];
  }

  if (reverseLabelMap[normalizedRawLabel]) {
    return labelMap[reverseLabelMap[normalizedRawLabel]];
  }

  return rawLabel || rawValue;
}

function resolveCanonicalOptionValue(fieldId, option) {
  const normalizedFieldId = normalizeText(fieldId);
  const labelMap = SYSTEM_OPTION_LABELS[normalizedFieldId] || {};
  const reverseLabelMap = Object.fromEntries(
    Object.entries(labelMap).map(([value, label]) => [normalizeOptionLookupKey(fieldId, label), value])
  );

  const rawValue = normalizeText(option && option.value);
  const rawLabel = normalizeText(option && option.label) || rawValue;
  const normalizedRawValue = normalizeOptionLookupKey(fieldId, rawValue);
  const normalizedRawLabel = normalizeOptionLookupKey(fieldId, rawLabel);

  if (labelMap[rawValue]) {
    return rawValue;
  }

  if (labelMap[rawLabel]) {
    return rawLabel;
  }

  if (reverseLabelMap[normalizedRawValue]) {
    return reverseLabelMap[normalizedRawValue];
  }

  if (reverseLabelMap[normalizedRawLabel]) {
    return reverseLabelMap[normalizedRawLabel];
  }

  return rawValue || rawLabel;
}

function extractChoiceDisplayLabels(fieldId, input) {
  const options = extractChoiceOptions(input);
  if (options.length) {
    return dedupeStrings(options.map((option) => resolveReadableOptionLabel(fieldId, option)));
  }

  const labelMap = SYSTEM_OPTION_LABELS[normalizeText(fieldId)] || {};
  return dedupeStrings(
    extractChoiceLabels(input).map((label) => labelMap[normalizeText(label)] || label)
  );
}

function extractChoiceDisplayOptions(fieldId, input) {
  const options = extractChoiceOptions(input);
  if (options.length) {
    return dedupeOptions(options.map((option) => ({
      value: resolveCanonicalOptionValue(fieldId, option),
      label: resolveReadableOptionLabel(fieldId, option),
    })));
  }

  return dedupeOptions(
    extractChoiceDisplayLabels(fieldId, input).map((label) => ({
      value: label,
      label,
    }))
  );
}

function withReadableLabels(fieldId, options) {
  return dedupeOptions((Array.isArray(options) ? options : []).map((option) => {
    const normalizedOption = typeof option === "string"
      ? { value: option, label: option }
      : option;
    return {
      value: resolveCanonicalOptionValue(fieldId, normalizedOption),
      label: resolveReadableOptionLabel(fieldId, normalizedOption),
    };
  }));
}

function buildOptionLookup(fieldId, options) {
  const lookup = {};
  const labelMap = SYSTEM_OPTION_LABELS[normalizeText(fieldId)] || {};

  Object.keys(labelMap).forEach((value) => {
    const label = labelMap[value];
    lookup[normalizeOptionLookupKey(fieldId, value)] = {
      value: normalizeText(value),
      label,
    };
    lookup[normalizeOptionLookupKey(fieldId, label)] = {
      value: normalizeText(value),
      label,
    };
  });

  (Array.isArray(options) ? options : []).forEach((option) => {
    const normalizedOption = typeof option === "string"
      ? { value: option, label: option }
      : option;
    const value = resolveCanonicalOptionValue(fieldId, normalizedOption);
    const label = resolveReadableOptionLabel(fieldId, normalizedOption);

    if (!label) {
      return;
    }

    const record = {
      value: value || label,
      label,
    };

    lookup[normalizeOptionLookupKey(fieldId, label)] = record;
    lookup[normalizeOptionLookupKey(fieldId, record.value)] = record;
  });

  if (normalizeLower(fieldId) === "status") {
    Object.entries(LEGACY_STATUS_LABELS).forEach(([legacyValue, legacyLabel]) => {
      const matchedRecord = Object.values(lookup).find((record) => {
        return normalizeOptionLookupKey(fieldId, record && record.label) ===
          normalizeOptionLookupKey(fieldId, legacyLabel);
      });

      if (matchedRecord) {
        lookup[normalizeOptionLookupKey(fieldId, legacyValue)] = matchedRecord;
      }
    });
  }

  return lookup;
}

function normalizeValuesWithLookup(values, lookup, mode) {
  return dedupeStrings(
    (Array.isArray(values) ? values : []).map((value) => {
      const normalizedValue = normalizeText(value);
      const matched =
        lookup[normalizedValue.toLowerCase()] ||
        lookup[normalizedValue.toLowerCase().replace(/[_-]+/g, " ").replace(/\s+/g, " ").trim()];

      if (!matched) {
        return normalizedValue;
      }

      return mode === "label" ? matched.label : matched.value;
    })
  );
}

function normalizeFieldCollection(payload) {
  if (Array.isArray(payload)) {
    return payload;
  }

  if (payload && Array.isArray(payload.ticket_fields)) {
    return payload.ticket_fields;
  }

  if (payload && Array.isArray(payload.fields)) {
    return payload.fields;
  }

  return [];
}

function isDropdownLikeField(field) {
  const type = normalizeLower(field && field.type);
  return (
    type.includes("dropdown") ||
    type.includes("nested") ||
    type.includes("choice") ||
    type.includes("select") ||
    type.includes("picklist") ||
    type === "custom_dropdown" ||
    type === "default_dropdown"
  );
}

function extractFieldChildren(field) {
  const candidateKeys = [
    "dependentFields",
    "dependent_fields",
    "children",
    "child_fields",
    "nested_fields",
    "nestedFields",
  ];

  for (const key of candidateKeys) {
    if (Array.isArray(field && field[key])) {
      return field[key];
    }
  }

  return [];
}

function extractFieldChoiceSources(field) {
  const candidateKeys = [
    "choices",
    "choice_options",
    "choiceOptions",
    "options",
    "option_values",
    "optionValues",
    "items",
    "values",
    "entries",
    "ticket_field_choices",
    "ticketFieldChoices",
  ];

  const collected = [];
  candidateKeys.forEach((key) => {
    if (field && field[key] !== undefined) {
      collected.push(field[key]);
    }
  });

  return collected;
}

function extractFieldChoices(field) {
  const fieldName = normalizeText(field && field.name);
  const sources = extractFieldChoiceSources(field);
  return extractChoiceDisplayOptions(fieldName, sources);
}

function shouldExposeAsTriggerField(field) {
  const fieldName = normalizeText(field && field.name);
  const fieldType = normalizeLower(field && field.type);
  return Boolean(
    fieldName &&
    !BUILT_IN_TRIGGER_FIELD_IDS.has(normalizeLower(fieldName)) &&
    (
      (Array.isArray(field && field.options) && field.options.length) ||
      fieldName.startsWith("cf_") ||
      fieldType.startsWith("custom_")
    )
  );
}

function normalizeFieldNode(field, level) {
  const name = normalizeText(field && field.name);
  if (!name) {
    return null;
  }

  const children = extractFieldChildren(field);

  return {
    id: Number(field.id),
    name,
    label: normalizeText(field.label || field.labelForCustomers) || humanizeFieldName(name),
    type: normalizeText(field.type || "dropdown"),
    element_id: name,
    is_default: Boolean(
      field &&
      (field._default !== undefined ? field._default : field.default)
    ),
    level,
    options: extractFieldChoices(field),
    children: children
      .map((child) => normalizeFieldNode(child, level + 1))
      .filter(Boolean),
  };
}

function flattenFieldLevels(fieldNode) {
  const levels = [];

  function visit(node) {
    if (!node) {
      return;
    }

    levels.push({
      name: node.name,
      label: node.label,
      type: node.type,
      element_id: node.element_id,
      is_default: node.is_default,
      level: node.level,
      options: node.options,
      root_name: fieldNode.name,
      root_label: fieldNode.label,
    });

    (node.children || []).forEach(visit);
  }

  visit(fieldNode);
  return levels;
}

function indexFieldsByName(roots) {
  const index = {};

  (Array.isArray(roots) ? roots : []).forEach((root) => {
    flattenFieldLevels(root).forEach((level) => {
      index[level.name] = {
        name: level.name,
        label: level.label,
        type: level.type,
        element_id: level.element_id,
        is_default: level.is_default,
        level: level.level,
        options: level.options,
        root_name: root.name,
        root_label: root.label,
      };
    });
  });

  return index;
}

function mergeFieldLists(primaryFields, secondaryFields) {
  const merged = [];
  const seen = new Set();

  [...(Array.isArray(primaryFields) ? primaryFields : []), ...(Array.isArray(secondaryFields) ? secondaryFields : [])]
    .forEach((field) => {
      const key = normalizeLower(field && field.name);
      if (!key || seen.has(key)) {
        return;
      }

      seen.add(key);
      merged.push(field);
    });

  return merged;
}

function createSystemField(name, label, elementId, options) {
  const normalizedOptions = dedupeOptions(
    (Array.isArray(options) ? options : []).map((option) => {
      if (typeof option === "string") {
        return { value: option, label: option };
      }

      return {
        value: normalizeText(option && option.value) || normalizeText(option && option.label),
        label: normalizeText(option && option.label) || normalizeText(option && option.value),
      };
    })
  );

  if (!normalizedOptions.length) {
    return null;
  }

  return {
    id: 0,
    name,
    label,
    type: "dropdown",
    level: 1,
    element_id: elementId,
    is_default: true,
    options: normalizedOptions,
    children: [],
  };
}

function createLiveMetadataField(field) {
  const name = normalizeText(field && (field.name || field.id));
  if (!name) {
    return null;
  }

  const options = dedupeOptions(field && field.options);
  return {
    id: Number(field && field.id) || 0,
    name,
    label: normalizeText(field && field.label) || humanizeFieldName(name),
    type: normalizeText(field && field.type) || (name.startsWith("cf_") ? "custom_dropdown" : "dropdown"),
    level: 1,
    element_id: normalizeText(field && field.element_id) || name,
    is_default: false,
    options,
    children: [],
    source: normalizeText(field && field.source) || "live_ticket_sidebar",
    updated_at: Number(field && field.updated_at) || Date.now(),
  };
}

function mergeFieldOptionRecords(primary, secondary) {
  return dedupeOptions([
    ...(Array.isArray(primary) ? primary : []),
    ...(Array.isArray(secondary) ? secondary : []),
  ]);
}

function mergeLiveMetadataIntoRoots(roots, liveFields) {
  const mergedRoots = [...(Array.isArray(roots) ? roots : [])];
  const rootIndex = Object.fromEntries(
    mergedRoots.map((field, index) => [normalizeLower(field && field.name), index])
  );

  (Array.isArray(liveFields) ? liveFields : []).forEach((field) => {
    const liveField = createLiveMetadataField(field);
    if (!liveField) {
      return;
    }

    const key = normalizeLower(liveField.name);
    const existingIndex = rootIndex[key];
    if (existingIndex === undefined) {
      rootIndex[key] = mergedRoots.length;
      mergedRoots.push(liveField);
      return;
    }

    const existing = mergedRoots[existingIndex];
    mergedRoots[existingIndex] = {
      ...existing,
      label: normalizeText(existing && existing.label) || liveField.label,
      type: normalizeText(existing && existing.type) || liveField.type,
      element_id: normalizeText(existing && existing.element_id) || liveField.element_id,
      options: mergeFieldOptionRecords(existing && existing.options, liveField.options),
      children: Array.isArray(existing && existing.children) ? existing.children : [],
    };
  });

  return mergedRoots;
}

function chooseRicherOptionSet(candidates) {
  let selected = [];

  (Array.isArray(candidates) ? candidates : []).forEach((candidate) => {
    const normalized = dedupeOptions(candidate);
    if (normalized.length > selected.length) {
      selected = normalized;
    }
  });

  return selected;
}

function resolveTriggerFieldOptions(fieldId, adminField, metadataField, fallbackOptions) {
  const selected = chooseRicherOptionSet([
    extractFieldChoices(adminField),
    metadataField && metadataField.options,
    fallbackOptions,
  ]);

  if (!selected.length) {
    return [];
  }

  return withReadableLabels(fieldId, selected);
}

async function fetchAdminTicketFields() {
  const directResponse = await invokeRequestTemplate("list_admin_ticket_fields", {});
  const directItems = normalizeFieldCollection(directResponse);

  if (directItems.length) {
    logAutomationInfo("approval_dashboard_admin_fields_loaded", {
      strategy: "direct",
      field_count: directItems.length,
    });
    return directItems;
  }

  const unpagedResponse = await invokeRequestTemplate("list_admin_fields_all", {});
  const unpagedItems = normalizeFieldCollection(unpagedResponse);
  logAutomationInfo("approval_dashboard_admin_fields_loaded", {
    strategy: "unpaged",
    field_count: unpagedItems.length,
  });
  return unpagedItems;
}

async function fetchPublicTicketFields() {
  try {
    return normalizeFieldCollection(await invokeRequestTemplate("list_ticket_fields", {}));
  } catch {
    return [];
  }
}

async function fetchAdminTicketFieldDetail(fieldId) {
  return await invokeRequestTemplate("get_admin_ticket_field", {
    field_id: Number(fieldId) || fieldId,
  });
}

function getFieldMergeKey(field) {
  const id = normalizeText(field && field.id);
  if (id) {
    return `id:${id}`;
  }

  const name = normalizeLower(field && field.name);
  if (name) {
    return `name:${name}`;
  }

  return "";
}

function mergeFieldDefinitionArrays(primary, secondary) {
  const merged = [];
  const byKey = new Map();

  [...(Array.isArray(primary) ? primary : []), ...(Array.isArray(secondary) ? secondary : [])]
    .forEach((field) => {
      const key = getFieldMergeKey(field);
      if (!key) {
        return;
      }

      if (!byKey.has(key)) {
        byKey.set(key, field);
        merged.push(field);
        return;
      }

      byKey.set(key, mergeFieldDefinitions(byKey.get(key), field));
    });

  return merged.map((field) => byKey.get(getFieldMergeKey(field)) || field);
}

function mergeFieldDefinitions(primary, secondary) {
  if (!primary) {
    return secondary || null;
  }

  if (!secondary) {
    return primary;
  }

  const merged = {
    ...primary,
    ...secondary,
  };

  const childKeys = [
    "dependentFields",
    "dependent_fields",
    "children",
    "child_fields",
    "nested_fields",
    "nestedFields",
  ];

  childKeys.forEach((key) => {
    const mergedChildren = mergeFieldDefinitionArrays(primary[key], secondary[key]);
    if (mergedChildren.length) {
      merged[key] = mergedChildren;
    }
  });

  return merged;
}

function mergeRawFieldLists(primaryFields, secondaryFields) {
  return mergeFieldDefinitionArrays(primaryFields, secondaryFields);
}

function isCustomOrChoiceFieldCandidate(field) {
  const name = normalizeLower(field && field.name);
  const type = normalizeLower(field && field.type);
  const children = extractFieldChildren(field);
  const choiceSources = extractFieldChoiceSources(field);
  const choiceIds = Array.isArray(field && field.choiceIds) ? field.choiceIds : [];

  return Boolean(
    name &&
    (
      name.startsWith("cf_") ||
      type.includes("custom") ||
      isDropdownLikeField(field) ||
      children.length ||
      choiceSources.length ||
      choiceIds.length
    )
  );
}

async function enrichFieldsWithAdminDetails(rawFields) {
  const detailCandidates = (Array.isArray(rawFields) ? rawFields : [])
    .filter((field) => {
      return (
        field &&
        field.id &&
        isCustomOrChoiceFieldCandidate(field) &&
        !extractFieldChoices(field).length &&
        !extractFieldChildren(field).length
      );
    });

  if (!detailCandidates.length) {
    return {
      fields: Array.isArray(rawFields) ? rawFields : [],
      detail_count: 0,
      detail_fields: [],
    };
  }

  const detailResponses = await Promise.all(
    detailCandidates.map(async (field) => {
      try {
        return {
          id: field.id,
          name: normalizeText(field.name),
          detail: await fetchAdminTicketFieldDetail(field.id),
        };
      } catch (error) {
        logAutomationWarn("approval_dashboard_field_detail_failed", {
          field_id: Number(field && field.id) || 0,
          field_name: normalizeText(field && field.name),
          error: buildErrorMessage(error, "Failed to load ticket field detail."),
        });
        return {
          id: field.id,
          name: normalizeText(field.name),
          detail: null,
        };
      }
    })
  );

  const detailByKey = new Map();
  detailResponses.forEach((item) => {
    const detail = item && item.detail;
    if (!detail || typeof detail !== "object") {
      return;
    }

    const key = getFieldMergeKey(detail) || getFieldMergeKey({ id: item.id, name: item.name });
    if (key) {
      detailByKey.set(key, detail);
    }
  });

  const enrichedFields = (Array.isArray(rawFields) ? rawFields : []).map((field) => {
    const key = getFieldMergeKey(field);
    return key && detailByKey.has(key)
      ? mergeFieldDefinitions(field, detailByKey.get(key))
      : field;
  });

  return {
    fields: enrichedFields,
    detail_count: detailByKey.size,
    detail_fields: detailResponses
      .filter((item) => item && item.detail)
      .map((item) => ({
        id: Number(item.id) || 0,
        name: item.name,
      })),
  };
}

async function fetchTicketFieldMetadata() {
  let adminFields = [];
  let publicFields = [];
  const liveFields = await readLiveFieldMetadata();

  try {
    adminFields = await fetchAdminTicketFields();
  } catch (error) {
    logAutomationWarn("approval_dashboard_admin_fields_failed", {
      error: buildErrorMessage(error, "Failed to load admin ticket fields."),
    });
    adminFields = [];
  }

  publicFields = await fetchPublicTicketFields();

  let rawFields = mergeRawFieldLists(adminFields, publicFields);
  if (!rawFields.length) {
    rawFields = adminFields.length ? adminFields : publicFields;
  }

  const detailEnrichment = await enrichFieldsWithAdminDetails(rawFields);
  rawFields = detailEnrichment.fields;

  const normalizedRoots = mergeLiveMetadataIntoRoots(
    rawFields
    .map((field) => normalizeFieldNode(field, 1))
    .filter(
      (field) =>
        field &&
        (
          isDropdownLikeField(field) ||
          field.options.length ||
          normalizeText(field.name).startsWith("cf_") ||
          normalizeLower(field.type).startsWith("custom_")
        ) &&
        (
          field.options.length ||
          (field.children || []).length ||
          normalizeText(field.name).startsWith("cf_") ||
          normalizeLower(field.type).startsWith("custom_")
        )
    ),
    liveFields
  );

  const standardFields = normalizedRoots
    .filter((field) => !(field.children || []).length)
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));

  const dependentFields = normalizedRoots
    .filter((field) => (field.children || []).length)
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));

  const fieldCatalog = {
    ...indexFieldsByName(standardFields),
    ...indexFieldsByName(dependentFields),
  };

  const customFieldSummaries = Object.values(fieldCatalog)
    .filter((field) => !BUILT_IN_TRIGGER_FIELD_IDS.has(normalizeLower(field && field.name)))
    .map((field) => ({
      name: normalizeText(field.name),
      label: normalizeText(field.label),
      type: normalizeText(field.type),
      level: Number(field.level || 1),
      option_count: Array.isArray(field.options) ? field.options.length : 0,
    }))
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));

  logAutomationInfo("approval_dashboard_field_metadata_loaded", {
    admin_field_count: adminFields.length,
    public_field_count: publicFields.length,
    merged_field_count: rawFields.length,
    live_field_count: liveFields.length,
    detailed_field_count: detailEnrichment.detail_count,
    detailed_fields: detailEnrichment.detail_fields.slice(0, CUSTOM_FIELD_DEBUG_SAMPLE_LIMIT),
    normalized_root_count: normalizedRoots.length,
    standard_field_count: standardFields.length,
    dependent_field_count: dependentFields.length,
    catalog_field_count: Object.keys(fieldCatalog).length,
    custom_field_count: customFieldSummaries.length,
    custom_fields: customFieldSummaries.slice(0, CUSTOM_FIELD_DEBUG_SAMPLE_LIMIT),
  });

  if (!customFieldSummaries.length) {
    logAutomationWarn("approval_dashboard_custom_fields_missing", {
      admin_field_count: adminFields.length,
      public_field_count: publicFields.length,
      merged_field_count: rawFields.length,
      sample_raw_fields: rawFields
        .filter((field) => {
          return isCustomOrChoiceFieldCandidate(field) && !BUILT_IN_TRIGGER_FIELD_IDS.has(normalizeLower(field && field.name));
        })
        .slice(0, CUSTOM_FIELD_DEBUG_SAMPLE_LIMIT)
        .map((field) => ({
          id: Number(field && field.id) || 0,
          name: normalizeText(field && field.name),
          label: normalizeText(field && (field.label || field.labelForCustomers)),
          type: normalizeText(field && field.type),
          choice_source_count: extractFieldChoiceSources(field).length,
          extracted_option_count: extractFieldChoices(field).length,
          child_count: extractFieldChildren(field).length,
        })),
    });
  }

  return {
    admin_fields: rawFields,
    standard_fields: standardFields,
    dependent_fields: dependentFields,
    field_catalog: fieldCatalog,
  };
}

function findAdminField(adminFields, names) {
  const expected = new Set((Array.isArray(names) ? names : []).map((name) => normalizeLower(name)));
  return (Array.isArray(adminFields) ? adminFields : []).find((field) => {
    return expected.has(normalizeLower(field && field.name));
  });
}

async function fetchGroups() {
  try {
    return await fetchPaginated("list_groups");
  } catch {
    return [];
  }
}

async function fetchAgents() {
  try {
    return await fetchPaginated("list_agents");
  } catch {
    return [];
  }
}

async function fetchSenderEmails() {
  try {
    const mailboxes = await invokeRequestTemplate("list_email_mailboxes", {});
    const options = dedupeOptions(
      (Array.isArray(mailboxes) ? mailboxes : [])
        .filter((mailbox) => mailbox && mailbox.active && normalizeText(mailbox.support_email))
        .map((mailbox) => ({
          value: normalizeText(mailbox.support_email),
          label: normalizeText(mailbox.name)
            ? `${normalizeText(mailbox.name)} - ${normalizeText(mailbox.support_email)}`
            : normalizeText(mailbox.support_email),
        }))
    );

    if (options.length) {
      return options;
    }
  } catch {
    // Fall back to the legacy email config API.
  }

  try {
    const emailConfigs = await invokeRequestTemplate("list_email_configs", {});
    return dedupeOptions(
      (Array.isArray(emailConfigs) ? emailConfigs : [])
        .filter((config) => config && config.active && normalizeText(config.reply_email))
        .map((config) => ({
          value: normalizeText(config.reply_email),
          label: normalizeText(config.name)
            ? `${normalizeText(config.name)} - ${normalizeText(config.reply_email)}`
            : normalizeText(config.reply_email),
        }))
    );
  } catch {
    return [];
  }
}

async function fetchSupportData(metadata) {
  const groupsPromise = fetchGroups();
  const agentsPromise = fetchAgents();
  const senderEmailsPromise = fetchSenderEmails();

  const adminFields = metadata.admin_fields || [];
  const typeField = findAdminField(adminFields, ["type", "ticket_type"]);
  const statusField = findAdminField(adminFields, ["status"]);
  const priorityField = findAdminField(adminFields, ["priority"]);
  const fieldCatalog = metadata.field_catalog || {};
  const statusMeta = fieldCatalog.status || null;
  const priorityMeta = fieldCatalog.priority || null;
  const typeMeta = fieldCatalog.ticket_type || fieldCatalog.type || null;

  const [groups, agents, senderEmails] = await Promise.all([
    groupsPromise,
    agentsPromise,
    senderEmailsPromise,
  ]);

  const activeAgents = dedupeOptions(
    (Array.isArray(agents) ? agents : [])
      .filter((agent) => agent && !agent.deleted)
      .map((agent) => {
        const email = normalizeText(agent.contact && agent.contact.email) || normalizeText(agent.email);
        const name =
          normalizeText(agent.contact && agent.contact.name) ||
          normalizeText(agent.name) ||
          email;
        return email
          ? {
              value: email,
              label: `${name} - ${email}`,
            }
          : null;
      })
      .filter(Boolean)
  );

  const triggerFields = [
    {
      id: "status",
      label: "Status",
      type: "dropdown",
      options: resolveTriggerFieldOptions("status", statusField, statusMeta, DEFAULT_STATUS_OPTIONS),
    },
    {
      id: "priority",
      label: "Priority",
      type: "dropdown",
      options: resolveTriggerFieldOptions("priority", priorityField, priorityMeta, DEFAULT_PRIORITY_OPTIONS),
    },
    {
      id: "ticket_type",
      label: "Type",
      type: "dropdown",
      options: resolveTriggerFieldOptions("ticket_type", typeField, typeMeta, []),
    },
    {
      id: "group",
      label: "Group",
      type: "dropdown",
      options: dedupeOptions(
        (Array.isArray(groups) ? groups : []).map((group) => ({
          value: String(group.id),
          label: normalizeText(group.name) || `Group ${group.id}`,
        }))
      ),
    },
    {
      id: "agent",
      label: "Agent",
      type: "dropdown",
      options: dedupeOptions(
        (Array.isArray(agents) ? agents : [])
          .filter((agent) => agent && !agent.deleted)
          .map((agent) => ({
            value: String(agent.id),
            label:
              normalizeText(agent.contact && agent.contact.name) ||
              normalizeText(agent.name) ||
              normalizeText(agent.contact && agent.contact.email) ||
              normalizeText(agent.email) ||
              `Agent ${agent.id}`,
          }))
      ),
    },
    {
      id: "source",
      label: "Source",
      type: "dropdown",
      options: DEFAULT_SOURCE_OPTIONS,
    },
  ]
    .filter((field) => Array.isArray(field.options) && field.options.length)
    .map((field) => ({
      id: field.id,
      label: field.label,
      options: dedupeOptions(field.options),
    }));

  const catalogTriggerFields = dedupeOptions(
    Object.values(metadata.field_catalog || {})
      .filter((field) => shouldExposeAsTriggerField(field))
      .map((field) => ({
        value: field.name,
        label: field.label,
      }))
  ).map((field) => {
    const meta = metadata.field_catalog[field.value];
    return {
      id: meta.name,
      label: meta.label,
      type: normalizeText(meta.type || "dropdown"),
      options: meta.options || [],
    };
  });

  const allTriggerFields = [];
  const seen = new Set();

  [...triggerFields, ...catalogTriggerFields]
    .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }))
    .forEach((field) => {
      if (!field || !field.id || seen.has(field.id)) {
        return;
      }

      seen.add(field.id);
      allTriggerFields.push({
        id: field.id,
        label: field.label,
        type: normalizeText(field.type || "dropdown"),
        options: dedupeOptions(field.options),
      });
    });

  const statusTriggerField = allTriggerFields.find((field) => field.id === "status");
  const priorityTriggerField = allTriggerFields.find((field) => field.id === "priority");
  const ticketTypeTriggerField = allTriggerFields.find((field) => field.id === "ticket_type");

  logAutomationInfo("approval_dashboard_system_field_options_loaded", {
    status_option_count: Array.isArray(statusTriggerField && statusTriggerField.options)
      ? statusTriggerField.options.length
      : 0,
    priority_option_count: Array.isArray(priorityTriggerField && priorityTriggerField.options)
      ? priorityTriggerField.options.length
      : 0,
    ticket_type_option_count: Array.isArray(ticketTypeTriggerField && ticketTypeTriggerField.options)
      ? ticketTypeTriggerField.options.length
      : 0,
    status_options: Array.isArray(statusTriggerField && statusTriggerField.options)
      ? statusTriggerField.options.slice(0, CUSTOM_FIELD_DEBUG_SAMPLE_LIMIT)
      : [],
  });

  const systemFields = [
    createSystemField("status", "Status", "status", allTriggerFields.find((field) => field.id === "status")?.options),
    createSystemField("priority", "Priority", "priority", allTriggerFields.find((field) => field.id === "priority")?.options),
    createSystemField("ticket_type", "Type", "ticket_type", allTriggerFields.find((field) => field.id === "ticket_type")?.options),
    createSystemField("group", "Group", "group", allTriggerFields.find((field) => field.id === "group")?.options),
    createSystemField("agent", "Agent", "agent", allTriggerFields.find((field) => field.id === "agent")?.options),
    createSystemField("source", "Source", "source", allTriggerFields.find((field) => field.id === "source")?.options),
  ].filter(Boolean);

  return {
    trigger_fields: allTriggerFields,
    trigger_field_catalog: Object.fromEntries(
      allTriggerFields.map((field) => [field.id, field])
    ),
    system_fields: systemFields,
    sender_emails: senderEmails,
    approver_agent_options: activeAgents,
  };
}

function augmentMetadata(metadata, supportData) {
  const standardFields = mergeFieldLists(
    supportData && supportData.system_fields,
    metadata && metadata.standard_fields
  );
  const dependentFields = Array.isArray(metadata && metadata.dependent_fields)
    ? metadata.dependent_fields
    : [];

  return {
    ...metadata,
    standard_fields: standardFields,
    dependent_fields: dependentFields,
    field_catalog: {
      ...indexFieldsByName(standardFields),
      ...indexFieldsByName(dependentFields),
    },
  };
}

async function getCachedMetadataBundle() {
  const now = Date.now();
  if (metadataCache.value && metadataCache.expiresAt > now) {
    return await Promise.resolve(metadataCache.value);
  }

  if (metadataCache.promise) {
    return await metadataCache.promise;
  }

  metadataCache.promise = (async () => {
    try {
      const metadata = await fetchTicketFieldMetadata();
      const supportData = await fetchSupportData(metadata);
      const fullMetadata = augmentMetadata(metadata, supportData);
      const bundle = { metadata, supportData, fullMetadata };
      metadataCache.value = bundle;
      metadataCache.expiresAt = Date.now() + METADATA_CACHE_TTL_MS;
      return bundle;
    } catch (error) {
      if (metadataCache.value) {
        return metadataCache.value;
      }
      throw error;
    } finally {
      metadataCache.promise = null;
    }
  })();

  return await metadataCache.promise;
}

async function readRules() {
  const stored = await readDbJson(RULES_KEY, { rules: [] });
  return Array.isArray(stored && stored.rules) ? stored.rules : [];
}

async function writeRules(rules) {
  await writeDbJson(RULES_KEY, {
    rules: Array.isArray(rules) ? rules : [],
  });
}

async function readInstances() {
  const stored = await readDbJson(INSTANCES_KEY, { instances: [] });
  return Array.isArray(stored && stored.instances) ? stored.instances : [];
}

function keepLatestInstancesPerTicket(instances) {
  const latestInstances = [];
  const seenTicketIds = new Set();

  [...(Array.isArray(instances) ? instances : [])]
    .sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))
    .forEach((instance) => {
      const ticketId = Number(instance && instance.ticket_id);
      if (!instance || !ticketId || seenTicketIds.has(ticketId)) {
        return;
      }

      seenTicketIds.add(ticketId);
      latestInstances.push(instance);
    });

  return latestInstances;
}

function replaceTicketApprovalInstance(instances, nextInstance) {
  return keepLatestInstancesPerTicket([
    nextInstance,
    ...(Array.isArray(instances) ? instances : []).filter((instance) => {
      return Number(instance && instance.ticket_id) !== Number(nextInstance && nextInstance.ticket_id);
    }),
  ]);
}

async function writeInstances(instances) {
  const sortedInstances = keepLatestInstancesPerTicket(instances)
    .sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))
    .slice(0, MAX_INSTANCE_HISTORY);

  await writeDbJson(INSTANCES_KEY, {
    instances: sortedInstances,
  });
}

async function readStatusGates() {
  const stored = await readDbJson(GATES_KEY, { gates: [] });
  return Array.isArray(stored && stored.gates) ? stored.gates : [];
}

async function writeStatusGates(gates) {
  const sortedGates = [...(Array.isArray(gates) ? gates : [])]
    .sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))
    .slice(0, MAX_GATE_HISTORY);

  await writeDbJson(GATES_KEY, {
    gates: sortedGates,
  });
}

async function readStatusGuards() {
  const stored = await readDbJson(STATUS_GUARDS_KEY, { guards: [] });
  return Array.isArray(stored && stored.guards) ? stored.guards : [];
}

async function writeStatusGuards(guards) {
  await writeDbJson(STATUS_GUARDS_KEY, {
    guards: Array.isArray(guards) ? guards : [],
  });
}

async function readRuntimeConfig() {
  return await readDbJson(RUNTIME_KEY, {});
}

async function writeRuntimeConfig(config) {
  await writeDbJson(RUNTIME_KEY, config && typeof config === "object" ? config : {});
}

async function readLiveFieldMetadata() {
  const stored = await readDbJson(LIVE_FIELD_METADATA_KEY, { fields: [] });
  return Array.isArray(stored && stored.fields) ? stored.fields : [];
}

async function writeLiveFieldMetadata(fields) {
  await writeDbJson(LIVE_FIELD_METADATA_KEY, {
    fields: Array.isArray(fields) ? fields : [],
  });
}

function invalidateMetadataCache() {
  metadataCache.value = null;
  metadataCache.expiresAt = 0;
}

function canUseApprovalActions(actionConfig) {
  return EMAIL_ACTIONS_ENABLED && Boolean(normalizeText(actionConfig && actionConfig.external_action_url));
}

function resolveRuntimeConfigBridgeUrl() {
  return normalizeUrl(
    DEFAULT_PUBLIC_APPROVAL_BRIDGE_URL
  );
}

async function initializeApprovalRuntimeConfig(forceUrlRefresh) {
  const currentConfig = await readRuntimeConfig();
  const nextConfig = {
    ...(currentConfig && typeof currentConfig === "object" ? currentConfig : {}),
  };
  let changed = false;

  if (forceUrlRefresh || !normalizeText(nextConfig.external_action_url)) {
    nextConfig.external_action_url = await generateTargetUrl(APPROVAL_ACTION_HOOK_OPTION);
    nextConfig.external_action_generated_at = Date.now();
    changed = true;
  }

  const configuredBridgeUrl = resolveRuntimeConfigBridgeUrl();
  if (normalizeUrl(nextConfig.approval_bridge_url) !== configuredBridgeUrl) {
    nextConfig.approval_bridge_url = configuredBridgeUrl;
    changed = true;
  }

  if (changed) {
    await writeRuntimeConfig(nextConfig);
  }

  return nextConfig;
}

function sanitizeConditionOperator(value) {
  return normalizeLower(value) === "or" ? "or" : "and";
}

function sanitizeStatusValues(values, triggerFieldCatalog) {
  const field = triggerFieldCatalog.status;
  const options = field ? field.options : DEFAULT_STATUS_OPTIONS;
  const lookup = buildOptionLookup("status", options.length ? options : DEFAULT_STATUS_OPTIONS);
  return normalizeValuesWithLookup(values, lookup, "value");
}

function sanitizeConditions(conditions, triggerFieldCatalog) {
  return (Array.isArray(conditions) ? conditions : [])
    .map((condition) => {
      const fieldId = normalizeText(condition && condition.field);
      const fieldMeta = triggerFieldCatalog[fieldId];
      if (!fieldId || !fieldMeta) {
        return null;
      }

      const lookup = buildOptionLookup(fieldId, fieldMeta.options);
      const values = normalizeValuesWithLookup(condition.values, lookup, "value");
      if (!values.length) {
        return null;
      }

      return {
        field: fieldId,
        label: fieldMeta.label,
        values,
        value_labels: values.map((value) => {
          const matched = lookup[normalizeLower(value)];
          return matched ? matched.label : value;
        }),
      };
    })
    .filter(Boolean);
}

function sanitizeApprovers(approvers, agentOptions) {
  const agentMap = Object.fromEntries(
    (Array.isArray(agentOptions) ? agentOptions : []).map((option) => {
      const email = normalizeText(option.value);
      const label = normalizeText(option.label);
      return [email.toLowerCase(), { email, label, type: "agent" }];
    })
  );

  const unique = [];
  const seen = new Set();

  (Array.isArray(approvers) ? approvers : []).forEach((approver) => {
    const rawEmail = normalizeText(
      typeof approver === "string" ? approver : approver && approver.email
    );
    const email = rawEmail.toLowerCase();
    if (!rawEmail || seen.has(email) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(rawEmail)) {
      return;
    }

    seen.add(email);
    if (agentMap[email]) {
      unique.push(agentMap[email]);
      return;
    }

    unique.push({
      email: rawEmail,
      label: normalizeText(approver && approver.label) || rawEmail,
      type: "external",
    });
  });

  return unique;
}

function sanitizeSenderEmail(value, senderEmails) {
  const senderEmail = normalizeText(value);
  const match = (Array.isArray(senderEmails) ? senderEmails : []).find((option) => {
    return normalizeLower(option.value) === normalizeLower(senderEmail);
  });

  return match ? match.value : "";
}

function buildDefaultEmailSubject(statusLabels) {
  const suffix = statusLabels.length ? ` for ${statusLabels.join(" / ")}` : "";
  return `Approval required{{ticket_id}}${suffix}`;
}

function sanitizeRulePayload(payload, supportData, existingRule) {
  const triggerFieldCatalog = supportData.trigger_field_catalog || {};
  const statusValues = sanitizeStatusValues(
    payload.status_values || (existingRule && existingRule.status_values),
    triggerFieldCatalog
  );

  if (!statusValues.length) {
    throw new Error("Choose at least one status to watch.");
  }

  const conditions = sanitizeConditions(
    payload.conditions || (existingRule && existingRule.conditions),
    triggerFieldCatalog
  );

  const senderEmail = sanitizeSenderEmail(
    payload.sender_email || (existingRule && existingRule.sender_email),
    supportData.sender_emails
  );

  if (!senderEmail) {
    throw new Error("Choose a registered Freshdesk sender email.");
  }

  const approvers = sanitizeApprovers(
    payload.approvers || (existingRule && existingRule.approvers),
    supportData.approver_agent_options
  );

  if (!approvers.length) {
    throw new Error("Add at least one approver email address.");
  }

  const statusLookup = buildOptionLookup("status", triggerFieldCatalog.status && triggerFieldCatalog.status.options);
  const statusLabels = statusValues.map((value) => {
    const matched = statusLookup[normalizeLower(value)];
    return matched ? matched.label : value;
  });

  const now = Date.now();
  return {
    id: existingRule && existingRule.id ? existingRule.id : createId("rule"),
    name: normalizeText(payload.name) || (existingRule && existingRule.name) || `Approval for ${statusLabels.join(", ")}`,
    active:
      payload.active !== undefined
        ? payload.active !== false
        : existingRule
          ? existingRule.active !== false
          : true,
    status_values: statusValues,
    status_value_labels: statusLabels,
    condition_operator: sanitizeConditionOperator(
      payload.condition_operator || (existingRule && existingRule.condition_operator)
    ),
    conditions,
    approvers,
    anyone_can_approve: normalizeBoolean(
      payload.anyone_can_approve !== undefined
        ? payload.anyone_can_approve
        : existingRule && existingRule.anyone_can_approve
    ),
    auto_close_after_approval:
      payload.auto_close_after_approval !== undefined
        ? normalizeBoolean(payload.auto_close_after_approval)
        : existingRule
          ? existingRule.auto_close_after_approval !== false
          : false,
    sender_email: senderEmail,
    email_subject:
      normalizeText(payload.email_subject) ||
      normalizeText(existingRule && existingRule.email_subject) ||
      buildDefaultEmailSubject(statusLabels),
    email_body:
      normalizeText(payload.email_body) ||
      normalizeText(existingRule && existingRule.email_body) ||
      [
        "Approval has been requested for ticket {{ticket_id}}.",
        "",
        "Subject: {{ticket_subject}}",
        "Current status: {{ticket_status}}",
        "",
        "Use the approval buttons in the email, or reply with APPROVE or REJECT if your mail client blocks buttons.",
      ].join("\n"),
    created_at: existingRule && existingRule.created_at ? existingRule.created_at : now,
    updated_at: now,
  };
}

function sortRules(rules) {
  return [...(Array.isArray(rules) ? rules : [])].sort(
    (left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0)
  );
}

function summarizeCondition(condition) {
  if (!condition) {
    return "";
  }
  const label = normalizeText(condition.label || condition.field);
  const values = (condition.value_labels || condition.values || []).join(", ");
  return `${label}: ${values}`;
}

function summarizeTicketForLog(ticket) {
  if (!ticket) {
    return {};
  }

  return {
    id: Number(ticket.id) || 0,
    subject: normalizeText(ticket.subject),
    status: normalizeText(ticket.status),
    priority: normalizeText(ticket.priority),
    type: normalizeText(ticket.type || ticket.ticket_type),
    group: normalizeText(ticket.group_id),
    agent: normalizeText(ticket.responder_id),
  };
}

function summarizeRuleForLog(rule) {
  if (!rule) {
    return {};
  }

  return {
    id: normalizeText(rule.id),
    name: normalizeText(rule.name),
    watched_statuses:
      Array.isArray(rule.status_value_labels) && rule.status_value_labels.length
        ? rule.status_value_labels
        : (rule.status_values || []),
    condition_operator: sanitizeConditionOperator(rule.condition_operator),
    conditions: (rule.conditions || []).map((condition) => summarizeCondition(condition)),
    approvers: (rule.approvers || []).map((approver) => normalizeText(approver && approver.email)).filter(Boolean),
    sender_email: normalizeText(rule.sender_email),
  };
}

function summarizeMatchContextForLog(matchContext) {
  if (!matchContext) {
    return {};
  }

  return {
    trigger_reason: normalizeText(matchContext.trigger_reason),
    changed_field_ids: dedupeStrings(matchContext.changed_field_ids),
    matched_conditions: (matchContext.matched_conditions || []).map((condition) => summarizeCondition(condition)),
    failed_conditions: (matchContext.failed_conditions || []).map((condition) => summarizeCondition(condition)),
    snapshot: matchContext.snapshot || {},
  };
}

function summarizeMatchDecisionForLog(matchContext) {
  if (!matchContext) {
    return {};
  }

  return {
    matched: Boolean(matchContext.matched),
    status_changed: Boolean(matchContext.status_changed),
    status_matched: Boolean(matchContext.status_matched),
    relevant_field_changed: Boolean(matchContext.relevant_field_changed),
    conditions_matched: Boolean(matchContext.conditions_matched),
    changed_field_ids: dedupeStrings(matchContext.changed_field_ids),
    matched_conditions: (matchContext.matched_conditions || []).map((condition) => summarizeCondition(condition)),
    failed_conditions: (matchContext.failed_conditions || []).map((condition) => summarizeCondition(condition)),
  };
}

function summarizeRuleEvaluationForLog(rule, ticket) {
  const statusContext = buildRuleMatchContext(rule, ticket);
  const entryContext = buildEntryApprovalContext(rule, ticket);

  return {
    rule: summarizeRuleForLog(rule),
    status_evaluation: summarizeMatchDecisionForLog(statusContext),
    entry_evaluation: summarizeMatchDecisionForLog(entryContext),
  };
}

function clonePlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return { ...value };
}

function sanitizeTicketForTriggerEvaluation(ticket) {
  if (!ticket || typeof ticket !== "object") {
    return null;
  }

  return {
    id: Number(ticket.id) || 0,
    subject: normalizeText(ticket.subject) || `Ticket ${ticket.id || ""}`.trim(),
    status: normalizeText(ticket.status),
    priority: normalizeText(ticket.priority),
    type: normalizeText(ticket.type),
    ticket_type: normalizeText(ticket.ticket_type),
    group_id: normalizeText(ticket.group_id),
    responder_id: normalizeText(ticket.responder_id),
    source: normalizeText(ticket.source),
    custom_fields: clonePlainObject(ticket.custom_fields || ticket.customFields),
    changes: clonePlainObject(ticket.changes),
  };
}

function buildRuleSummary(rule) {
  const statusText = (rule.status_value_labels || []).join(", ") || "Selected status";
  const conditionText = rule.conditions && rule.conditions.length
    ? `${rule.condition_operator === "or" ? "Any" : "All"} of ${rule.conditions.length} extra condition${rule.conditions.length === 1 ? "" : "s"}`
    : "No extra conditions";
  const approverText = `${(rule.approvers || []).length} approver${(rule.approvers || []).length === 1 ? "" : "s"}`;
  return {
    status_text: statusText,
    condition_text: conditionText,
    approver_text: approverText,
    approval_mode_text: rule.anyone_can_approve ? "Anyone can approve" : "Everyone must approve",
  };
}

function mapRuleForClient(rule, pendingCounts) {
  const summary = buildRuleSummary(rule);
  return {
    ...rule,
    summary,
    pending_request_count: pendingCounts[rule.id] || 0,
    updated_at_iso: formatDateTime(rule.updated_at),
    created_at_iso: formatDateTime(rule.created_at),
  };
}

function flattenCustomFieldValues(input, bucket) {
  if (!input || typeof input !== "object") {
    return;
  }

  Object.keys(input).forEach((key) => {
    const value = input[key];
    if (value === null || value === undefined || value === "") {
      return;
    }

    if (Array.isArray(value)) {
      if (value.length) {
        bucket[key] = normalizeText(value[0]);
      }
      return;
    }

    if (typeof value === "object") {
      flattenCustomFieldValues(value, bucket);
      return;
    }

    bucket[key] = normalizeText(value);
  });
}

function buildTicketSnapshot(ticket) {
  const customFields = {};
  flattenCustomFieldValues(ticket.custom_fields || ticket.customFields || {}, customFields);

  return {
    status: normalizeText(ticket.status),
    priority: normalizeText(ticket.priority),
    ticket_type: normalizeText(ticket.type || ticket.ticket_type),
    group: normalizeText(ticket.group_id),
    agent: normalizeText(ticket.responder_id),
    source: normalizeText(ticket.source),
    ...customFields,
  };
}

function hasTicketChanges(ticket) {
  const changes = ticket && ticket.changes;
  return Boolean(changes && typeof changes === "object" && Object.keys(changes).length);
}

function extractTicketChangeKeys(ticket) {
  const changes = ticket && ticket.changes;
  if (!changes || typeof changes !== "object") {
    return [];
  }

  const keys = [];
  Object.keys(changes).forEach((key) => {
    const value = changes[key];
    if (
      (key === "custom_fields" || key === "customFields") &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      keys.push(...Object.keys(value));
      return;
    }

    keys.push(key);
  });

  return dedupeStrings(keys);
}

function readNestedValue(input, path) {
  return (Array.isArray(path) ? path : []).reduce((value, key) => {
    if (value === null || value === undefined || typeof value !== "object") {
      return undefined;
    }

    return value[key];
  }, input);
}

function getTicketChangeValue(ticket, fieldId) {
  const changes = ticket && ticket.changes;
  if (!changes || typeof changes !== "object") {
    return undefined;
  }

  if (normalizeLower(fieldId).startsWith("cf_")) {
    const customChange =
      readNestedValue(changes, ["custom_fields", fieldId]) ??
      readNestedValue(changes, ["customFields", fieldId]);
    return customChange !== undefined ? customChange : changes[fieldId];
  }

  const changeKeyMap = {
    ticket_type: ["type", "ticket_type"],
    group: ["group_id", "group"],
    agent: ["responder_id", "agent"],
  };

  const keys = changeKeyMap[fieldId] || [fieldId];
  for (const key of keys) {
    if (Object.prototype.hasOwnProperty.call(changes, key)) {
      return changes[key];
    }
  }

  return undefined;
}

function normalizeChangedFieldValue(value) {
  if (value === null || value === undefined || value === "") {
    return "";
  }

  if (Array.isArray(value)) {
    return value.length ? normalizeChangedFieldValue(value[0]) : "";
  }

  if (typeof value === "object") {
    return "";
  }

  return normalizeText(value);
}

function parseFieldChange(rawChange, currentValue) {
  let previousValue = "";
  let requestedValue = currentValue;

  if (Array.isArray(rawChange)) {
    previousValue = normalizeChangedFieldValue(rawChange[0]);
    if (rawChange.length > 1) {
      requestedValue = normalizeChangedFieldValue(rawChange[1]) || currentValue;
    }
  } else if (rawChange && typeof rawChange === "object") {
    previousValue = normalizeChangedFieldValue(
      rawChange.from ?? rawChange.old ?? rawChange.previous ?? rawChange.before
    );
    requestedValue =
      normalizeChangedFieldValue(
        rawChange.to ?? rawChange.new ?? rawChange.current ?? rawChange.after
      ) || currentValue;
  } else if (rawChange !== undefined) {
    previousValue = normalizeChangedFieldValue(rawChange);
  }

  return {
    previous_value: previousValue,
    requested_value: requestedValue || currentValue,
  };
}

function getRuleWatchedFieldIds(rule) {
  return dedupeStrings([
    "status",
    ...(Array.isArray(rule && rule.conditions)
      ? rule.conditions.map((condition) => condition && condition.field)
      : []),
  ]);
}

function getRuleEntryFieldIds(rule) {
  return dedupeStrings(
    (Array.isArray(rule && rule.conditions)
      ? rule.conditions.map((condition) => condition && condition.field)
      : [])
      .filter((fieldId) => normalizeLower(fieldId) !== "status")
  );
}

function buildConditionSnapshot(rule, snapshot) {
  return Object.fromEntries(
    getRuleEntryFieldIds(rule).map((fieldId) => [fieldId, normalizeText(snapshot && snapshot[fieldId])])
  );
}

function conditionSnapshotsMatch(left, right) {
  const leftSnapshot = left && typeof left === "object" ? left : {};
  const rightSnapshot = right && typeof right === "object" ? right : {};
  const leftKeys = Object.keys(leftSnapshot).sort();
  const rightKeys = Object.keys(rightSnapshot).sort();

  if (leftKeys.length !== rightKeys.length) {
    return false;
  }

  return leftKeys.every((key, index) => {
    return key === rightKeys[index] &&
      normalizeLower(leftSnapshot[key]) === normalizeLower(rightSnapshot[key]);
  });
}

function findReusableEntryApprovalInstance(instances, rule, ticketId, snapshot) {
  const expectedSnapshot = buildConditionSnapshot(rule, snapshot);
  return (Array.isArray(instances) ? instances : []).find((instance) => {
    return instance &&
      Number(instance.ticket_id) === Number(ticketId) &&
      normalizeText(instance.rule_id) === normalizeText(rule && rule.id) &&
      !normalizeText(instance.gate_id) &&
      !Number(instance.consumed_at || 0) &&
      ["pending", "approved"].includes(normalizeLower(instance.state)) &&
      conditionSnapshotsMatch(instance.condition_snapshot, expectedSnapshot);
  }) || null;
}

function consumeReusableApprovalInstance(instance, statusChange) {
  if (!instance) {
    return;
  }

  instance.consumed_at = Date.now();
  instance.consumed_status = normalizeText(statusChange && statusChange.requested_status);
  instance.consumed_status_label = normalizeText(statusChange && statusChange.requested_status_label);
  instance.updated_at = instance.consumed_at;
  instance.last_activity_at = instance.updated_at;
}

function didTicketFieldChange(ticket, fieldId) {
  const snapshot = buildTicketSnapshot(ticket);
  const rawChange = getTicketChangeValue(ticket, fieldId);
  if (rawChange === undefined) {
    return false;
  }

  const parsedChange = parseFieldChange(rawChange, normalizeText(snapshot[fieldId]));
  return normalizeLower(parsedChange.previous_value) !== normalizeLower(parsedChange.requested_value);
}

function evaluateConditions(rule, snapshot) {
  const conditions = Array.isArray(rule.conditions) ? rule.conditions : [];
  if (!conditions.length) {
    return {
      matched: true,
      matched_conditions: [],
      failed_conditions: [],
    };
  }

  const results = conditions.map((condition) => {
    const currentValue = normalizeText(snapshot[condition.field]);
    const matched = (condition.values || []).some((value) => normalizeLower(value) === normalizeLower(currentValue));
    return {
      ...condition,
      current_value: currentValue,
      matched,
    };
  });

  const operator = sanitizeConditionOperator(rule.condition_operator);
  const matched = operator === "or"
    ? results.some((result) => result.matched)
    : results.every((result) => result.matched);

  return {
    matched,
    matched_conditions: results.filter((result) => result.matched),
    failed_conditions: results.filter((result) => !result.matched),
  };
}

function hasStatusChange(ticket) {
  return didTicketFieldChange(ticket, "status");
}

function extractStatusChange(ticket) {
  const currentStatus = normalizeText(ticket && ticket.status);
  const rawChange = getTicketChangeValue(ticket, "status");
  const parsedChange = parseFieldChange(rawChange, currentStatus);
  const previousStatus = parsedChange.previous_value;
  const nextStatus = parsedChange.requested_value || currentStatus;

  return {
    previous_status: previousStatus,
    requested_status: nextStatus || currentStatus,
    previous_status_label: resolveStatusLabel(previousStatus),
    requested_status_label: resolveStatusLabel(nextStatus || currentStatus),
  };
}

function cleanupStatusGuards(guards) {
  const now = Date.now();
  return (Array.isArray(guards) ? guards : []).filter((guard) => {
    return guard &&
      Number(guard.ticket_id) &&
      normalizeText(guard.status_value) &&
      Number(guard.expires_at || 0) > now;
  });
}

function createStatusGuard(ticketId, statusValue, metadata) {
  return {
    id: createId("guard"),
    ticket_id: Number(ticketId),
    status_value: normalizeText(statusValue),
    reason: normalizeText(metadata && metadata.reason),
    gate_id: normalizeText(metadata && metadata.gate_id),
    instance_ids: dedupeStrings(metadata && metadata.instance_ids),
    created_at: Date.now(),
    expires_at: Date.now() + STATUS_GUARD_TTL_MS,
  };
}

function consumeStatusGuard(guards, ticketId, statusValue) {
  const activeGuards = cleanupStatusGuards(guards);
  const guardIndex = activeGuards.findIndex((guard) => {
    return Number(guard.ticket_id) === Number(ticketId) &&
      normalizeLower(guard.status_value) === normalizeLower(statusValue);
  });

  if (guardIndex === -1) {
    return {
      guard: null,
      guards: activeGuards,
    };
  }

  const [guard] = activeGuards.splice(guardIndex, 1);
  return {
    guard,
    guards: activeGuards,
  };
}

function buildStatusGateNote(gate, action) {
  if (action === "blocked") {
    return [
      "<strong>Approvals Automation Pro</strong> blocked a watched status change.",
      gate.requested_status_label
        ? `<br>Requested status: <strong>${escapeHtml(gate.requested_status_label)}</strong>`
        : "",
      gate.previous_status_label
        ? `<br>Ticket reverted to: <strong>${escapeHtml(gate.previous_status_label)}</strong> until approval is complete.`
        : "<br>The ticket will stay on its previous status until the approval request is complete.",
    ].join("");
  }

  if (action === "pending_retry") {
    return [
      "<strong>Approvals Automation Pro</strong> blocked the status change again because approval is still pending.",
      gate.previous_status_label
        ? `<br>Ticket reverted to: <strong>${escapeHtml(gate.previous_status_label)}</strong>.`
        : "",
    ].join("");
  }

  if (action === "rejected") {
    return [
      "<strong>Approvals Automation Pro</strong> cancelled the watched status change because one or more approvers rejected it.",
      gate.requested_status_label
        ? `<br>Requested status was: <strong>${escapeHtml(gate.requested_status_label)}</strong>.`
        : "",
      gate.previous_status_label
        ? `<br>Ticket remains on: <strong>${escapeHtml(gate.previous_status_label)}</strong>.`
        : "",
    ].join("");
  }

  if (action === "applied") {
    return [
      "<strong>Approvals Automation Pro</strong> received all required approvals and completed the watched status change.",
      gate.requested_status_label
        ? `<br>Ticket moved to: <strong>${escapeHtml(gate.requested_status_label)}</strong>.`
        : "",
    ].join("");
  }

  if (action === "apply_failed") {
    return [
      "<strong>Approvals Automation Pro</strong> received all required approvals but could not complete the watched status change automatically.",
      gate.requested_status_label
        ? `<br>Requested status: <strong>${escapeHtml(gate.requested_status_label)}</strong>.`
        : "",
      gate.application_error
        ? `<br>Error: ${escapeHtml(gate.application_error)}`
        : "",
    ].join("");
  }

  if (action === "revert_failed") {
    return [
      "<strong>Approvals Automation Pro</strong> created the approval request but could not return the ticket to its previous status automatically.",
      gate.previous_status_label
        ? `<br>Previous status: <strong>${escapeHtml(gate.previous_status_label)}</strong>.`
        : "",
      gate.rollback_error
        ? `<br>Error: ${escapeHtml(gate.rollback_error)}`
        : "",
    ].join("");
  }

  return "";
}

function buildRuleMatchContext(rule, ticket) {
  const snapshot = buildTicketSnapshot(ticket);
  const statusMatched = (rule.status_values || []).some((value) => normalizeLower(value) === normalizeLower(snapshot.status));
  const extraConditions = evaluateConditions(rule, snapshot);
  const changedFieldIds = getRuleWatchedFieldIds(rule).filter((fieldId) => didTicketFieldChange(ticket, fieldId));
  const statusChanged = changedFieldIds.includes("status");

  return {
    snapshot,
    status_matched: statusMatched,
    conditions_matched: extraConditions.matched,
    matched_conditions: extraConditions.matched_conditions,
    failed_conditions: extraConditions.failed_conditions,
    status_changed: statusChanged,
    relevant_field_changed: statusChanged,
    changed_field_ids: changedFieldIds,
    trigger_reason: "status_change",
    matched: statusChanged && statusMatched && extraConditions.matched,
  };
}

function buildMatchedRuleContexts(rules, ticket) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule) => ({
      rule,
      matchContext: buildRuleMatchContext(rule, ticket),
    }))
    .filter((item) => item.rule && item.matchContext && item.matchContext.matched);
}

function buildEntryApprovalContext(rule, ticket) {
  const snapshot = buildTicketSnapshot(ticket);
  const extraConditions = evaluateConditions(rule, snapshot);
  const changedFieldIds = getRuleEntryFieldIds(rule).filter((fieldId) => didTicketFieldChange(ticket, fieldId));

  return {
    snapshot,
    status_matched: false,
    conditions_matched: extraConditions.matched,
    matched_conditions: extraConditions.matched_conditions,
    failed_conditions: extraConditions.failed_conditions,
    status_changed: false,
    relevant_field_changed: changedFieldIds.length > 0,
    changed_field_ids: changedFieldIds,
    trigger_reason: "entry_conditions",
    matched: changedFieldIds.length > 0 && extraConditions.matched,
  };
}

function buildMatchedEntryRuleContexts(rules, ticket) {
  return (Array.isArray(rules) ? rules : [])
    .map((rule) => ({
      rule,
      matchContext: buildEntryApprovalContext(rule, ticket),
    }))
    .filter((item) => item.rule && item.matchContext && item.matchContext.matched);
}

function createApprovalInstance(rule, ticket, domain, matchContext) {
  const ticketUrl = domain && ticket && ticket.id
    ? `https://${domain}/a/tickets/${ticket.id}`
    : "";
  const autoCloseAfterApproval = rule && rule.auto_close_after_approval !== false;

  const approvers = (rule.approvers || []).map((approver) => {
    return buildPendingApproverFromRule(approver, null);
  });

  const now = Date.now();
  return {
    id: createId("approval"),
    rule_id: rule.id,
    rule_name: rule.name,
    ticket_id: Number(ticket.id),
    ticket_subject: normalizeText(ticket.subject) || `Ticket ${ticket.id}`,
    ticket_status: normalizeText(ticket.status),
    ticket_status_label:
      (rule.status_value_labels || []).find((label, index) => {
        return normalizeLower(rule.status_values[index]) === normalizeLower(ticket.status);
      }) || normalizeText(ticket.status),
    ticket_url: ticketUrl,
    sender_email: rule.sender_email,
    approval_mode: rule.anyone_can_approve ? "anyone" : "everyone",
    auto_close_after_approval: autoCloseAfterApproval,
    trigger_reason: normalizeText(matchContext && matchContext.trigger_reason) || "status_change",
    trigger_field_ids: dedupeStrings(matchContext && matchContext.changed_field_ids),
    condition_snapshot: buildConditionSnapshot(rule, matchContext && matchContext.snapshot),
    state: "pending",
    email_status: "queued",
    email_error: "",
    approvers,
    matched_conditions: (matchContext.matched_conditions || []).map((condition) => summarizeCondition(condition)),
    auto_close_state: autoCloseAfterApproval ? "not_attempted" : "disabled",
    auto_close_status: "",
    auto_close_status_label: "",
    auto_close_error: "",
    auto_close_attempted_at: 0,
    auto_closed_at: 0,
    consumed_at: 0,
    consumed_status: "",
    consumed_status_label: "",
    created_at: now,
    updated_at: now,
    last_activity_at: now,
  };
}

function buildPendingApproverFromRule(ruleApprover, existingApprover) {
  const actionTokens = sanitizeActionTokens(existingApprover && existingApprover.action_tokens);
  return {
    email: normalizeText(ruleApprover && ruleApprover.email),
    label:
      normalizeText(ruleApprover && ruleApprover.label) ||
      normalizeText(ruleApprover && ruleApprover.email),
    type: normalizeText(ruleApprover && ruleApprover.type) || "external",
    status: normalizeText(existingApprover && existingApprover.status) || "pending",
    responded_at: Number(existingApprover && existingApprover.responded_at) || 0,
    decision_source: normalizeText(existingApprover && existingApprover.decision_source),
    email_delivery_status:
      normalizeText(existingApprover && existingApprover.email_delivery_status) || "queued",
    email_delivery_error: normalizeText(existingApprover && existingApprover.email_delivery_error),
    email_sent_at: Number(existingApprover && existingApprover.email_sent_at) || 0,
    email_response_id: Number(existingApprover && existingApprover.email_response_id) || 0,
    email_sender_fallback_used: Boolean(existingApprover && existingApprover.email_sender_fallback_used),
    action_tokens: actionTokens.approved || actionTokens.rejected ? actionTokens : undefined,
  };
}

function approversMatch(leftApprovers, rightApprovers) {
  const left = Array.isArray(leftApprovers) ? leftApprovers : [];
  const right = Array.isArray(rightApprovers) ? rightApprovers : [];

  if (left.length !== right.length) {
    return false;
  }

  return left.every((approver, index) => {
    const other = right[index] || {};
    return normalizeLower(approver && approver.email) === normalizeLower(other && other.email) &&
      normalizeText(approver && approver.label) === normalizeText(other && other.label) &&
      normalizeText(approver && approver.type) === normalizeText(other && other.type) &&
      normalizeText(approver && approver.status) === normalizeText(other && other.status) &&
      Number(approver && approver.responded_at) === Number(other && other.responded_at) &&
      normalizeText(approver && approver.decision_source) === normalizeText(other && other.decision_source) &&
      normalizeText(approver && approver.email_delivery_status) === normalizeText(other && other.email_delivery_status) &&
      normalizeText(approver && approver.email_delivery_error) === normalizeText(other && other.email_delivery_error) &&
      Number(approver && approver.email_sent_at) === Number(other && other.email_sent_at) &&
      Number(approver && approver.email_response_id) === Number(other && other.email_response_id) &&
      Boolean(approver && approver.email_sender_fallback_used) === Boolean(other && other.email_sender_fallback_used);
  });
}

function syncPendingInstanceWithRule(instance, rule) {
  if (!instance ||
    normalizeText(instance.rule_id) !== normalizeText(rule && rule.id) ||
    normalizeLower(instance.state) !== "pending") {
    return {
      changed: false,
      previous_state: normalizeText(instance && instance.state),
      next_state: normalizeText(instance && instance.state),
    };
  }

  const existingApproverMap = Object.fromEntries(
    (Array.isArray(instance.approvers) ? instance.approvers : []).map((approver) => {
      return [normalizeLower(approver && approver.email), approver];
    })
  );
  const nextApprovers = (rule.approvers || []).map((approver) => {
    return buildPendingApproverFromRule(
      approver,
      existingApproverMap[normalizeLower(approver && approver.email)]
    );
  });
  const previousState = normalizeText(instance.state);
  let changed = false;

  const nextRuleName = normalizeText(rule && rule.name);
  if (normalizeText(instance.rule_name) !== nextRuleName) {
    instance.rule_name = nextRuleName;
    changed = true;
  }

  const nextSenderEmail = normalizeText(rule && rule.sender_email);
  if (normalizeText(instance.sender_email) !== nextSenderEmail) {
    instance.sender_email = nextSenderEmail;
    changed = true;
  }

  const nextApprovalMode = rule && rule.anyone_can_approve ? "anyone" : "everyone";
  if (normalizeText(instance.approval_mode) !== nextApprovalMode) {
    instance.approval_mode = nextApprovalMode;
    changed = true;
  }

  const nextAutoCloseAfterApproval = rule && rule.auto_close_after_approval !== false;
  if (Boolean(instance.auto_close_after_approval) !== Boolean(nextAutoCloseAfterApproval)) {
    instance.auto_close_after_approval = nextAutoCloseAfterApproval;
    changed = true;
  }

  if (nextAutoCloseAfterApproval && normalizeLower(instance.auto_close_state) === "disabled") {
    instance.auto_close_state = "not_attempted";
    changed = true;
  }

  if (!nextAutoCloseAfterApproval && ["", "not_attempted", "disabled"].includes(normalizeLower(instance.auto_close_state))) {
    instance.auto_close_state = "disabled";
    instance.auto_close_status = "";
    instance.auto_close_status_label = "";
    instance.auto_close_error = "";
    instance.auto_close_attempted_at = 0;
    instance.auto_closed_at = 0;
    changed = true;
  }

  if (!approversMatch(instance.approvers, nextApprovers)) {
    instance.approvers = nextApprovers;
    changed = true;
  }

  recomputeInstanceState(instance);
  if (!changed && normalizeText(instance.state) !== previousState) {
    changed = true;
  }

  if (changed) {
    instance.updated_at = Date.now();
    instance.last_activity_at = instance.updated_at;
  }

  return {
    changed,
    previous_state: previousState,
    next_state: normalizeText(instance.state),
  };
}

async function syncPendingApprovalInstancesForRule(rule, instances, gates) {
  const updates = [];
  const notes = [];

  for (const instance of Array.isArray(instances) ? instances : []) {
    const syncResult = syncPendingInstanceWithRule(instance, rule);
    if (!syncResult.changed) {
      continue;
    }

    const gateResult = await syncGateAfterApprovalUpdate(instance, instances, gates);
    updates.push({
      ticket_id: Number(instance && instance.ticket_id) || 0,
      instance_id: normalizeText(instance && instance.id),
      previous_state: normalizeText(syncResult.previous_state),
      state: normalizeText(syncResult.next_state),
    });

    if (gateResult.note || normalizeText(syncResult.previous_state) !== normalizeText(syncResult.next_state)) {
      notes.push({
        ticket_id: Number(instance && instance.ticket_id) || 0,
        body: [
          `<strong>Approvals Automation Pro</strong> refreshed the active approval request after rule <strong>${escapeHtml(rule.name)}</strong> was updated.`,
          normalizeText(syncResult.previous_state) !== normalizeText(syncResult.next_state)
            ? `<br>Approval state changed from <strong>${escapeHtml(syncResult.previous_state || "pending")}</strong> to <strong>${escapeHtml(syncResult.next_state || "pending")}</strong>.`
            : "",
          gateResult.note ? `<br>${gateResult.note}` : "",
        ].join(""),
      });
    }
  }

  return {
    changed: updates.length > 0,
    updates,
    notes,
  };
}

function findOpenStatusGate(gates, ticketId, requestedStatus) {
  return (Array.isArray(gates) ? gates : []).find((gate) => {
    if (!gate || Number(gate.ticket_id) !== Number(ticketId)) {
      return false;
    }

    if (requestedStatus && normalizeLower(gate.requested_status) !== normalizeLower(requestedStatus)) {
      return false;
    }

    return !["applied", "rejected"].includes(normalizeLower(gate.state));
  });
}

function getGateInstances(instances, gateId) {
  return (Array.isArray(instances) ? instances : []).filter((instance) => {
    return normalizeText(instance && instance.gate_id) === normalizeText(gateId);
  });
}

function recomputeStatusGate(gate, instances) {
  const gateInstances = getGateInstances(instances, gate.id);
  const now = Date.now();

  if (gate.applied_at) {
    gate.state = "applied";
    gate.application_error = "";
    gate.updated_at = now;
    gate.instance_ids = dedupeStrings(gateInstances.map((instance) => instance.id));
    return gate;
  }

  gate.instance_ids = dedupeStrings(gateInstances.map((instance) => instance.id));

  if (gateInstances.some((instance) => instance.state === "rejected")) {
    gate.state = "rejected";
    gate.application_error = "";
    gate.resolved_at = gate.resolved_at || now;
    gate.updated_at = now;
    return gate;
  }

  if (gateInstances.length && gateInstances.every((instance) => instance.state === "approved")) {
    gate.state = "approved";
    gate.application_error = "";
    gate.resolved_at = gate.resolved_at || now;
    gate.updated_at = now;
    return gate;
  }

  gate.state = "pending";
  gate.application_error = "";
  gate.resolved_at = 0;
  gate.updated_at = now;
  return gate;
}

function recomputeInstanceState(instance) {
  const approvers = Array.isArray(instance.approvers) ? instance.approvers : [];

  if (approvers.some((approver) => approver.status === "rejected")) {
    instance.state = "rejected";
    return instance;
  }

  if (instance.approval_mode === "anyone") {
    instance.state = approvers.some((approver) => approver.status === "approved")
      ? "approved"
      : "pending";
    return instance;
  }

  instance.state = approvers.length && approvers.every((approver) => approver.status === "approved")
    ? "approved"
    : "pending";
  return instance;
}

function renderTemplateString(template, tokens) {
  return String(template || "").replace(/\{\{\s*([a-z0-9_]+)\s*\}\}/gi, (match, key) => {
    return Object.prototype.hasOwnProperty.call(tokens, key) ? tokens[key] : match;
  });
}

function buildMailtoApprovalLink(targetEmail, instance, decision) {
  const recipient = normalizeText(targetEmail);
  const normalizedDecision = normalizeLower(decision) === "rejected" ? "REJECT" : "APPROVE";
  const requestId = normalizeText(instance && instance.id);
  const ticketSubject = normalizeText(instance && instance.ticket_subject) || `Ticket ${normalizeText(instance && instance.ticket_id)}`;
  const subject = `${normalizedDecision} - Approval Request ${requestId} - ${ticketSubject}`;
  const body = [
    normalizedDecision,
    `Approval Request ID: ${requestId}`,
    `Ticket ID: ${normalizeText(instance && instance.ticket_id)}`,
  ].join("\n");

  return `mailto:${encodeURIComponent(recipient)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

function buildMailtoButtonMarkup(targetEmail, instance, decision, label, palette) {
  const href = buildMailtoApprovalLink(targetEmail, instance, decision);
  if (!href) {
    return "";
  }

  return `<a href="${escapeHtml(href)}" style="${palette}">${escapeHtml(label)}</a>`;
}

function buildApprovalBridgeLink(bridgeUrl, hookUrl, token, decision) {
  const normalizedBridgeUrl = normalizeUrl(bridgeUrl);
  const normalizedHookUrl = normalizeText(hookUrl);
  const normalizedToken = normalizeText(token);
  const normalizedDecision = normalizeLower(decision) === "rejected" ? "rejected" : "approved";

  if (!normalizedBridgeUrl || !normalizedHookUrl || !normalizedToken) {
    return "";
  }

  const query = buildQueryString({
    hook: normalizedHookUrl,
    token: normalizedToken,
    decision: normalizedDecision,
  });
  return `${normalizedBridgeUrl}/approval${query ? `?${query}` : ""}`;
}

function buildBridgeButtonMarkup(bridgeUrl, hookUrl, token, decision, label, palette) {
  const href = buildApprovalBridgeLink(bridgeUrl, hookUrl, token, decision);
  if (!href) {
    return "";
  }

  return `<a href="${escapeHtml(href)}" style="${palette}">${escapeHtml(label)}</a>`;
}

function buildEmailActionMarkup(actionConfig) {
  if (!canUseApprovalActions(actionConfig)) {
    return {
      actions_enabled: false,
      button_mode: "none",
    };
  }

  const actionUrl = normalizeText(actionConfig && actionConfig.external_action_url);
  const senderEmail = normalizeText(actionConfig && actionConfig.sender_email);
  return {
    approve_mailto_button: "",
    reject_mailto_button: "",
    actions_enabled: Boolean(actionUrl),
    button_mode: normalizeUrl(actionConfig && actionConfig.approval_bridge_url) ? "bridge" : "mailto",
    sender_email: senderEmail,
  };
}

function buildEmailContent(rule, instance, approver, actionConfig) {
  const approverLabel = normalizeText(approver && (approver.label || approver.email));
  const emailActions = buildEmailActionMarkup(actionConfig);
  emailActions.approve_bridge_button = buildBridgeButtonMarkup(
    normalizeUrl(actionConfig && actionConfig.approval_bridge_url),
    normalizeText(actionConfig && actionConfig.external_action_url),
    encodeApprovalActionToken(instance && instance.id, approver && approver.email, "approved"),
    "approved",
    "Approve",
    [
      "display:inline-block",
      "text-decoration:none",
      "border:1px solid #17324d",
      "border-radius:999px",
      "background:#17324d",
      "color:#ffffff",
      "padding:10px 18px",
      "font-size:13px",
      "font-weight:700",
      "font-family:Arial,sans-serif",
      "line-height:1",
      "margin:0 8px 8px 0",
    ].join(";")
  );
  emailActions.reject_bridge_button = buildBridgeButtonMarkup(
    normalizeUrl(actionConfig && actionConfig.approval_bridge_url),
    normalizeText(actionConfig && actionConfig.external_action_url),
    encodeApprovalActionToken(instance && instance.id, approver && approver.email, "rejected"),
    "rejected",
    "Reject",
    [
      "display:inline-block",
      "text-decoration:none",
      "border:1px solid #e0b9b4",
      "border-radius:999px",
      "background:#fff4f2",
      "color:#9d2b22",
      "padding:10px 18px",
      "font-size:13px",
      "font-weight:700",
      "font-family:Arial,sans-serif",
      "line-height:1",
      "margin:0 8px 8px 0",
    ].join(";")
  );
  if (emailActions.button_mode !== "bridge") {
    emailActions.approve_mailto_button = buildMailtoButtonMarkup(
      normalizeText(rule && rule.sender_email) || normalizeText(emailActions.sender_email),
      instance,
      "approved",
      "Approve",
      [
        "display:inline-block",
        "text-decoration:none",
        "border:1px solid #17324d",
        "border-radius:999px",
        "background:#17324d",
        "color:#ffffff",
        "padding:10px 18px",
        "font-size:13px",
        "font-weight:700",
        "font-family:Arial,sans-serif",
        "line-height:1",
        "margin:0 8px 8px 0",
      ].join(";")
    );
    emailActions.reject_mailto_button = buildMailtoButtonMarkup(
      normalizeText(rule && rule.sender_email) || normalizeText(emailActions.sender_email),
      instance,
      "rejected",
      "Reject",
      [
        "display:inline-block",
        "text-decoration:none",
        "border:1px solid #e0b9b4",
        "border-radius:999px",
        "background:#fff4f2",
        "color:#9d2b22",
        "padding:10px 18px",
        "font-size:13px",
        "font-weight:700",
        "font-family:Arial,sans-serif",
        "line-height:1",
        "margin:0 8px 8px 0",
      ].join(";")
    );
  }
  const mailtoButtonsEnabled = Boolean(
    emailActions.approve_mailto_button && emailActions.reject_mailto_button
  );
  const bridgeButtonsEnabled = Boolean(
    emailActions.approve_bridge_button && emailActions.reject_bridge_button
  );
  const visibleButtonsMarkup = bridgeButtonsEnabled
    ? `${emailActions.approve_bridge_button}${emailActions.reject_bridge_button}`
    : `${emailActions.approve_mailto_button}${emailActions.reject_mailto_button}`;
  const visibleButtonsEnabled = Boolean(visibleButtonsMarkup);
  const tokens = {
    ticket_id: `#${instance.ticket_id}`,
    ticket_subject: instance.ticket_subject,
    ticket_status: instance.ticket_status_label,
    rule_name: rule.name,
    approval_mode: instance.approval_mode === "anyone" ? "Any one approver can approve." : "Every approver must approve.",
    approver_count: String((instance.approvers || []).length),
    approver_email: normalizeText(approver && approver.email),
    approver_name: approverLabel,
    ticket_url: instance.ticket_url,
  };

  const renderedSubject = renderTemplateString(rule.email_subject, tokens);
  const renderedBody = renderTemplateString(rule.email_body, tokens);
  const responderGuide = [
    "How to respond:",
    visibleButtonsEnabled
      ? "Use the approval buttons in this email, or reply with APPROVE or REJECT."
      : "Reply to this email with APPROVE or REJECT.",
    instance.ticket_url ? `Ticket link: ${instance.ticket_url}` : "",
    `Approval request ID: ${instance.id}`,
  ]
    .filter(Boolean)
    .join("\n");

  const bodyText = `${renderedBody}\n\n${responderGuide}`.trim();
  const bodyHtml = [
    '<div style="font-family:Arial,sans-serif;color:#17324d;line-height:1.65;font-size:14px;">',
    `<div>${convertTextToHtml(renderedBody)}</div>`,
    '<div style="margin-top:20px;padding:16px;border:1px solid #d8e2ec;border-radius:14px;background:#f7fbff;">',
    '<strong style="display:block;margin-bottom:8px;font-size:13px;letter-spacing:0.04em;text-transform:uppercase;color:#406384;">How To Respond</strong>',
    visibleButtonsEnabled
      ? '<div style="margin:0 0 10px;">Use a button below, or reply with <strong>APPROVE</strong> or <strong>REJECT</strong>.</div>'
      : '<div style="margin:0 0 8px;">Reply to this email with <strong>APPROVE</strong> or <strong>REJECT</strong>.</div>',
    visibleButtonsEnabled
      ? `<div style="margin:0 0 8px;">${visibleButtonsMarkup}</div>`
      : "",
    instance.ticket_url
      ? `<div style="margin:0 0 8px;"><a href="${escapeHtml(instance.ticket_url)}" style="color:#0b69c7;">Open ticket</a></div>`
      : "",
    `<div style="font-size:12px;color:#62738a;">Approval request ID: ${escapeHtml(instance.id)}</div>`,
    "</div>",
    "</div>",
  ]
    .filter(Boolean)
    .join("");

  return {
    subject: renderedSubject,
    body_text: bodyText,
    body_html: bodyHtml,
    buttons_enabled: visibleButtonsEnabled,
    button_mode: bridgeButtonsEnabled ? "bridge" : mailtoButtonsEnabled ? "mailto" : "none",
  };
}

function normalizeTicketStatusPayloadValue(statusValue) {
  const normalized = normalizeText(statusValue);
  if (!normalized) {
    throw new Error("Ticket status value is required.");
  }

  return /^\d+$/.test(normalized) ? Number(normalized) : normalized;
}

async function addPrivateNote(ticketId, body) {
  try {
    await invokeRequestTemplate("add_ticket_note", {
      context: {
        ticket_id: ticketId,
      },
      body: {
        body,
        private: true,
      },
    });
  } catch (error) {
    logAutomationWarn("add_private_note_failed", {
      ticket_id: Number(ticketId) || 0,
      request_template: normalizeText(error && error.request_template),
      request_context: error && error.request_context ? error.request_context : {},
      error: buildErrorMessage(error, "Failed to add note."),
    });
  }
}

async function updateTicketStatus(ticketId, statusValue) {
  return await invokeRequestTemplate("update_ticket", {
    context: {
      ticket_id: ticketId,
    },
    body: {
      status: normalizeTicketStatusPayloadValue(statusValue),
    },
  });
}

async function appendStatusGuard(guard) {
  const guards = cleanupStatusGuards(await readStatusGuards());
  guards.push(guard);
  await writeStatusGuards(guards);
}

async function clearStatusGuard(ticketId, statusValue) {
  const { guards } = consumeStatusGuard(await readStatusGuards(), ticketId, statusValue);
  await writeStatusGuards(guards);
}

function resolveClosedStatusOption(triggerFieldCatalog) {
  const statusField = triggerFieldCatalog && triggerFieldCatalog.status;
  const options = Array.isArray(statusField && statusField.options) && statusField.options.length
    ? statusField.options
    : DEFAULT_STATUS_OPTIONS;

  const labelMatch = options.find((option) => {
    return normalizeLower(option && option.label) === "closed";
  });
  if (labelMatch) {
    return {
      value: normalizeText(labelMatch.value),
      label: normalizeText(labelMatch.label) || "Closed",
    };
  }

  const lookup = buildOptionLookup("status", options);
  const fallback =
    lookup[normalizeOptionLookupKey("status", DEFAULT_CLOSED_STATUS_VALUE)] ||
    lookup[normalizeOptionLookupKey("status", "Closed")] ||
    null;

  return fallback
    ? {
        value: normalizeText(fallback.value),
        label: normalizeText(fallback.label) || "Closed",
      }
    : null;
}

function applyAutoCloseResultToInstances(instances, result) {
  (Array.isArray(instances) ? instances : []).forEach((instance) => {
    instance.auto_close_state = normalizeText(result && result.state) || "not_attempted";
    instance.auto_close_status = normalizeText(result && result.status_value);
    instance.auto_close_status_label = normalizeText(result && result.status_label);
    instance.auto_close_error = normalizeText(result && result.error);
    instance.auto_close_attempted_at = Number(result && result.attempted_at) || 0;
    instance.auto_closed_at = Number(result && result.closed_at) || 0;
    instance.updated_at = Date.now();
    instance.last_activity_at = instance.updated_at;
  });
}

function buildApprovalCompletionAutoCloseNote(instance, result) {
  const statusLabel = normalizeText(result && result.status_label) || "Closed";

  if (normalizeLower(result && result.state) === "closed") {
    return [
      "<strong>Approvals Automation Pro</strong> completed the approval flow and closed the ticket automatically.",
      `<br>Ticket status moved to: <strong>${escapeHtml(statusLabel)}</strong>.`,
      normalizeText(instance && instance.rule_name)
        ? `<br>Rule: <strong>${escapeHtml(instance.rule_name)}</strong>.`
        : "",
    ].join("");
  }

  if (normalizeLower(result && result.state) === "already_closed") {
    return [
      "<strong>Approvals Automation Pro</strong> completed the approval flow while the ticket was already closed.",
      `<br>Current status: <strong>${escapeHtml(statusLabel)}</strong>.`,
    ].join("");
  }

  if (normalizeLower(result && result.state) === "failed") {
    return [
      "<strong>Approvals Automation Pro</strong> completed the approval flow but could not close the ticket automatically.",
      `<br>Target status: <strong>${escapeHtml(statusLabel)}</strong>.`,
      result && result.error
        ? `<br>Error: ${escapeHtml(result.error)}`
        : "",
    ].join("");
  }

  return "";
}

async function maybeAutoCloseApprovedInstance(instance) {
  if (!instance || normalizeLower(instance.state) !== "approved") {
    return {
      attempted: false,
      note: "",
    };
  }

  if (instance.auto_close_after_approval === false) {
    if (normalizeLower(instance.auto_close_state) !== "disabled") {
      applyAutoCloseResultToInstances([instance], {
        state: "disabled",
        status_value: "",
        status_label: "",
        error: "",
        attempted_at: 0,
        closed_at: 0,
      });
    }

    return {
      attempted: false,
      note: "",
    };
  }

  if (["closed", "already_closed"].includes(normalizeLower(instance.auto_close_state))) {
    return {
      attempted: false,
      note: "",
    };
  }

  let supportData = null;
  try {
    const bundle = await getCachedMetadataBundle();
    supportData = bundle && bundle.supportData;
  } catch (error) {
    logAutomationWarn("approval_completion_auto_close_metadata_failed", {
      ticket_id: Number(instance && instance.ticket_id) || 0,
      instance_id: normalizeText(instance && instance.id),
      error: buildErrorMessage(error, "Metadata fetch failed."),
    });
  }

  const closedStatus = resolveClosedStatusOption(supportData && supportData.trigger_field_catalog);
  const attemptedAt = Date.now();

  if (!closedStatus) {
    const unavailableResult = {
      state: "failed",
      status_value: "",
      status_label: "Closed",
      error: "No Closed status could be resolved for this Freshdesk account.",
      attempted_at: attemptedAt,
      closed_at: 0,
    };
    applyAutoCloseResultToInstances([instance], unavailableResult);
    logAutomationWarn("approval_completion_auto_close_failed", {
      ticket_id: Number(instance && instance.ticket_id) || 0,
      instance_id: normalizeText(instance && instance.id),
      error: unavailableResult.error,
    });
    return {
      attempted: true,
      note: buildApprovalCompletionAutoCloseNote(instance, unavailableResult),
    };
  }

  const guard = createStatusGuard(instance.ticket_id, closedStatus.value, {
    reason: "auto_close_after_approval_complete",
    instance_ids: [instance.id],
  });
  await appendStatusGuard(guard);

  try {
    await updateTicketStatus(instance.ticket_id, closedStatus.value);
    const successResult = {
      state: "closed",
      status_value: closedStatus.value,
      status_label: closedStatus.label,
      error: "",
      attempted_at: attemptedAt,
      closed_at: Date.now(),
    };
    applyAutoCloseResultToInstances([instance], successResult);
    instance.ticket_status = closedStatus.value;
    instance.ticket_status_label = closedStatus.label;
    logAutomationInfo("approval_completion_auto_close_succeeded", {
      ticket_id: Number(instance && instance.ticket_id) || 0,
      instance_id: normalizeText(instance && instance.id),
      target_status: closedStatus,
    });
    return {
      attempted: true,
      note: buildApprovalCompletionAutoCloseNote(instance, successResult),
    };
  } catch (error) {
    await clearStatusGuard(instance.ticket_id, closedStatus.value);
    const failedResult = {
      state: "failed",
      status_value: closedStatus.value,
      status_label: closedStatus.label,
      error: buildErrorMessage(error, "Failed to close the ticket automatically."),
      attempted_at: attemptedAt,
      closed_at: 0,
    };
    applyAutoCloseResultToInstances([instance], failedResult);
    logAutomationWarn("approval_completion_auto_close_failed", {
      ticket_id: Number(instance && instance.ticket_id) || 0,
      instance_id: normalizeText(instance && instance.id),
      target_status: closedStatus,
      request_template: normalizeText(error && error.request_template),
      request_context: error && error.request_context ? error.request_context : {},
      error: failedResult.error,
    });
    return {
      attempted: true,
      note: buildApprovalCompletionAutoCloseNote(instance, failedResult),
    };
  }
}

function buildApprovalEmailPayload(emailContent, approverEmail, senderEmail, includeSenderEmail) {
  const payload = {
    body: emailContent.body_html,
    to_emails: [approverEmail],
  };

  if (includeSenderEmail !== false) {
    const normalizedSenderEmail = normalizeText(senderEmail);
    if (normalizedSenderEmail) {
      payload.from_email = normalizedSenderEmail;
    }
  }

  return payload;
}

function shouldRetryApprovalEmailWithoutSender(error, senderEmail) {
  if (!normalizeText(senderEmail)) {
    return false;
  }

  if (!error || Number(error.status) !== 400) {
    return false;
  }

  const detail = normalizeLower(buildErrorMessage(error, ""));
  return Boolean(detail && detail.includes("validation failed"));
}

async function sendApprovalEmail(rule, instance, actionConfig) {
  const responseIds = [];
  const deliveryErrors = [];
  let lastSubject = "";
  let sentCount = 0;
  let buttonsEnabled = false;
  let buttonMode = "none";

  for (const approver of instance.approvers || []) {
    const emailContent = buildEmailContent(rule, instance, approver, actionConfig);
    const senderEmail = normalizeText(rule && rule.sender_email);
    lastSubject = emailContent.subject || lastSubject;
    buttonsEnabled = buttonsEnabled || Boolean(emailContent.buttons_enabled);
    if (emailContent.button_mode && emailContent.button_mode !== "none") {
      buttonMode = emailContent.button_mode;
    }

    try {
      let response;
      let senderFallbackUsed = false;

      try {
        response = await invokeRequestTemplate("forward_ticket_email", {
          context: {
            ticket_id: instance.ticket_id,
          },
          body: buildApprovalEmailPayload(emailContent, approver.email, senderEmail, true),
        });
      } catch (error) {
        if (!shouldRetryApprovalEmailWithoutSender(error, senderEmail)) {
          throw error;
        }

        logAutomationWarn("approval_email_sender_retry", {
          ticket_id: Number(instance && instance.ticket_id) || 0,
          rule_id: normalizeText(rule && rule.id),
          rule_name: normalizeText(rule && rule.name),
          approver_email: normalizeText(approver && approver.email),
          sender_email: senderEmail,
          request_template: normalizeText(error && error.request_template),
          request_context: error && error.request_context ? error.request_context : {},
          error: buildErrorMessage(error, "Failed to send approval email."),
        });

        response = await invokeRequestTemplate("forward_ticket_email", {
          context: {
            ticket_id: instance.ticket_id,
          },
          body: buildApprovalEmailPayload(emailContent, approver.email, senderEmail, false),
        });
        senderFallbackUsed = true;
      }

      approver.email_delivery_status = "sent";
      approver.email_delivery_error = "";
      approver.email_sent_at = Date.now();
      approver.email_response_id = response && response.id ? response.id : 0;
      approver.email_sender_fallback_used = senderFallbackUsed;
      sentCount += 1;

      if (approver.email_response_id) {
        responseIds.push(approver.email_response_id);
      }
    } catch (error) {
      approver.email_delivery_status = "failed";
      approver.email_delivery_error = buildErrorMessage(
        error,
        `Failed to send approval email to ${approver.email}.`
      );
      approver.email_sent_at = 0;
      approver.email_response_id = 0;
      approver.email_sender_fallback_used = false;
      deliveryErrors.push(approver.email_delivery_error);
      logAutomationWarn("approval_email_failed", {
        ticket_id: Number(instance && instance.ticket_id) || 0,
        rule_id: normalizeText(rule && rule.id),
        rule_name: normalizeText(rule && rule.name),
        approver_email: normalizeText(approver && approver.email),
        sender_email: normalizeText(rule && rule.sender_email),
        request_template: normalizeText(error && error.request_template),
        request_context: error && error.request_context ? error.request_context : {},
        error: approver.email_delivery_error,
      });
    }
  }

  instance.email_status = deliveryErrors.length
    ? sentCount
      ? "partial_failure"
      : "failed"
    : "sent";
  instance.email_error = deliveryErrors.join(" ");
  instance.email_subject = lastSubject;
  instance.updated_at = Date.now();
  instance.last_activity_at = instance.updated_at;
  instance.email_response_ids = responseIds;
  instance.email_sent_count = sentCount;
  instance.email_failed_count = deliveryErrors.length;
  instance.email_buttons_enabled = buttonsEnabled;
  instance.email_button_mode = buttonMode;

  logAutomationInfo("approval_email_result", {
    ticket_id: Number(instance && instance.ticket_id) || 0,
    rule_id: normalizeText(rule && rule.id),
    rule_name: normalizeText(rule && rule.name),
    delivery_mode: "ticket_forward",
    buttons_enabled: buttonsEnabled,
    button_mode: buttonMode,
    email_status: normalizeText(instance.email_status),
    sent_count: sentCount,
    failed_count: deliveryErrors.length,
    sender_email: normalizeText(rule && rule.sender_email),
    approvers: (instance.approvers || []).map((approver) => ({
      email: normalizeText(approver && approver.email),
      delivery_status: normalizeText(approver && approver.email_delivery_status),
      error: normalizeText(approver && approver.email_delivery_error),
    })),
  });

  if (!sentCount) {
    throw new Error(deliveryErrors[0] || "Failed to send approval email.");
  }

  return instance;
}

function summarizeInstance(instance) {
  const approvers = Array.isArray(instance.approvers) ? instance.approvers : [];
  const approvedCount = approvers.filter((approver) => approver.status === "approved").length;
  const rejectedCount = approvers.filter((approver) => approver.status === "rejected").length;
  const rawPendingCount = approvers.filter((approver) => approver.status === "pending").length;
  const pendingCount = instance.state === "pending" ? rawPendingCount : 0;
  const emailSentCount = approvers.filter((approver) => approver.email_delivery_status === "sent").length;
  const emailFailedCount = approvers.filter((approver) => approver.email_delivery_status === "failed").length;
  const publicApprovers = approvers.map((approver) => ({
    email: approver.email,
    label: approver.label,
    type: approver.type,
    status: approver.status,
    responded_at: approver.responded_at,
    decision_source: approver.decision_source,
    email_delivery_status: approver.email_delivery_status,
    email_delivery_error: approver.email_delivery_error,
    email_sent_at: approver.email_sent_at,
  }));

  return {
    ...instance,
    approvers: publicApprovers,
    auto_close_after_approval: instance.auto_close_after_approval !== false,
    approved_count: approvedCount,
    rejected_count: rejectedCount,
    pending_count: pendingCount,
    email_sent_count: Number(instance.email_sent_count || emailSentCount),
    email_failed_count: Number(instance.email_failed_count || emailFailedCount),
    auto_close_state: normalizeText(instance.auto_close_state),
    auto_close_status: normalizeText(instance.auto_close_status),
    auto_close_status_label: normalizeText(instance.auto_close_status_label),
    auto_close_error: normalizeText(instance.auto_close_error),
    auto_close_attempted_at: Number(instance.auto_close_attempted_at || 0),
    auto_closed_at: Number(instance.auto_closed_at || 0),
    created_at_iso: formatDateTime(instance.created_at),
    updated_at_iso: formatDateTime(instance.updated_at),
    last_activity_at_iso: formatDateTime(instance.last_activity_at),
    auto_close_attempted_at_iso: formatDateTime(instance.auto_close_attempted_at),
    auto_closed_at_iso: formatDateTime(instance.auto_closed_at),
  };
}

function buildPendingCounts(instances) {
  const counts = {};

  (Array.isArray(instances) ? instances : []).forEach((instance) => {
    if (instance && instance.state === "pending" && instance.rule_id) {
      counts[instance.rule_id] = (counts[instance.rule_id] || 0) + 1;
    }
  });

  return counts;
}

function parseApprovalDecision(value) {
  const normalized = normalizeLower(value).replace(/\s+/g, " ");
  if (!normalized) {
    return "";
  }

  if (/\b(reject|rejected|decline|declined|deny|denied)\b/.test(normalized)) {
    return "rejected";
  }

  if (/\b(approve|approved|approval|accept|accepted)\b/.test(normalized)) {
    return "approved";
  }

  return "";
}

function extractApprovalRequestId(value) {
  const match = String(value || "").match(/approval request id:\s*([a-z0-9_]+)/i);
  return normalizeText(match && match[1]);
}

function findPendingInstancesByRequestId(instances, approverEmail, instanceId) {
  return (Array.isArray(instances) ? instances : []).filter((instance) => {
    if (!instance || instance.state !== "pending") {
      return false;
    }

    if (instanceId && normalizeText(instance.id) !== normalizeText(instanceId)) {
      return false;
    }

    return (instance.approvers || []).some((approver) => {
      return approver.status === "pending" && normalizeLower(approver.email) === normalizeLower(approverEmail);
    });
  });
}

async function applyApprovalDecision(instances, gates, matchingInstances, approverEmail, decision, source) {
  let changed = false;
  const notes = [];

  for (const instance of Array.isArray(matchingInstances) ? matchingInstances : []) {
    const previousState = instance.state;
    const nextChanged = updateApproverDecision(instance, approverEmail, decision, source);
    changed = nextChanged || changed;

    if (nextChanged) {
      notes.push(buildDecisionAuditNote(instance, approverEmail, decision, source, previousState));
      const gateResult = await syncGateAfterApprovalUpdate(instance, instances, gates);
      if (gateResult.note) {
        notes.push(gateResult.note);
      }
    }
  }

  return {
    changed,
    notes,
  };
}

function findPendingInstancesForTicket(instances, ticketId, approverEmail, instanceId) {
  return (Array.isArray(instances) ? instances : []).filter((instance) => {
    if (!instance || instance.state !== "pending" || Number(instance.ticket_id) !== Number(ticketId)) {
      return false;
    }

    if (instanceId && normalizeText(instance.id) !== normalizeText(instanceId)) {
      return false;
    }

    return (instance.approvers || []).some((approver) => {
      return approver.status === "pending" && normalizeLower(approver.email) === normalizeLower(approverEmail);
    });
  });
}

function updateApproverDecision(instance, approverEmail, decision, source) {
  let changed = false;

  (instance.approvers || []).forEach((approver) => {
    if (normalizeLower(approver.email) !== normalizeLower(approverEmail)) {
      return;
    }

    if (decision === "reset") {
      approver.status = "pending";
      approver.responded_at = 0;
      approver.decision_source = "";
      changed = true;
      return;
    }

    if (approver.status === decision) {
      return;
    }

    approver.status = decision;
    approver.responded_at = Date.now();
    approver.decision_source = source;
    changed = true;
  });

  if (changed) {
    instance.updated_at = Date.now();
    instance.last_activity_at = instance.updated_at;
    recomputeInstanceState(instance);
  }

  return changed;
}

function formatDecisionSource(source) {
  const normalized = normalizeLower(source);

  if (normalized === "email_click") {
    return "one-click email approval";
  }

  if (normalized === "agent_manual") {
    return "manual agent action";
  }

  if (normalized === "email") {
    return "email reply";
  }

  return normalized ? normalized.replace(/_/g, " ") : "automation";
}

function buildDecisionAuditNote(instance, approverEmail, decision, source, previousState) {
  const body = [
    `<strong>Approvals Automation Pro</strong> recorded ${escapeHtml(decision)} from <strong>${escapeHtml(approverEmail)}</strong> via ${escapeHtml(formatDecisionSource(source))}.`,
  ];

  if (normalizeText(previousState) !== normalizeText(instance.state)) {
    body.push(`<br>Approval request is now <strong>${escapeHtml(instance.state)}</strong>.`);
  }

  return body.join("");
}

function listFailedDeliveryEmails(instance) {
  return (instance.approvers || [])
    .filter((approver) => approver.email_delivery_status === "failed")
    .map((approver) => approver.email)
    .join(", ");
}

function findStatusGateById(gates, gateId) {
  return (Array.isArray(gates) ? gates : []).find((gate) => {
    return normalizeText(gate && gate.id) === normalizeText(gateId);
  }) || null;
}

async function revertTicketToPreviousStatus(gate, reason) {
  const previousStatus = normalizeText(gate && gate.previous_status);
  if (!previousStatus) {
    return {
      reverted: false,
      error: new Error("The previous ticket status is unavailable."),
    };
  }

  const guard = createStatusGuard(gate.ticket_id, previousStatus, {
    reason,
    gate_id: gate.id,
    instance_ids: gate.instance_ids,
  });
  await appendStatusGuard(guard);

  try {
    await updateTicketStatus(gate.ticket_id, previousStatus);
    return {
      reverted: true,
      error: null,
    };
  } catch (error) {
    await clearStatusGuard(gate.ticket_id, previousStatus);
    return {
      reverted: false,
      error,
    };
  }
}

async function maybeApplyApprovedGate(gate) {
  if (!gate || normalizeLower(gate.state) !== "approved" || gate.applied_at) {
    return {
      applied: false,
      note: "",
    };
  }

  const requestedStatus = normalizeText(gate.requested_status);
  if (!requestedStatus) {
    gate.state = "apply_failed";
    gate.application_error = "Requested status is unavailable.";
    gate.updated_at = Date.now();
    return {
      applied: false,
      note: buildStatusGateNote(gate, "apply_failed"),
    };
  }

  const guard = createStatusGuard(gate.ticket_id, requestedStatus, {
    reason: "approved_status_apply",
    gate_id: gate.id,
    instance_ids: gate.instance_ids,
  });
  await appendStatusGuard(guard);

  try {
    await updateTicketStatus(gate.ticket_id, requestedStatus);
    gate.state = "applied";
    gate.applied_at = Date.now();
    gate.updated_at = gate.applied_at;
    gate.application_error = "";
    gate.rollback_error = "";
    return {
      applied: true,
      note: buildStatusGateNote(gate, "applied"),
    };
  } catch (error) {
    await clearStatusGuard(gate.ticket_id, requestedStatus);
    gate.state = "apply_failed";
    gate.application_error = buildErrorMessage(
      error,
      "Failed to apply the approved status change automatically."
    );
    gate.updated_at = Date.now();
    return {
      applied: false,
      note: buildStatusGateNote(gate, "apply_failed"),
    };
  }
}

async function syncGateAfterApprovalUpdate(instance, instances, gates) {
  const gate = findStatusGateById(gates, instance && instance.gate_id);
  const notes = [];
  if (gate) {
    const previousGateState = normalizeLower(gate.state);
    recomputeStatusGate(gate, instances);

    if (gate.state === "rejected" && previousGateState !== "rejected") {
      notes.push(buildStatusGateNote(gate, "rejected"));
    }

    if (gate.state === "approved" && !gate.applied_at) {
      const applyResult = await maybeApplyApprovedGate(gate);
      if (applyResult.note) {
        notes.push(applyResult.note);
      }
    }
  }

  const autoCloseResult = await maybeAutoCloseApprovedInstance(instance);
  if (autoCloseResult.note) {
    notes.push(autoCloseResult.note);
  }

  return {
    gate: gate || null,
    note: notes.filter(Boolean).join("<br>"),
  };
}

async function createApprovalRequestForRule(rule, ticket, domain, instances, actionConfig, matchContext, gate) {
  const existingPending = (Array.isArray(instances) ? instances : []).find((instance) => {
    return instance &&
      instance.state === "pending" &&
      Number(instance.ticket_id) === Number(ticket.id) &&
      normalizeText(instance.rule_id) === normalizeText(rule.id) &&
      (
        normalizeText(gate && gate.id)
          ? normalizeText(instance.gate_id) === normalizeText(gate && gate.id)
          : true
      );
  });

  if (existingPending) {
    const shouldRetryEmail =
      ["failed", "queued"].includes(normalizeLower(existingPending.email_status)) ||
      !Number(existingPending.email_sent_count || 0);

    if (shouldRetryEmail) {
      logAutomationInfo("approval_request_retry_existing_pending_email", {
        ticket: summarizeTicketForLog(ticket),
        rule: summarizeRuleForLog(rule),
        gate_id: normalizeText(gate && gate.id),
        existing_instance_id: normalizeText(existingPending.id),
        previous_email_status: normalizeText(existingPending.email_status),
      });

      try {
        await sendApprovalEmail(rule, existingPending, actionConfig);
        await addPrivateNote(
          existingPending.ticket_id,
          `<strong>Approvals Automation Pro</strong> retried the approval email for existing pending request <strong>${escapeHtml(existingPending.id)}</strong>.`
        );
      } catch (error) {
        existingPending.email_status = "failed";
        existingPending.email_error = buildErrorMessage(error, "Failed to resend approval email.");
        existingPending.updated_at = Date.now();
        existingPending.last_activity_at = existingPending.updated_at;
        logAutomationWarn("approval_request_retry_existing_pending_failed", {
          ticket: summarizeTicketForLog(ticket),
          rule: summarizeRuleForLog(rule),
          gate_id: normalizeText(gate && gate.id),
          existing_instance_id: normalizeText(existingPending.id),
          error: normalizeText(existingPending.email_error),
        });
        await addPrivateNote(
          existingPending.ticket_id,
          `<strong>Approvals Automation Pro</strong> could not resend the approval request for existing pending rule <strong>${escapeHtml(rule.name)}</strong>: ${escapeHtml(existingPending.email_error)}`
        );
      }

      return existingPending;
    }

    logAutomationInfo("approval_request_skipped_existing_pending", {
      ticket: summarizeTicketForLog(ticket),
      rule: summarizeRuleForLog(rule),
      gate_id: normalizeText(gate && gate.id),
      existing_instance_id: normalizeText(existingPending.id),
    });
    return null;
  }

  const effectiveMatchContext = matchContext || buildRuleMatchContext(rule, ticket);
  if (!effectiveMatchContext.matched) {
    logAutomationInfo("approval_request_skipped_unmatched_context", {
      ticket: summarizeTicketForLog(ticket),
      rule: summarizeRuleForLog(rule),
      gate_id: normalizeText(gate && gate.id),
      match: summarizeMatchContextForLog(effectiveMatchContext),
    });
    return null;
  }

  const reusableEntryInstance = !gate
    ? findReusableEntryApprovalInstance(instances, rule, ticket.id, effectiveMatchContext.snapshot)
    : null;
  if (reusableEntryInstance) {
    logAutomationInfo("approval_request_skipped_reusable_entry_instance", {
      ticket: summarizeTicketForLog(ticket),
      rule: summarizeRuleForLog(rule),
      existing_instance_id: normalizeText(reusableEntryInstance.id),
      match: summarizeMatchContextForLog(effectiveMatchContext),
    });
    return null;
  }

  const instance = createApprovalInstance(rule, ticket, domain, effectiveMatchContext);
  instance.gate_id = normalizeText(gate && gate.id);
  instance.previous_status = normalizeText(gate && gate.previous_status);
  instance.previous_status_label = normalizeText(gate && gate.previous_status_label);
  instance.requested_status = normalizeText(gate && gate.requested_status);
  instance.requested_status_label =
    normalizeText(gate && gate.requested_status_label) ||
    normalizeText(rule && rule.summary && rule.summary.status_text) ||
    (Array.isArray(rule && rule.status_value_labels) ? rule.status_value_labels.join(" / ") : "");

  logAutomationInfo("approval_rule_matched", {
    ticket: summarizeTicketForLog(ticket),
    rule: summarizeRuleForLog(rule),
    match: summarizeMatchContextForLog(effectiveMatchContext),
    gate_id: normalizeText(gate && gate.id),
    requested_status: normalizeText(instance.requested_status),
    requested_status_label: normalizeText(instance.requested_status_label),
  });

  try {
    await sendApprovalEmail(rule, instance, actionConfig);
    await addPrivateNote(
      instance.ticket_id,
      [
        `<strong>Approvals Automation Pro</strong> sent an approval request for rule <strong>${escapeHtml(rule.name)}</strong>.`,
        effectiveMatchContext.trigger_reason === "entry_conditions"
          ? "<br>Trigger event: the rule entry conditions matched."
          : "<br>Trigger event: the ticket status changed into one of the watched statuses and the rule conditions matched.",
        instance.requested_status_label
          ? `<br>Watched status selection: <strong>${escapeHtml(instance.requested_status_label)}</strong>`
          : "",
        `<br>Approvers: ${escapeHtml((instance.approvers || []).map((approver) => approver.email).join(", "))}`,
        `<br>Mode: ${escapeHtml(instance.approval_mode === "anyone" ? "Anyone can approve" : "Everyone must approve")}`,
        normalizeLower(instance && instance.email_button_mode) === "bridge"
          ? "<br>External approval buttons were included in the outgoing email."
          : normalizeLower(instance && instance.email_button_mode) === "mailto"
            ? "<br>Approval reply buttons were included in the outgoing email."
            : "<br>Recipients can reply with APPROVE or REJECT to record their decision.",
        instance.email_failed_count
          ? `<br>Delivery issues: ${escapeHtml(listFailedDeliveryEmails(instance))}`
          : "",
      ].join("")
    );
  } catch (error) {
    instance.email_status = "failed";
    instance.email_error = buildErrorMessage(error, "Failed to send approval email.");
    instance.updated_at = Date.now();
    instance.last_activity_at = instance.updated_at;
    logAutomationWarn("approval_request_failed", {
      ticket: summarizeTicketForLog(ticket),
      rule: summarizeRuleForLog(rule),
      match: summarizeMatchContextForLog(effectiveMatchContext),
      gate_id: normalizeText(gate && gate.id),
      error: normalizeText(instance.email_error),
    });
    await addPrivateNote(
      instance.ticket_id,
      `<strong>Approvals Automation Pro</strong> could not send the approval request for rule <strong>${escapeHtml(rule.name)}</strong>: ${escapeHtml(instance.email_error)}`
    );
  }

  return instance;
}

async function handleApprovalConversation(args) {
  const conversation = args && args.data && args.data.conversation;
  if (!conversation || !conversation.incoming) {
    return;
  }

  const approverEmail = normalizeText(conversation.from_email);
  const combinedBody = `${normalizeText(conversation.body_text)}\n${normalizeText(conversation.body)}`;
  const decision = parseApprovalDecision(combinedBody);
  const requestId = extractApprovalRequestId(combinedBody);

  if (!approverEmail || !decision) {
    return;
  }

  let [instances, gates] = await Promise.all([readInstances(), readStatusGates()]);
  const matchingInstances = findPendingInstancesForTicket(
    instances,
    conversation.ticket_id,
    approverEmail,
    requestId
  );
  if (!matchingInstances.length) {
    return;
  }

  const applyResult = await applyApprovalDecision(
    instances,
    gates,
    matchingInstances,
    approverEmail,
    decision,
    "email"
  );

  if (!applyResult.changed) {
    return;
  }

  await Promise.all([writeInstances(instances), writeStatusGates(gates)]);
  await addPrivateNote(conversation.ticket_id, applyResult.notes.join("<br>"));
}

async function handleApprovalReplyTicket(args) {
  const ticket = args && args.data && args.data.ticket;
  const requester = args && args.data && args.data.requester;
  if (!ticket) {
    return;
  }

  const approverEmail =
    normalizeText(requester && requester.email) ||
    normalizeText(ticket.email) ||
    normalizeText(ticket.requester_email);
  const combinedText = [
    normalizeText(ticket.subject),
    normalizeText(ticket.description_text),
    normalizeText(ticket.description),
  ].join("\n");
  const decision = parseApprovalDecision(combinedText);
  const requestId = extractApprovalRequestId(combinedText);

  if (!approverEmail || !decision || !requestId) {
    return;
  }

  let [instances, gates] = await Promise.all([readInstances(), readStatusGates()]);
  const matchingInstances = findPendingInstancesByRequestId(instances, approverEmail, requestId);
  if (!matchingInstances.length) {
    logAutomationInfo("approval_email_reply_ticket_no_match", {
      reply_ticket_id: Number(ticket && ticket.id) || 0,
      approver_email: approverEmail,
      request_id: requestId,
    });
    return;
  }

  const applyResult = await applyApprovalDecision(
    instances,
    gates,
    matchingInstances,
    approverEmail,
    decision,
    "email"
  );
  if (!applyResult.changed) {
    return;
  }

  await Promise.all([writeInstances(instances), writeStatusGates(gates)]);

  await Promise.all(
    matchingInstances.map((instance) => {
      return addPrivateNote(instance.ticket_id, applyResult.notes.join("<br>"));
    })
  );

  logAutomationInfo("approval_email_reply_ticket_processed", {
    reply_ticket_id: Number(ticket && ticket.id) || 0,
    request_id: requestId,
    approver_email: approverEmail,
    decision,
    matched_instance_ids: matchingInstances.map((instance) => normalizeText(instance && instance.id)),
    original_ticket_ids: dedupeStrings(matchingInstances.map((instance) => String(Number(instance && instance.ticket_id) || 0))),
  });
}

function parseExternalEventData(data) {
  if (!data) {
    return {};
  }

  if (typeof data === "object") {
    return data;
  }

  if (typeof data === "string") {
    try {
      const parsed = JSON.parse(data);
      if (parsed && typeof parsed === "object") {
        return parsed;
      }
    } catch {
      // Fall back to parsing form-encoded payloads.
    }

    const parsedFormData = parseFormEncodedData(data);
    const entries = Object.entries(parsedFormData);
    if (entries.length) {
      return parsedFormData;
    }
  }

  return {};
}

function resolveExternalApprovalToken(args) {
  const data = parseExternalEventData(args && args.data);
  return normalizeText(
    (data && (data.approval_token || data.token || data.approvalToken)) || (args && args.options)
  );
}

function findPendingApprovalAction(instances, token) {
  const normalizedToken = normalizeText(token);
  if (!normalizedToken) {
    return null;
  }

  const decodedToken = decodeApprovalActionToken(normalizedToken);
  if (decodedToken) {
    const matchedInstance = (Array.isArray(instances) ? instances : []).find((instance) => {
      return instance &&
        instance.state === "pending" &&
        normalizeText(instance.id) === normalizeText(decodedToken.instance_id);
    });

    if (matchedInstance) {
      const matchedApprover = (matchedInstance.approvers || []).find((approver) => {
        return approver &&
          approver.status === "pending" &&
          normalizeLower(approver.email) === normalizeLower(decodedToken.approver_email);
      });

      if (matchedApprover) {
        return {
          instance: matchedInstance,
          approver: matchedApprover,
          decision: decodedToken.decision,
        };
      }
    }
  }

  for (const instance of Array.isArray(instances) ? instances : []) {
    if (!instance || instance.state !== "pending") {
      continue;
    }

    for (const approver of instance.approvers || []) {
      if (!approver || approver.status !== "pending") {
        continue;
      }

      const actionTokens = approver.action_tokens || {};
      if (normalizeText(actionTokens.approved) === normalizedToken) {
        return { instance, approver, decision: "approved" };
      }

      if (normalizeText(actionTokens.rejected) === normalizedToken) {
        return { instance, approver, decision: "rejected" };
      }
    }
  }

  return null;
}

async function handleApprovalActionEvent(args) {
  const token = resolveExternalApprovalToken(args);
  if (!token) {
    logAutomationInfo("approval_email_action_missing_token", {});
    return {
      success: false,
      processed: false,
      message: "The approval action token is missing.",
    };
  }

  let [instances, gates] = await Promise.all([readInstances(), readStatusGates()]);
  const actionMatch = findPendingApprovalAction(instances, token);
  if (!actionMatch) {
    logAutomationInfo("approval_email_action_not_found", {
      token_prefix: token.slice(0, 10),
    });
    return {
      success: false,
      processed: false,
      message: "This approval action link has expired or was already used.",
    };
  }

  const { instance, approver, decision } = actionMatch;
  const approverEmail = normalizeText(approver && approver.email);
  const previousState = instance.state;
  const changed = updateApproverDecision(instance, approverEmail, decision, "email_click");
  if (!changed) {
    logAutomationInfo("approval_email_action_no_change", {
      ticket_id: Number(instance && instance.ticket_id) || 0,
      instance_id: normalizeText(instance && instance.id),
      approver_email: approverEmail,
      decision,
      state: normalizeText(instance && instance.state),
    });
    return {
      success: false,
      processed: false,
      ticket_id: Number(instance && instance.ticket_id) || 0,
      instance_id: normalizeText(instance && instance.id),
      decision,
      state: normalizeText(instance && instance.state),
      message: "This approval action was already processed.",
    };
  }

  const notes = [
    buildDecisionAuditNote(instance, approverEmail, decision, "email_click", previousState),
  ];
  const gateResult = await syncGateAfterApprovalUpdate(instance, instances, gates);
  if (gateResult.note) {
    notes.push(gateResult.note);
  }

  await Promise.all([writeInstances(instances), writeStatusGates(gates)]);
  await addPrivateNote(instance.ticket_id, notes.join("<br>"));

  logAutomationInfo("approval_email_action_recorded", {
    ticket_id: Number(instance && instance.ticket_id) || 0,
    instance_id: normalizeText(instance && instance.id),
    approver_email: approverEmail,
    decision,
    state: normalizeText(instance && instance.state),
  });

  return {
    success: true,
    processed: true,
    ticket_id: Number(instance && instance.ticket_id) || 0,
    instance_id: normalizeText(instance && instance.id),
    decision,
    state: normalizeText(instance && instance.state),
    message: decision === "approved" ? "Approval recorded." : "Rejection recorded.",
  };
}

async function recordSidebarApprovalDecision(payload) {
  const ticketId = Number(payload && payload.ticket_id);
  const instanceId = normalizeText(payload && payload.instance_id);
  const agentEmail = normalizeText(payload && payload.agent_email);
  const decision = parseApprovalDecision(payload && payload.decision);
  const agentName = normalizeText(payload && payload.agent_name);

  if (!ticketId) {
    throw new Error("Ticket id is required.");
  }

  if (!instanceId) {
    throw new Error("Approval instance id is required.");
  }

  if (!agentEmail) {
    throw new Error("Agent email is required.");
  }

  if (!decision) {
    throw new Error("A valid approval decision is required.");
  }

  let [instances, gates] = await Promise.all([readInstances(), readStatusGates()]);
  const currentInstance = (instances || []).find((instance) => {
    return instance &&
      normalizeText(instance.id) === instanceId &&
      Number(instance.ticket_id) === ticketId;
  });

  if (!currentInstance) {
    throw new Error("The approval request could not be found for this ticket.");
  }

  if (normalizeLower(currentInstance.state) !== "pending") {
    throw new Error("This approval request is already completed.");
  }

  const approver = (currentInstance.approvers || []).find((item) => {
    return normalizeLower(item && item.email) === normalizeLower(agentEmail);
  });

  if (!approver) {
    throw new Error("The logged-in agent is not assigned as an approver for this ticket.");
  }

  if (normalizeLower(approver.status) !== "pending") {
    throw new Error("This approver has already responded.");
  }

  const previousState = currentInstance.state;
  const changed = updateApproverDecision(currentInstance, agentEmail, decision, "agent_manual");
  if (!changed) {
    throw new Error("No approval state change was recorded.");
  }

  const notes = [
    buildDecisionAuditNote(currentInstance, agentEmail, decision, "agent_manual", previousState),
  ];
  const gateResult = await syncGateAfterApprovalUpdate(currentInstance, instances, gates);
  if (gateResult.note) {
    notes.push(gateResult.note);
  }

  await Promise.all([writeInstances(instances), writeStatusGates(gates)]);
  await addPrivateNote(ticketId, notes.join("<br>"));

  logAutomationInfo("sidebar_approval_decision_recorded", {
    ticket_id: ticketId,
    instance_id: normalizeText(currentInstance.id),
    decision,
    agent_email: agentEmail,
    agent_name: agentName,
    state: normalizeText(currentInstance.state),
  });

  return summarizeInstance(currentInstance);
}

function buildReusableApprovalAppliedNote(statusChange, instances) {
  const ruleNames = dedupeStrings((instances || []).map((instance) => instance && instance.rule_name)).join(", ");
  return [
    "<strong>Approvals Automation Pro</strong> skipped creating a new approval request because approval was already completed for this ticket snapshot.",
    statusChange && statusChange.requested_status_label
      ? `<br>Matched status: <strong>${escapeHtml(statusChange.requested_status_label)}</strong>.`
      : "",
    ruleNames
      ? `<br>Approved rule${ruleNames.includes(",") ? "s" : ""}: <strong>${escapeHtml(ruleNames)}</strong>.`
      : "",
  ].join("");
}

async function processTicketApprovalTrigger(options) {
  const ticket = options && options.ticket;
  const source = normalizeText(options && options.source) || "ticket_update";
  const eventData = options && options.event_data && typeof options.event_data === "object"
    ? options.event_data
    : {};

  if (!ticket) {
    logAutomationWarn("ticket_trigger_missing_ticket", {
      source,
      event_data: eventData,
    });
    return {
      processed: false,
      reason: "missing_ticket",
      created_instances: 0,
    };
  }

  const changeKeys = extractTicketChangeKeys(ticket);
  logAutomationInfo("ticket_trigger_received", {
    source,
    ticket: summarizeTicketForLog(ticket),
    change_keys: changeKeys,
    raw_changes: ticket.changes || {},
    event_data: eventData,
  });

  if (!hasTicketChanges(ticket)) {
    logAutomationInfo("ticket_trigger_skipped_no_changes", {
      source,
      ticket: summarizeTicketForLog(ticket),
    });
    return {
      processed: false,
      reason: "no_changes",
      created_instances: 0,
      ticket_id: Number(ticket.id) || 0,
    };
  }

  const rules = (await readRules()).filter((rule) => rule.active !== false);
  if (!rules.length) {
    logAutomationInfo("ticket_trigger_skipped_no_active_rules", {
      source,
      ticket: summarizeTicketForLog(ticket),
      change_keys: changeKeys,
    });
    return {
      processed: false,
      reason: "no_active_rules",
      created_instances: 0,
      ticket_id: Number(ticket.id) || 0,
    };
  }

  const ruleEvaluations = rules.map((rule) => summarizeRuleEvaluationForLog(rule, ticket));
  const statusChanged = hasStatusChange(ticket);
  const matchedRules = statusChanged ? buildMatchedRuleContexts(rules, ticket) : [];
  const matchedEntryRules = buildMatchedEntryRuleContexts(rules, ticket);

  if (!matchedRules.length && !matchedEntryRules.length) {
    logAutomationInfo("ticket_trigger_skipped_no_rule_match", {
      source,
      ticket: summarizeTicketForLog(ticket),
      change_keys: changeKeys,
      status_changed: statusChanged,
      rule_evaluations: ruleEvaluations,
    });
    return {
      processed: false,
      reason: "no_rule_match",
      created_instances: 0,
      ticket_id: Number(ticket.id) || 0,
      status_changed: statusChanged,
    };
  }

  logAutomationInfo("ticket_update_matches_detected", {
    source,
    ticket: summarizeTicketForLog(ticket),
    status_changed: statusChanged,
    status_change: statusChanged ? extractStatusChange(ticket) : {},
    status_change_matches: matchedRules.map((item) => ({
      rule: summarizeRuleForLog(item.rule),
      match: summarizeMatchContextForLog(item.matchContext),
    })),
    entry_condition_matches: matchedEntryRules.map((item) => ({
      rule: summarizeRuleForLog(item.rule),
      match: summarizeMatchContextForLog(item.matchContext),
    })),
    rule_evaluations: ruleEvaluations,
  });

  if (!matchedRules.length && matchedEntryRules.length) {
    let [instances, gates] = await Promise.all([
      readInstances(),
      readStatusGates(),
    ]);
    if (findOpenStatusGate(gates, ticket.id)) {
      logAutomationInfo("entry_match_skipped_existing_gate", {
        source,
        ticket: summarizeTicketForLog(ticket),
      });
      return {
        processed: false,
        reason: "entry_match_existing_gate",
        created_instances: 0,
        ticket_id: Number(ticket.id) || 0,
      };
    }

    let actionConfig = await readRuntimeConfig();
    try {
      actionConfig = await initializeApprovalRuntimeConfig(false);
    } catch (error) {
      console.error("Unable to initialize approval action callback:", buildErrorMessage(error, "Approval action setup failed."));
    }

    const latestMatchedEntryRule = matchedEntryRules[0];
    const createdInstances = [];
    const nextInstance = await createApprovalRequestForRule(
      latestMatchedEntryRule.rule,
      ticket,
      options && options.domain,
      instances,
      actionConfig,
      latestMatchedEntryRule.matchContext,
      null
    );
    if (nextInstance) {
      instances = replaceTicketApprovalInstance(instances, nextInstance);
      createdInstances.push(nextInstance);
    }

    if (!createdInstances.length) {
      logAutomationInfo("ticket_trigger_skipped_no_instances_created", {
        source,
        ticket: summarizeTicketForLog(ticket),
        matched_rule_ids: matchedEntryRules.map((item) => normalizeText(item.rule && item.rule.id)),
        reason: "entry_rules_skipped_after_match",
      });
      return {
        processed: false,
        reason: "entry_rules_skipped_after_match",
        created_instances: 0,
        ticket_id: Number(ticket.id) || 0,
      };
    }

    await writeInstances(instances);
    logAutomationInfo("entry_match_instances_saved", {
      source,
      ticket: summarizeTicketForLog(ticket),
      created_instances: createdInstances.length,
      created_instance_ids: createdInstances.map((instance) => normalizeText(instance.id)),
      auto_close: {
        state: "not_attempted",
        status: "",
        error: "",
      },
    });
    return {
      processed: true,
      reason: "entry_match_instances_saved",
      created_instances: createdInstances.length,
      created_instance_ids: createdInstances.map((instance) => normalizeText(instance.id)),
      ticket_id: Number(ticket.id) || 0,
    };
  }

  const statusChange = extractStatusChange(ticket);
  const rawGuards = await readStatusGuards();
  const cleanedGuards = cleanupStatusGuards(rawGuards);
  const { guard, guards: remainingGuards } = consumeStatusGuard(
    cleanedGuards,
    ticket.id,
    statusChange.requested_status
  );

  if (guard || remainingGuards.length !== rawGuards.length) {
    await writeStatusGuards(remainingGuards);
  }

  if (guard) {
    logAutomationInfo("ticket_trigger_skipped_status_guard_consumed", {
      source,
      ticket: summarizeTicketForLog(ticket),
      status_change: statusChange,
      guard_id: normalizeText(guard.id),
      guard_reason: normalizeText(guard.reason),
    });
    return {
      processed: false,
      reason: "status_guard_consumed",
      created_instances: 0,
      ticket_id: Number(ticket.id) || 0,
    };
  }

  let [instances, gates] = await Promise.all([readInstances(), readStatusGates()]);
  const existingGate = findOpenStatusGate(gates, ticket.id, statusChange.requested_status);
  if (existingGate) {
    if (normalizeLower(existingGate.state) === "pending") {
      const revertResult = await revertTicketToPreviousStatus(existingGate, "pending_retry_revert");
      if (revertResult.reverted) {
        await addPrivateNote(ticket.id, buildStatusGateNote(existingGate, "pending_retry"));
      } else {
        existingGate.rollback_error = buildErrorMessage(
          revertResult.error,
          "Failed to restore the previous ticket status."
        );
        existingGate.updated_at = Date.now();
        await writeStatusGates(gates);
        await addPrivateNote(ticket.id, buildStatusGateNote(existingGate, "revert_failed"));
      }
      logAutomationInfo("ticket_trigger_existing_gate_pending", {
        source,
        ticket: summarizeTicketForLog(ticket),
        status_change: statusChange,
        gate_id: normalizeText(existingGate.id),
        reverted: Boolean(revertResult.reverted),
        error: buildErrorMessage(revertResult.error, ""),
      });
      return {
        processed: false,
        reason: "existing_pending_gate",
        created_instances: 0,
        ticket_id: Number(ticket.id) || 0,
      };
    }

    existingGate.state = "applied";
    existingGate.applied_at = existingGate.applied_at || Date.now();
    existingGate.updated_at = existingGate.applied_at;
    existingGate.application_error = "";
    existingGate.rollback_error = "";
    await writeStatusGates(gates);
    logAutomationInfo("ticket_trigger_existing_gate_applied", {
      source,
      ticket: summarizeTicketForLog(ticket),
      status_change: statusChange,
      gate_id: normalizeText(existingGate.id),
    });
    return {
      processed: true,
      reason: "existing_gate_applied",
      created_instances: 0,
      ticket_id: Number(ticket.id) || 0,
    };
  }

  const reusableEntryMatches = matchedRules.slice(0, 1).map((matchedRule) => ({
    ...matchedRule,
    instance: findReusableEntryApprovalInstance(
      instances,
      matchedRule.rule,
      ticket.id,
      matchedRule.matchContext.snapshot
    ),
  }));

  if (reusableEntryMatches.length && reusableEntryMatches.every((item) => item.instance && item.instance.state === "approved")) {
    reusableEntryMatches.forEach((item) => {
      consumeReusableApprovalInstance(item.instance, statusChange);
    });
    await writeInstances(instances);
    await addPrivateNote(ticket.id, buildReusableApprovalAppliedNote(
      statusChange,
      reusableEntryMatches.map((item) => item.instance)
    ));
    logAutomationInfo("ticket_trigger_reused_approved_entry_instances", {
      source,
      ticket: summarizeTicketForLog(ticket),
      status_change: statusChange,
      instance_ids: reusableEntryMatches.map((item) => normalizeText(item.instance && item.instance.id)),
    });
    return {
      processed: true,
      reason: "reused_approved_entry_instances",
      created_instances: 0,
      ticket_id: Number(ticket.id) || 0,
    };
  }

  let actionConfig = await readRuntimeConfig();
  try {
    actionConfig = await initializeApprovalRuntimeConfig(false);
  } catch (error) {
    console.error("Unable to initialize approval action callback:", buildErrorMessage(error, "Approval action setup failed."));
  }

  const createdInstances = [];
  const latestMatchedRule = reusableEntryMatches[0];
  const nextInstance = latestMatchedRule
    ? await createApprovalRequestForRule(
        latestMatchedRule.rule,
        ticket,
        options && options.domain,
        instances,
        actionConfig,
        latestMatchedRule.matchContext,
        null
      )
    : null;
  if (nextInstance) {
    instances = replaceTicketApprovalInstance(instances, nextInstance);
    createdInstances.push(nextInstance);
  }

  if (!createdInstances.length) {
    logAutomationInfo("ticket_trigger_skipped_no_instances_created", {
      source,
      ticket: summarizeTicketForLog(ticket),
      matched_rule_ids: reusableEntryMatches.map((item) => normalizeText(item.rule && item.rule.id)),
      reason: "status_rules_skipped_after_match",
    });
    return {
      processed: false,
      reason: "status_rules_skipped_after_match",
      created_instances: 0,
      ticket_id: Number(ticket.id) || 0,
    };
  }

  await writeInstances(instances);
  logAutomationInfo("status_match_instances_saved", {
    source,
    ticket: summarizeTicketForLog(ticket),
    status_change: statusChange,
    created_instances: createdInstances.length,
    created_instance_ids: createdInstances.map((instance) => normalizeText(instance.id)),
    auto_close: {
      state: "not_attempted",
      status: "",
      error: "",
    },
  });
  return {
    processed: true,
    reason: "status_match_instances_saved",
    created_instances: createdInstances.length,
    created_instance_ids: createdInstances.map((instance) => normalizeText(instance.id)),
    ticket_id: Number(ticket.id) || 0,
  };
}

exports = {
  getApprovalDashboardData: async function () {
    try {
      const [{ metadata, supportData, fullMetadata }, rules, instances] = await Promise.all([
        getCachedMetadataBundle(),
        readRules(),
        readInstances(),
      ]);

      const pendingCounts = buildPendingCounts(instances);
      const recentInstances = sortRules(instances).slice(0, 20).map(summarizeInstance);
      const customTriggerFields = (supportData.trigger_fields || [])
        .filter((field) => !BUILT_IN_TRIGGER_FIELD_IDS.has(normalizeLower(field && field.id)))
        .map((field) => ({
          id: normalizeText(field.id),
          label: normalizeText(field.label),
          type: normalizeText(field.type),
          option_count: Array.isArray(field.options) ? field.options.length : 0,
        }))
        .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));

      logAutomationInfo("approval_dashboard_trigger_fields_loaded", {
        rule_count: rules.length,
        recent_instance_count: recentInstances.length,
        trigger_field_count: Array.isArray(supportData.trigger_fields) ? supportData.trigger_fields.length : 0,
        field_catalog_count: Object.keys((fullMetadata && fullMetadata.field_catalog) || {}).length,
        custom_trigger_field_count: customTriggerFields.length,
        custom_trigger_fields: customTriggerFields.slice(0, CUSTOM_FIELD_DEBUG_SAMPLE_LIMIT),
      });

      return buildResponse({
        success: true,
        rule_count: rules.length,
        rules: sortRules(rules).map((rule) => mapRuleForClient(rule, pendingCounts)),
        trigger_fields: supportData.trigger_fields,
        sender_emails: supportData.sender_emails,
        approver_agent_options: supportData.approver_agent_options,
        recent_instances: recentInstances,
        helper: {
          email_placeholders: [
            "{{ticket_id}}",
            "{{ticket_subject}}",
            "{{ticket_status}}",
            "{{rule_name}}",
            "{{approval_mode}}",
            "{{approver_count}}",
            "{{approver_email}}",
            "{{approver_name}}",
            "{{ticket_url}}",
          ],
        },
        field_catalog: (fullMetadata && fullMetadata.field_catalog) || metadata.field_catalog,
      });
    } catch (error) {
      return buildErrorResponse("Failed to load Approvals Automation Pro dashboard data.", error);
    }
  },

  saveApprovalRule: async function (args) {
    let phase = "parse_args";
    try {
      const payload = parseArgs(args);
      phase = "load_metadata";
      const { supportData } = await getCachedMetadataBundle();
      phase = "read_rules";
      const rules = await readRules();
      phase = "read_instances";
      const [instances, gates] = await Promise.all([readInstances(), readStatusGates()]);
      phase = "locate_existing_rule";
      const existingRule = rules.find((rule) => rule.id === payload.id) || null;
      phase = "sanitize_rule";
      const sanitizedRule = sanitizeRulePayload(payload, supportData, existingRule);
      phase = "compose_next_rules";
      const nextRules = [
        sanitizedRule,
        ...rules.filter((rule) => rule.id !== sanitizedRule.id),
      ];

      phase = "sync_pending_instances";
      const syncResult = await syncPendingApprovalInstancesForRule(
        sanitizedRule,
        instances,
        gates
      );
      phase = "write_records";
      await Promise.all([
        writeRules(sortRules(nextRules)),
        syncResult.changed ? writeInstances(instances) : Promise.resolve(),
        syncResult.changed ? writeStatusGates(gates) : Promise.resolve(),
      ]);
      phase = "write_sync_notes";
      if (syncResult.notes.length) {
        await Promise.all(
          syncResult.notes.map((note) => addPrivateNote(note.ticket_id, note.body))
        );
      }
      phase = "build_response";

      if (syncResult.changed) {
        logAutomationInfo("approval_rule_pending_instances_synced", {
          rule_id: normalizeText(sanitizedRule.id),
          rule_name: normalizeText(sanitizedRule.name),
          updated_instances: syncResult.updates.length,
          updates: syncResult.updates,
        });
      }

      return buildResponse({
        success: true,
        rule: mapRuleForClient(sanitizedRule, {}),
        synced_instances: syncResult.updates.length,
      });
    } catch (error) {
      const detail = `[${phase}] ${buildErrorMessage(error, "Failed to save the approval rule.")}`;
      console.error("saveApprovalRule failed:", detail);
      return buildErrorResponse("Failed to save the approval rule.", {
        message: detail,
      });
    }
  },

  deleteApprovalRule: async function (args) {
    try {
      const payload = parseArgs(args);
      const ruleId = normalizeText(payload.id);
      if (!ruleId) {
        throw new Error("Rule id is required.");
      }

      const rules = await readRules();
      const existingRule = rules.find((rule) => rule.id === ruleId);
      if (!existingRule) {
        throw new Error("Rule not found.");
      }

      const [instances, gates, guards] = await Promise.all([
        readInstances(),
        readStatusGates(),
        readStatusGuards(),
      ]);
      const deletedInstances = (instances || []).filter((instance) => {
        return normalizeText(instance && instance.rule_id) === ruleId;
      });
      const affectedTicketIds = new Set(
        deletedInstances
          .map((instance) => Number(instance && instance.ticket_id))
          .filter(Boolean)
      );

      await Promise.all([
        writeRules(rules.filter((rule) => rule.id !== ruleId)),
        writeInstances((instances || []).filter((instance) => {
          return normalizeText(instance && instance.rule_id) !== ruleId;
        })),
        writeStatusGates((gates || []).filter((gate) => {
          return !affectedTicketIds.has(Number(gate && gate.ticket_id));
        })),
        writeStatusGuards((guards || []).filter((guard) => {
          return !affectedTicketIds.has(Number(guard && guard.ticket_id));
        })),
      ]);

      return buildResponse({
        success: true,
        id: ruleId,
      });
    } catch (error) {
      return buildErrorResponse("Failed to delete the approval rule.", error);
    }
  },

  syncLiveTicketFieldMetadata: async function (args) {
    try {
      const payload = parseArgs(args);
      const incomingFields = Array.isArray(payload && payload.fields) ? payload.fields : [];
      const existingFields = await readLiveFieldMetadata();
      const mergedFields = mergeLiveMetadataIntoRoots(existingFields, incomingFields);

      await writeLiveFieldMetadata(mergedFields);
      invalidateMetadataCache();

      const syncedFields = mergedFields
        .filter((field) => !BUILT_IN_TRIGGER_FIELD_IDS.has(normalizeLower(field && field.name)))
        .map((field) => ({
          name: normalizeText(field && field.name),
          label: normalizeText(field && field.label),
          type: normalizeText(field && field.type),
          option_count: Array.isArray(field && field.options) ? field.options.length : 0,
        }))
        .sort((left, right) => left.label.localeCompare(right.label, undefined, { sensitivity: "base" }));

      logAutomationInfo("approval_live_field_metadata_synced", {
        ticket_id: Number(payload && payload.ticket_id) || 0,
        incoming_field_count: incomingFields.length,
        stored_field_count: mergedFields.length,
        custom_field_count: syncedFields.length,
        custom_fields: syncedFields.slice(0, CUSTOM_FIELD_DEBUG_SAMPLE_LIMIT),
      });

      return buildResponse({
        success: true,
        stored_field_count: mergedFields.length,
      });
    } catch (error) {
      return buildErrorResponse("Failed to sync live ticket field metadata.", error);
    }
  },

  getTicketApprovalData: async function (args) {
    try {
      const payload = parseArgs(args);
      const ticketId = Number(payload.ticket_id);
      if (!ticketId) {
        throw new Error("Ticket id is required.");
      }

      const [rules, instances] = await Promise.all([readRules(), readInstances()]);
      const ruleMap = Object.fromEntries((rules || []).map((rule) => [rule.id, rule]));
      const currentInstance = (instances || [])
        .filter((instance) => {
          return Number(instance && instance.ticket_id) === ticketId &&
            Boolean(ruleMap[normalizeText(instance && instance.rule_id)]);
        })
        .sort((left, right) => Number(right.updated_at || 0) - Number(left.updated_at || 0))[0] || null;

      const ticketInstances = currentInstance
        ? [
            summarizeInstance({
              ...currentInstance,
              rule_active: ruleMap[currentInstance.rule_id]
                ? ruleMap[currentInstance.rule_id].active !== false
                : false,
            }),
          ]
        : [];

      return buildResponse({
        success: true,
        ticket_id: ticketId,
        instances: ticketInstances,
      });
    } catch (error) {
      return buildErrorResponse("Failed to load ticket approval data.", error);
    }
  },

  evaluateTicketApprovalTrigger: async function (args) {
    let phase = "parse_args";
    try {
      const payload = parseArgs(args);
      phase = "extract_ticket";
      const rawTicket =
        (payload && payload.ticket && typeof payload.ticket === "object" && payload.ticket) ||
        (payload && payload.data && payload.data.ticket && typeof payload.data.ticket === "object" && payload.data.ticket) ||
        null;
      phase = "sanitize_ticket";
      const ticket = sanitizeTicketForTriggerEvaluation(rawTicket);
      const syntheticChanges = payload && payload.changes && typeof payload.changes === "object"
        ? payload.changes
        : {};

      if (ticket) {
        phase = "merge_changes";
        ticket.changes = {
          ...(ticket && ticket.changes && typeof ticket.changes === "object" ? ticket.changes : {}),
          ...syntheticChanges,
        };
      }

      phase = "process_trigger";
      const result = await processTicketApprovalTrigger({
        ticket,
        domain: normalizeText(payload && payload.domain) || normalizeText(args && args.domain),
        source: normalizeText(payload && payload.source) || "manual_invoke",
        event_data: payload && payload.event_data,
      });

      phase = "build_response";
      return buildResponse({
        success: true,
        ...result,
      });
    } catch (error) {
      const detail = `[${phase}] ${buildErrorMessage(error, "Trigger evaluation failed.")}`;
      console.error("evaluateTicketApprovalTrigger failed:", detail);
      return buildResponse({
        success: false,
        message: "Failed to evaluate the approval trigger.",
        detail,
      });
    }
  },

  submitSidebarApprovalDecision: async function (args) {
    let phase = "parse_args";
    try {
      const payload = parseArgs(args);
      phase = "record_sidebar_decision";
      const instance = await recordSidebarApprovalDecision(payload);
      phase = "build_response";
      return buildResponse({
        success: true,
        instance,
      });
    } catch (error) {
      const detail = `[${phase}] ${buildErrorMessage(error, "Failed to record the approval decision.")}`;
      console.error("submitSidebarApprovalDecision failed:", detail);
      return buildResponse({
        success: false,
        message: "Failed to record the approval decision.",
        detail,
      });
    }
  },

  onTicketUpdateHandler: async function (args) {
    try {
      await processTicketApprovalTrigger({
        ticket: args && args.data && args.data.ticket,
        domain: args && args.domain,
        source: "onTicketUpdate",
        runtime_args: args,
      });
    } catch (error) {
      console.error("onTicketUpdateHandler failed:", buildErrorMessage(error, "Ticket update handler failed."));
    }
  },

  onTicketCreateHandler: async function (args) {
    try {
      await handleApprovalReplyTicket(args);
    } catch (error) {
      console.error("onTicketCreateHandler failed:", buildErrorMessage(error, "Ticket create handler failed."));
    }
  },

  onConversationCreateHandler: async function (args) {
    try {
      await handleApprovalConversation(args);
    } catch (error) {
      console.error("onConversationCreateHandler failed:", buildErrorMessage(error, "Conversation handler failed."));
    }
  },

  onAppInstallHandler: async function () {
    try {
      await initializeApprovalRuntimeConfig(true);
      renderData();
    } catch (error) {
      console.error("onAppInstallHandler failed:", buildErrorMessage(error, "App install setup failed."));
      renderData({
        message: "Unable to initialize approval email actions during installation.",
      });
    }
  },

  onExternalEventHandler: async function (args) {
    try {
      const result = await handleApprovalActionEvent(args);
      return buildResponse(result || {
        success: false,
        processed: false,
        message: "No approval action was processed.",
      });
    } catch (error) {
      const detail = buildErrorMessage(error, "External approval action failed.");
      console.error("onExternalEventHandler failed:", detail);
      return buildResponse({
        success: false,
        processed: false,
        message: "External approval action failed.",
        detail,
      });
    }
  },
};
