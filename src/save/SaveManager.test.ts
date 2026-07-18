import { afterEach, describe, expect, it, vi } from "vitest";
import * as api from "../net/api";
import { SaveManager } from "./SaveManager";

afterEach(() => vi.restoreAllMocks());

describe("SaveManager presentation conflicts", () => {
  it("adopts the committed server version after a lost PUT response", async () => {
    const manager = new SaveManager(
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      {} as never,
      new Map(),
      new Map(),
      async () => undefined,
    );
    const first = { camera: { x: 1, y: 2 } };
    const second = { camera: { x: 3, y: 4 } };
    const put = vi.spyOn(api, "putPresentationV3")
      .mockRejectedValueOnce(new api.ApiError(409, "presentation_conflict"))
      .mockResolvedValueOnce({ version: 2, data: second });
    vi.spyOn(api, "bootstrap").mockResolvedValue({
      presentation: { version: 1, data: first },
    } as never);

    await (manager as any).push(first);
    await (manager as any).push(second);

    expect(api.bootstrap).toHaveBeenCalledWith(true);
    expect(put).toHaveBeenNthCalledWith(2, {
      protocolVersion: 3,
      expectedVersion: 1,
      data: second,
    });
    expect((manager as any).presentationDirty).toBe(false);
  });
});
