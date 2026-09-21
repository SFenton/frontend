import { Connection } from "home-assistant-js-websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webRtcOffer } from "../../src/data/camera";
import { FakeSocket } from "../test_helper/fake-socket";

const offerOptions = (socket: FakeSocket) => ({
  expectedSocket: socket.asWebSocket(),
});

afterEach(() => {
  vi.useRealTimers();
});

// A WebRTC offer describes one peer connection and cannot be replayed safely
// after the server-side session disappears with its WebSocket.
describe("webRtcOffer", () => {
  it("uses a non-resubscribing, socket-owned subscription", async () => {
    const socket = new FakeSocket();
    const connection = new Connection(socket.asWebSocket(), {
      setupRetry: 0,
      createSocket: async () => socket.asWebSocket(),
    });
    const subscribeMessage = vi.spyOn(connection, "subscribeMessage");
    const callback = vi.fn();

    const unsubscribe = await webRtcOffer(
      { connection },
      "camera.front",
      "offer",
      callback,
      offerOptions(socket)
    );

    expect(subscribeMessage).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({
        type: "camera/webrtc/offer",
        entity_id: "camera.front",
        offer: "offer",
      }),
      { resubscribe: false, preCheck: expect.any(Function) }
    );

    socket.emitEvent(3, { type: "session", session_id: "session" });
    expect(callback).toHaveBeenCalledOnce();

    await unsubscribe();
    expect(socket.subscriptions.size).toBe(0);
    connection.close();
  });

  it("rejects an offer that originated on a replaced socket", async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const connection = new Connection(first.asWebSocket(), {
      setupRetry: 0,
      createSocket: async () => second.asWebSocket(),
    });

    connection.reconnect(true);
    await vi.runAllTimersAsync();

    await expect(
      webRtcOffer(
        { connection },
        "camera.front",
        "stale offer",
        vi.fn(),
        offerOptions(first)
      )
    ).rejects.toMatchObject({ name: "AbortError" });
    expect(
      second.sent.filter((message) => message.type === "camera/webrtc/offer")
    ).toEqual([]);
    connection.close();
  });

  it("does not queue an offer while the connection is disconnected", async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const connection = new Connection(first.asWebSocket(), {
      setupRetry: 0,
      createSocket: async () => second.asWebSocket(),
    });

    connection.reconnect(true);

    await expect(
      webRtcOffer(
        { connection },
        "camera.front",
        "queued offer",
        vi.fn(),
        offerOptions(first)
      )
    ).rejects.toMatchObject({ name: "AbortError" });

    await vi.runAllTimersAsync();
    expect(
      second.sent.filter((message) => message.type === "camera/webrtc/offer")
    ).toEqual([]);
    connection.close();
  });

  it("never unsubscribes a replacement subscription after command ID reuse", async () => {
    vi.useFakeTimers();
    const first = new FakeSocket();
    const second = new FakeSocket();
    const connection = new Connection(first.asWebSocket(), {
      setupRetry: 0,
      createSocket: async () => second.asWebSocket(),
    });
    await connection.sendMessagePromise({
      type: "camera/webrtc/get_client_config",
    });
    const unsubscribe = await webRtcOffer(
      { connection },
      "camera.front",
      "old offer",
      vi.fn(),
      offerOptions(first)
    );
    await Promise.all(
      ["alpha", "beta", "gamma"].map((event) =>
        connection.subscribeEvents(vi.fn(), event)
      )
    );
    expect([...first.subscriptions.keys()]).toEqual([4, 5, 6, 7]);

    connection.reconnect(true);
    await vi.runAllTimersAsync();
    await unsubscribe();

    expect([...second.subscriptions.entries()]).toEqual([
      [2, "alpha"],
      [3, "beta"],
      [4, "gamma"],
    ]);
    expect(
      second.sent.filter((message) => message.type === "unsubscribe_events")
    ).toEqual([]);
    connection.close();
  });
});
