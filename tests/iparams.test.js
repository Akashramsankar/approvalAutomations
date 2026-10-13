import { __testApi__ as iparams } from "../config/assets/iparams.js";

describe("secure installation settings", () => {
  test("never retains or displays a loaded API credential", () => {
    const loaded = iparams.sanitizeLoadedConfigs({
      domain: "example.freshdesk.com",
      api_key: "BasicCredentialEquivalent",
      installer_name: "Installer",
      installer_email: "installer@example.com",
    });

    expect(loaded.hasSavedApiKey).toBe(true);
    expect(loaded.apiKeyDisplayValue).toBe("");
    expect(loaded.configs).not.toHaveProperty("api_key");
    expect(JSON.stringify(loaded)).not.toContain("BasicCredentialEquivalent");
  });

  test("omits an unchanged secure value and encodes replacements", () => {
    expect(iparams.resolveApiKeyForStorage("", true)).toBeUndefined();
    expect(iparams.resolveApiKeyForStorage("new-key", true)).toBe(btoa("new-key:X"));
    expect(iparams.resolveApiKeyForStorage("", false)).toBe("");
  });
});
