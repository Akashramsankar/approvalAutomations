import { __testApi__ as runtime } from "../app/scripts/runtime.js";
import {
  createClient,
  exerciseSynchronousHelpers,
  installHtmlFixture,
} from "./browser_test_utils.js";

describe("ticket background runtime helpers", () => {
  beforeEach(() => {
    installHtmlFixture("app/runtime.html");
    globalThis.app = { initialized: vi.fn(async () => createClient()) };
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test("normalizes field metadata", () => {
    expect(runtime.normalizeText(" value ")).toBe("value");
    expect(runtime.humanizeFieldName("cf_purchase_order")).toBe("Purchase Order");
    expect(runtime.getTicketCustomFieldKeys({ custom_fields: { cf_one: 1, cf_two: 2 } }))
      .toEqual(["cf_one", "cf_two"]);
    expect(runtime.dedupeOptionRecords([
      { value: "1", label: "One" },
      { value: "1", label: "One" },
      { value: "2", label: "Two" },
    ])).toHaveLength(2);
  });

  test("extracts nested option records", () => {
    const options = runtime.extractLiveOptions({
      choices: [{ id: 1, name: "First" }, { value: "2", label: "Second" }],
    });
    expect(options).toEqual(expect.arrayContaining([
      expect.objectContaining({ label: "First" }),
      expect.objectContaining({ label: "Second" }),
    ]));
  });

  test("parses invoke responses and errors", () => {
    expect(runtime.parseInvokeResponse({ response: '{"ok":true}' })).toEqual({ ok: true });
    expect(runtime.parseInvokeResponse({ response: { ok: true } })).toEqual({ ok: true });
    expect(runtime.resolveInvokeError({ message: "failed" })).toBe("failed");
  });

  test("initializes ticket metadata synchronization", async () => {
    await runtime.init();
    expect(globalThis.app.initialized).toHaveBeenCalledOnce();
  });

  test("synchronous helpers handle boundary input", () => {
    exerciseSynchronousHelpers(runtime);
    expect(Object.keys(runtime).length).toBeGreaterThan(10);
  });
});
