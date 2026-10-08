let domainInput;
let apiKeyInput;
let btnVerify;
let validationMessageDiv;
let installerNameInput;
let installerEmailInput;
let installerNameError;
let installerEmailError;

const promoApps = [
  {
    name: "Schedule Replies Pro",
    description: "Schedule Freshdesk replies for the exact follow-up moment.",
    appId: "378042",
    publicUrl: "https://www.freshworks.com/apps/schedule_replies_pro/",
    icon: "./assets/schedule-replies-pro.png",
  },
  {
    name: "Attachments Preview Pro",
    description: "Preview ticket attachments faster without extra downloads.",
    appId: "378223",
    publicUrl: "https://www.freshworks.com/apps/attachments_preview_pro_2/",
    icon: "./assets/attachments-preview-pro.png",
  },
  {
    name: "Schedule Ticket Pro",
    description: "Plan ticket actions and reminders around team workflows.",
    appId: "378481",
    publicUrl: "https://www.freshworks.com/apps/schedule_ticket_pro/",
    icon: "./assets/schedule-ticket-pro.png",
  },
];

let verified = false;
let savedConfigs = {};

document.onreadystatechange = function () {
  if (document.readyState === "interactive") {
    renderApp();
  }
};

async function renderApp() {
  try {
    const client = await app.initialized();
    window.client = client;

    domainInput = document.getElementById("domain");
    apiKeyInput = document.getElementById("apiKey");
    btnVerify = document.getElementById("btnVerify");
    validationMessageDiv = document.getElementById("validationMessage");
    installerNameInput = document.getElementById("installerName");
    installerEmailInput = document.getElementById("installerEmail");
    installerNameError = document.getElementById("installerNameError");
    installerEmailError = document.getElementById("installerEmailError");

    await Promise.all([
      customElements.whenDefined("fw-input"),
      customElements.whenDefined("fw-button"),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 100));
    renderPromoApps();

    btnVerify.addEventListener("fwClick", verify);
    domainInput.addEventListener("fwInput", () => {
      markUnverified();
      renderPromoApps();
    });
    apiKeyInput.addEventListener("fwInput", markUnverified);
    installerNameInput.addEventListener("fwInput", () =>
      clearFieldError(installerNameInput, installerNameError)
    );
    installerEmailInput.addEventListener("fwInput", () =>
      clearFieldError(installerEmailInput, installerEmailError)
    );
  } catch (error) {
    console.error("Unable to initialize installation page:", error);
  }
}

function markUnverified() {
  verified = false;
}

function renderPromoApps() {
  const container = document.getElementById("promoApps");
  if (!container) {
    return;
  }

  container.innerHTML = "";
  promoApps.forEach((appConfig) => {
    const link = document.createElement("a");
    link.className = "promo-card";
    link.href = getPromoAppUrl(appConfig);
    link.target = "_blank";
    link.rel = "noopener";

    const icon = document.createElement("img");
    icon.className = "promo-icon";
    icon.src = appConfig.icon;
    icon.alt = "";

    const body = document.createElement("div");
    const title = document.createElement("div");
    title.className = "promo-title";
    title.textContent = appConfig.name;

    const description = document.createElement("div");
    description.className = "promo-description";
    description.textContent = appConfig.description;

    body.appendChild(title);
    body.appendChild(description);
    link.appendChild(icon);
    link.appendChild(body);
    container.appendChild(link);
  });
}

// Deep-link into the account's own marketplace gallery when we know the domain.
function getPromoAppUrl(appConfig) {
  const domain = domainInput ? normalizeDomain(domainInput.value || savedConfigs.domain) : "";

  if (!domain || !domain.includes(".freshdesk.com")) {
    return appConfig.publicUrl;
  }

  const params = new URLSearchParams({
    route: "app",
    id: appConfig.appId,
    utmCampaign: "REC_EXIST_CUST",
  });

  return `https://${domain}/a/admin/marketplace/gallery?${params.toString()}`;
}

function getBasicAuth(apiKey) {
  return btoa(`${apiKey}:X`);
}

function normalizeDomain(value) {
  let domain = String(value || "").trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  if (domain && !domain.includes(".freshdesk.com")) {
    domain = `${domain}.freshdesk.com`;
  }
  return domain;
}

async function verify() {
  try {
    showValidationMessage("Verifying Freshdesk connection...", "info");

    const domain = normalizeDomain(domainInput.value);
    const apiKey = apiKeyInput.value.trim();
    const isKeyUnchanged = savedConfigs && savedConfigs.api_key && apiKey === savedConfigs.api_key;

    if (!domain) {
      showValidationMessage("Enter your Freshdesk domain before verifying.", "error");
      verified = false;
      return;
    }

    if (isKeyUnchanged) {
      if (domain !== savedConfigs.domain) {
        showValidationMessage("Enter the API key again to verify the updated domain.", "error");
        verified = false;
        return;
      }

      verified = true;
      showValidationMessage("Saved API key is already verified for this domain.", "success");
      return;
    }

    if (!apiKey) {
      showValidationMessage("Enter an API key to verify credentials.", "error");
      verified = false;
      return;
    }

    const response = await client.request.invokeTemplate("verify_freshdesk_credentials", {
      context: {
        domain,
        encoded_auth: getBasicAuth(apiKey),
      },
    });

    if (response.status === 200) {
      verified = true;
      showValidationMessage("Connection verified. Approvals Automation Pro is ready to save.", "success");
      return;
    }

    verified = false;
    showValidationMessage(
      "Verification failed. Check the domain and API key, then try again.",
      "error"
    );
  } catch (error) {
    verified = false;
    console.error("Verification error:", error);

    let message = "Could not verify credentials. Check the domain and API key.";
    if (error.status === 401) {
      message = "Authentication failed. The API key looks invalid.";
    } else if (error.status === 403) {
      message = "Access denied. Use an API key with admin access.";
    } else if (error.status === 404) {
      message = "That Freshdesk domain could not be reached.";
    }

    showValidationMessage(`Verification failed. ${message}`, "error");
  }
}

