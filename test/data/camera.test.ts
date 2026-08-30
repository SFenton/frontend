import { describe, expect, it, vi } from "vitest";
import { webRtcOffer } from "../../src/data/camera";
import type { HomeAssistant } from "../../src/types";

describe("webRtcOffer", () => {
  it("does not replay an expired offer after reconnect", () => {
    const unsubscribe = Promise.resolve(vi.fn());
    const subscribeMessage = vi.fn().mockReturnValue(unsubscribe);
    const hass = {
      connection: { subscribeMessage },
    } as unknown as Pick<HomeAssistant, "connection">;
    const callback = vi.fn();

    expect(webRtcOffer(hass, "camera.front", "offer", callback)).toBe(
      unsubscribe
    );
    expect(subscribeMessage).toHaveBeenCalledWith(
      callback,
      {
        type: "camera/webrtc/offer",
        entity_id: "camera.front",
        offer: "offer",
      },
      { resubscribe: false }
    );
  });
});
