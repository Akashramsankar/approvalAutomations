let client;
const BUILD_ID = "2026-04-12-live-field-runtime-r1";
const INVOKE_TIMEOUT_MS = 15000;

const state = {
  ticketId: 0,
  syncSignature: "",
};

document.addEventListener("DOMContentLoaded", init);

async function init() {
  try {
    console.log(`[ApprovalsAutomation] runtime_build_loaded ${BUILD_ID}`);
    client = await app.initialized();
    await syncLiveFieldMetadata({ force: true });

    client.events.on("app.activated", () => {
      void syncLiveFieldMetadata({ force: true });
    });

    client.events.on("ticket.propertiesUpdated", () => {
      window.setTimeout(() => {
        void syncLiveFieldMetadata({ force: true });
      }, 1000);
    });
  } catch (error) {
    console.error("Failed to initialize runtime field sync:", error);
  }
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

function buildSyncSignature(ticket) {
  return [
    normalizeText(ticket && ticket.id),
    ...getTicketCustomFieldKeys(ticket).sort(),
  ].join("|");
}

function buildFieldOptionsObjectNames(fieldName) {
  if (fieldName === "ticket_type") {
    return ["ticket_type_options", "type_options"];
  }

  return [`${fieldName}_options`];
}

async function fetchFieldOptions(fieldName) {
  const objectNames = buildFieldOptionsObjectNames(fieldName);

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
    } catch (error) {
      console.warn("[ApprovalsAutomation] runtime_field_options_failed", {
        ticket_id: state.ticketId,
        field_name: fieldName,
        object_name: objectName,
        error: resolveErrorMessage(error, "Unable to load field options."),
      });
    }
  }

  return [];
}

async function buildLiveFields(ticket) {
  const fieldNames = Array.from(new Set([
    "status",
    "priority",
    "ticket_type",
    ...getTicketCustomFieldKeys(ticket),
  ]));

  const liveFields = [];
  for (const fieldName of fieldNames) {
    const options = await fetchFieldOptions(fieldName);
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
      source: "ticket_background_live",
      updated_at: Date.now(),
    });
  }

  return liveFields;
}

async function syncLiveFieldMetadata(options) {
  const ticket = await getCurrentTicket();
  state.ticketId = Number(ticket && ticket.id) || 0;
  if (!state.ticketId) {
    return;
  }

  const signature = buildSyncSignature(ticket);
  if (!signature) {
    return;
  }

  if (!options || !options.force) {
    if (signature === state.syncSignature) {
      return;
    }
  }

  try {
    const fields = await buildLiveFields(ticket);
    console.log("[ApprovalsAutomation] runtime_live_field_sync_started", {
      ticket_id: state.ticketId,
      field_count: fields.length,
      field_names: fields.map((field) => field.name),
    });

    const response = await invokeWithTimeout("syncLiveTicketFieldMetadata", {
      ticket_id: state.ticketId,
      fields,
    });
    const payload = parseInvokeResponse(response);
    if (!payload || payload.success === false) {
      throw new Error(resolveInvokeError(payload) || "Unable to sync live field metadata.");
    }

    state.syncSignature = signature;
    console.log("[ApprovalsAutomation] runtime_live_field_sync_succeeded", {
      ticket_id: state.ticketId,
      field_count: fields.length,
    });
  } catch (error) {
    console.error("Failed to sync live field metadata from runtime:", error);
  }
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
