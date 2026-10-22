import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  getDataplaneApiKey,
  getSavedDataplaneApiKey,
  saveDataplaneApiKey,
} from "@/lib/dataplane-key";

describe("dataplane API key", () => {
  const original = process.env.HINDSIGHT_CP_DATAPLANE_API_KEY;

  beforeEach(() => {
    saveDataplaneApiKey(null);
    delete process.env.HINDSIGHT_CP_DATAPLANE_API_KEY;
  });

  afterEach(() => {
    saveDataplaneApiKey(null);
    if (original === undefined) delete process.env.HINDSIGHT_CP_DATAPLANE_API_KEY;
    else process.env.HINDSIGHT_CP_DATAPLANE_API_KEY = original;
  });

  it("sends no key until one is given", () => {
    expect(getDataplaneApiKey()).toBe("");
    expect(getSavedDataplaneApiKey()).toBeNull();
  });

  it("starts from the environment's key", () => {
    process.env.HINDSIGHT_CP_DATAPLANE_API_KEY = "from-env";
    expect(getDataplaneApiKey()).toBe("from-env");
  });

  it("prefers a key set from the page, and falls back to the environment when it is cleared", () => {
    process.env.HINDSIGHT_CP_DATAPLANE_API_KEY = "from-env";
    saveDataplaneApiKey("from-page");
    expect(getDataplaneApiKey()).toBe("from-page");
    expect(getSavedDataplaneApiKey()).toBe("from-page");

    saveDataplaneApiKey(null);
    expect(getDataplaneApiKey()).toBe("from-env");
  });
});
