let domainInput;
let apiKeyInput;
let btnVerify;
let validationMessageDiv;

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

    await Promise.all([
      customElements.whenDefined("fw-input"),
      customElements.whenDefined("fw-button"),
    ]);

    await new Promise((resolve) => setTimeout(resolve, 100));

    btnVerify.addEventListener("fwClick", verify);
    domainInput.addEventListener("fwInput", markUnverified);
    apiKeyInput.addEventListener("fwInput", markUnverified);
  } catch (error) {
    console.error("Unable to initialize installation page:", error);
  }
}

function markUnverified() {
  verified = false;
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
  };
}

function getConfigs(configs) {
  savedConfigs = configs || {};
  domainInput.value = configs.domain || "";

  if (configs.api_key) {
    apiKeyInput.value = configs.api_key;
    verified = true;
  } else {
    apiKeyInput.value = "";
    verified = false;
  }
}

async function validate() {
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

  if (!verified) {
    showValidationMessage("Verify the Freshdesk connection before saving.", "error");
    return false;
  }

  return true;
}