function showValidationMessage(message, type) {
  validationMessageDiv.textContent = message;
  validationMessageDiv.style.display = "block";
  validationMessageDiv.className = "validation-message";

  if (type === "success") {
    validationMessageDiv.classList.add("validation-success");
  } else if (type === "error") {
    validationMessageDiv.classList.add("validation-error");
  } else {
    validationMessageDiv.classList.add("validation-info");
  }
}

function focusField(field) {
  if (!field) {
    return;
  }

  field.scrollIntoView({ block: "center", behavior: "smooth" });

  setTimeout(() => {
    if (typeof field.setFocus === "function") {
      field.setFocus();
      return;
    }

    if (typeof field.focus === "function") {
      field.focus();
    }
  }, 100);
}

function setFieldError(field, errorElement, message) {
  if (!errorElement) {
    return;
  }

  errorElement.textContent = message;
  errorElement.classList.add("visible");
  errorElement.setAttribute("role", "alert");

  if (field) {
    field.setAttribute("state", "error");
  }
}

function clearFieldError(field, errorElement) {
  if (errorElement) {
    errorElement.textContent = "";
    errorElement.classList.remove("visible");
    errorElement.removeAttribute("role");
  }

  if (field) {
    field.removeAttribute("state");
  }
}

function clearContactErrors() {
  clearFieldError(installerNameInput, installerNameError);
  clearFieldError(installerEmailInput, installerEmailError);
}

function getInstallerName() {
  return installerNameInput.value.trim();
}

function getInstallerEmail() {
  return installerEmailInput.value.trim().toLowerCase();
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function getAppMetadata() {
  return window.FALCON_APP_METADATA || {
    appSlug: "freshdesk-approvals-automation-pro",
    appVersion: "unknown",
  };
}

function hasExistingInstallationConfig() {
  return Boolean(
    savedConfigs && (savedConfigs.domain || savedConfigs.installer_email || savedConfigs.api_key)
  );
}

function buildSettingsCapturePayload() {
  return {
    app_slug: getAppMetadata().appSlug,
    app_version: getAppMetadata().appVersion,
    event: "settingsUpdate",
    freshdesk_domain: normalizeDomain(domainInput.value),
    installed_at: new Date().toISOString(),
    installer_name: getInstallerName(),
    installer_email: getInstallerEmail(),
    marketing_consent: false,
    consent_timestamp: null,
  };
}

// New installs are captured server-side by onAppInstall; this covers
// contact changes made later from the settings page.
async function captureSettingsUpdate() {
  if (!hasExistingInstallationConfig()) {
    return;
  }

  try {
    await client.request.invokeTemplate("capture_installation", {
      context: {},
      body: JSON.stringify(buildSettingsCapturePayload()),
    });
  } catch (error) {
    console.error("Settings contact capture failed:", error);
  }
}

// Called by the FDK installation-page runtime.
// eslint-disable-next-line no-unused-vars
function postConfigs() {
  const newKeyInput = apiKeyInput.value.trim();
  const isKeyUnchanged = savedConfigs.api_key && newKeyInput === savedConfigs.api_key;
  const encodedApiKey = newKeyInput && !isKeyUnchanged
    ? getBasicAuth(newKeyInput)
    : savedConfigs.api_key;

  return {
    __meta: {
      secure: ["api_key"],
    },
    domain: normalizeDomain(domainInput.value),
    api_key: encodedApiKey,
    installer_name: getInstallerName(),
    installer_email: getInstallerEmail(),
  };
}

// Called by the FDK installation-page runtime.
// eslint-disable-next-line no-unused-vars
function getConfigs(configs) {
  savedConfigs = configs || {};
  domainInput.value = savedConfigs.domain || "";
  installerNameInput.value = savedConfigs.installer_name || "";
  installerEmailInput.value = savedConfigs.installer_email || "";
  renderPromoApps();

  if (configs.api_key) {
    apiKeyInput.value = configs.api_key;
    verified = true;
  } else {
    apiKeyInput.value = "";
    verified = false;
  }
}

// Called by the FDK installation-page runtime.
// eslint-disable-next-line no-unused-vars
async function validate() {
  clearContactErrors();

  const domain = normalizeDomain(domainInput.value);
  const apiKey = apiKeyInput.value.trim();

  if (!domain) {
    showValidationMessage("Freshdesk domain is required.", "error");
    return false;
  }

  if (!apiKey) {
    showValidationMessage("API key is required.", "error");
    return false;
  }

  const installerName = getInstallerName();
  const installerEmail = getInstallerEmail();

  if (!installerName) {
    setFieldError(installerNameInput, installerNameError, "Please enter Full Name");
    focusField(installerNameInput);
    return false;
  }

  if (!installerEmail) {
    setFieldError(installerEmailInput, installerEmailError, "Please enter Email Address");
    focusField(installerEmailInput);
    return false;
  }

  if (!isValidEmail(installerEmail)) {
    setFieldError(installerEmailInput, installerEmailError, "Please enter a valid Email Address");
    focusField(installerEmailInput);
    return false;
  }

  if (!verified) {
    showValidationMessage("Verify the Freshdesk connection before saving.", "error");
    return false;
  }

  await captureSettingsUpdate();

  return true;
}
