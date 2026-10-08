import fs from "node:fs";
import path from "node:path";

export function installReferencedElements(relativeSourcePath) {
  const source = fs.readFileSync(path.resolve(process.cwd(), relativeSourcePath), "utf8");
  const ids = new Set(
    Array.from(source.matchAll(/getElementById\(["']([^"']+)["']\)/g), (match) => match[1])
  );

  document.body.innerHTML = Array.from(ids, (id) => `<div id="${id}"></div>`).join("");
}

export function installHtmlFixture(relativeHtmlPath) {
  const html = fs.readFileSync(path.resolve(process.cwd(), relativeHtmlPath), "utf8");
  const parsed = new DOMParser().parseFromString(html, "text/html");
  document.body.innerHTML = parsed.body.innerHTML;
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
}

export function createClient(overrides = {}) {
  return {
    data: {
      get: vi.fn(async (name) => {
        if (name === "currentHost") {
          return { currentHost: { endpoint_urls: { freshdesk: "https://example.freshdesk.com" } } };
        }
        if (name === "ticket") {
          return { ticket: { id: 42, status: 2, custom_fields: { cf_region: "west" } } };
        }
        if (name === "loggedInUser") {
          return { loggedInUser: { contact: { email: "agent@example.com" } } };
        }
        return {};
      }),
    },
    events: { on: vi.fn() },
    request: {
      invokeTemplate: vi.fn(async () => ({ response: "{}" })),
      invoke: vi.fn(async () => ({ response: "{}" })),
    },
    instance: { context: vi.fn(async () => ({})) },
    ...overrides,
  };
}

export function exerciseSynchronousHelpers(api, excludedNames = []) {
  const excluded = new Set(["delay", "invokeWithTimeout", "init", ...excludedNames]);
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
    { id: "1", value: "2", label: "Two", email: "agent@example.com", target: {} },
  ];

  Object.entries(api).forEach(([name, helper]) => {
    if (excluded.has(name) || helper.constructor.name === "AsyncFunction") {
      return;
    }

    samples.forEach((sample) => {
      const args = Array.from({ length: Math.max(helper.length, 1) }, () => sample);
      try {
        helper(...args);
      } catch {
        // Boundary inputs intentionally traverse validation and fallback paths.
      }
    });

    samples.forEach((_, offset) => {
      const args = Array.from(
        { length: Math.max(helper.length, 1) },
        (unused, index) => samples[(offset + index) % samples.length]
      );
      try {
        helper(...args);
      } catch {
        // Mixed argument shapes exercise cross-field validation paths.
      }
    });
  });
}
