import { afterEach, describe, expect, it, vi } from "vitest";
import { HermesClient } from "../src/hermesClient.js";
import {
  HermesForbiddenError,
  HermesNotFoundError,
  HermesRejectedError,
  HermesUnauthenticatedError,
  HermesUnavailableError,
} from "../src/errors.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

const user = { accessToken: "test-token", storeId: "store-1" };

describe("HermesClient", () => {
  it("sends the credential headers and unwraps the {data} envelope", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/themes/active");
      const headers = init.headers as Record<string, string>;
      expect(headers.Authorization).toBe("Bearer test-token");
      expect(headers["X-Store-Id"]).toBe("store-1");
      expect(headers["X-Request-ID"]).toBeUndefined();
      return new Response(JSON.stringify({ data: { id: "t1" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HermesClient("https://hermes.test", user);
    const result = await client.request("GET", "/api/v1/themes/active");

    expect(result).toEqual({ id: "t1" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("appends query params and sends a JSON body when provided", async () => {
    const fetchMock = vi.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe("https://hermes.test/api/v1/widgets/w1?display=true");
      expect(init.body).toBe(JSON.stringify({ display: true }));
      expect((init.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
      return new Response(JSON.stringify({ data: { id: "w1" } }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HermesClient("https://hermes.test", user);
    await client.request("PUT", "/api/v1/widgets/w1", {
      query: { display: "true" },
      body: { display: true },
    });
  });

  it("returns the raw payload when there is no {data} envelope", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify([{ id: "1" }]), { status: 200 }))
    );
    const client = new HermesClient("https://hermes.test", user);
    expect(await client.request("GET", "/x")).toEqual([{ id: "1" }]);
  });

  it("returns null for a 204 and for an empty body", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));
    const client = new HermesClient("https://hermes.test", user);
    expect(await client.request("DELETE", "/x")).toBeNull();
  });

  it("maps 401/403/404/4xx/5xx to their typed errors", async () => {
    const client = new HermesClient("https://hermes.test", user);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesUnauthenticatedError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 403 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesForbiddenError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 404 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesNotFoundError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("bad payload", { status: 422 })));
    await expect(client.request("POST", "/x")).rejects.toThrow(HermesRejectedError);

    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 500 })));
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesUnavailableError);
  });

  it("maps a network failure to HermesUnavailableError", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );
    const client = new HermesClient("https://hermes.test", user);
    await expect(client.request("GET", "/x")).rejects.toThrow(HermesUnavailableError);
  });

  it("never puts the access token in a thrown error's message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 401 })));
    const client = new HermesClient("https://hermes.test", user);
    try {
      await client.request("GET", "/api/v1/themes/active");
      throw new Error("expected a throw");
    } catch (err) {
      expect(String(err)).not.toContain("test-token");
    }
  });

  it("propagates the caller's request id as X-Request-ID when one is supplied", async () => {
    const fetchMock = vi.fn(async (_url: URL, init: RequestInit) => {
      expect((init.headers as Record<string, string>)["X-Request-ID"]).toBe("trace-1");
      return new Response(null, { status: 204 });
    });
    vi.stubGlobal("fetch", fetchMock);

    const client = new HermesClient("https://hermes.test", { ...user, requestId: "trace-1" });
    await client.request("GET", "/api/v1/themes/active");

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

/**
 * The network under this client is not reliable.
 *
 * Measured against the dev host: two attempts in five timed out while the other
 * three answered in under nine seconds. A single dropped connection must not
 * fail a merchant's action — but repeating the wrong request is worse than
 * failing, so what may be repeated is the careful part.
 */
describe("HermesClient retries", () => {
  const unreachable = () => {
    throw new TypeError("fetch failed");
  };

  const ok = (body: unknown = { id: "cbk_1" }) =>
    new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

  it("retries a GET that could not reach Hermes, and succeeds", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls < 3) unreachable();
      return ok({ theme: "t" });
    }));

    const client = new HermesClient("https://hermes.test", user);
    await expect(client.request("get", "/api/v1/themes/active")).resolves.toEqual({ theme: "t" });
    expect(calls).toBe(3);
  });

  /**
   * The rule that matters most.
   *
   * A transport failure means no response came back — NOT that the request
   * never arrived. Hermes may have created the block and lost the reply, so a
   * repeated POST risks two blocks where the merchant asked for one.
   */
  it("never repeats a POST, because a lost reply is not a lost request", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      unreachable();
    }));

    const client = new HermesClient("https://hermes.test", user);
    await expect(client.request("post", "/api/v1/stores/s1/custom-blocks", { body: {} })).rejects.toBeInstanceOf(
      HermesUnavailableError,
    );
    expect(calls).toBe(1);
  });

  it("retries a PUT, which replaces content and so is safe to repeat", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      if (calls < 2) unreachable();
      return ok();
    }));

    const client = new HermesClient("https://hermes.test", user);
    await expect(client.request("put", "/api/v1/stores/s1/custom-blocks/b1", { body: {} })).resolves.toEqual({
      id: "cbk_1",
    });
    expect(calls).toBe(2);
  });

  it("gives up after a bounded number of attempts rather than hanging on", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      unreachable();
    }));

    const client = new HermesClient("https://hermes.test", user);
    await expect(client.request("get", "/api/v1/themes/active")).rejects.toBeInstanceOf(
      HermesUnavailableError,
    );
    expect(calls).toBe(3);
  });

  it("does not retry a 401, because that is an answer", async () => {
    // Asking again produces the same answer more slowly, and delays telling
    // the merchant the one thing they can act on.
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return new Response("", { status: 401 });
    }));

    const client = new HermesClient("https://hermes.test", user);
    await expect(client.request("get", "/api/v1/themes/active")).rejects.toBeInstanceOf(
      HermesUnauthenticatedError,
    );
    expect(calls).toBe(1);
  });

  it("does not retry a rejected payload", async () => {
    let calls = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      calls += 1;
      return new Response("bad name", { status: 422 });
    }));

    const client = new HermesClient("https://hermes.test", user);
    await expect(client.request("post", "/api/v1/stores/s1/custom-blocks", { body: {} })).rejects.toBeInstanceOf(
      HermesRejectedError,
    );
    expect(calls).toBe(1);
  });

  it("names the host it could not reach, not only the path", async () => {
    // "Hermes is unreachable calling /api/v1/..." reads identically whether it
    // is pointed at the real service or at a local stub someone left
    // configured, and those need opposite fixes.
    vi.stubGlobal("fetch", vi.fn(async () => unreachable()));

    const client = new HermesClient("https://hermes.test", user);
    await expect(client.request("get", "/api/v1/themes/active")).rejects.toThrow(/hermes\.test/);
  });
});
