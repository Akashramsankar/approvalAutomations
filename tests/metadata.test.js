import { APP_SLUG, APP_VERSION } from "../server/app_metadata.js";

test("publishes stable application metadata", () => {
  expect(APP_SLUG).toBe("freshdesk-approvals-automation-pro");
  expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
});
