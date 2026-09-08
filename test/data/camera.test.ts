import { Connection } from "home-assistant-js-websocket";
import { afterEach, describe, expect, it, vi } from "vitest";
import { webRtcOffer } from "../../src/data/camera";
import { FakeSocket } from "../test_helper/fake-socket";

afterEach(() => vi.useRealTimers());

// A WebRTC offer describes one peer connection and cannot be replayed safely
// after the server-side session disappears with its WebSocket.
describe("webRtcOffer", () => {
  it("does not replay an expired offer after reconnect", async () => {
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
      callback
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
    await unsubscribe();
    connection.close();
  });

  describe("webRtcOffer with the real WebSocket Connection", () => {
    it("releases an acknowledged subscription once when its signal is aborted", async () => {
      const socket = new FakeSocket();
      const connection = new Connection(socket.asWebSocket(), {
        setupRetry: 0,
        createSocket: async () => socket.asWebSocket(),
      });
      const controller = new AbortController();
      const unsubscribe = await webRtcOffer(
        { connection },
        "camera.front",
        "offer",
        vi.fn(),
        controller.signal
      );
      controller.abort();
      await unsubscribe();
      expect(socket.subscriptions.size).toBe(0);
      expect(
        socket.sent.filter((message) => message.type === "unsubscribe_events")
      ).toHaveLength(1);
      connection.close();
    });

    it("settles cancellation before acknowledgement and cleans up the eventual registration", async () => {
      const socket = new FakeSocket();
      socket.deferredTypes.add("camera/webrtc/offer");
      const connection = new Connection(socket.asWebSocket(), {
        setupRetry: 0,
        createSocket: async () => socket.asWebSocket(),
      });
      const controller = new AbortController();
      let failure: unknown;
      const pending = webRtcOffer(
        { connection },
        "camera.front",
        "offer",
        vi.fn(),
        controller.signal
      ).catch((error: unknown) => {
        failure = error;
      });
      await Promise.resolve();
      controller.abort();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(failure).toMatchObject({ name: "AbortError" });
      socket.acknowledge(3);
      await pending;
      await vi.waitFor(() => expect(socket.subscriptions.size).toBe(0));
      connection.close();
    });

    it("settles an unacknowledged offer when the connection is explicitly closed", async () => {
      const socket = new FakeSocket();
      socket.deferredTypes.add("camera/webrtc/offer");
      const connection = new Connection(socket.asWebSocket(), {
        setupRetry: 0,
        createSocket: async () => socket.asWebSocket(),
      });
      let failure: unknown;
      const pending = webRtcOffer(
        { connection },
        "camera.front",
        "offer",
        vi.fn()
      ).catch((error: unknown) => {
        failure = error;
      });
      await Promise.resolve();
      connection.close();
      await new Promise((resolve) => {
        setTimeout(resolve, 0);
      });
      expect(failure).toMatchObject({ name: "AbortError" });
      await pending;
    });

    it("never unsubscribes a different subscription after command ID reuse", async () => {
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
        vi.fn()
      );
      await Promise.all(
        ["alpha", "beta", "gamma"].map((event) =>
          connection.subscribeEvents(vi.fn(), event)
        )
      );
      expect([...first.subscriptions.keys()]).toEqual([4, 5, 6, 7]);
      let cleanup: Promise<void> | undefined;
      connection.addEventListener("ready", () => {
        cleanup = Promise.resolve(unsubscribe());
      });

      connection.reconnect(true);
      await vi.runAllTimersAsync();
      await cleanup;
      await unsubscribe();

      expect([...second.subscriptions.entries()]).toEqual([
        [2, "alpha"],
        [3, "beta"],
        [4, "gamma"],
      ]);
      expect(
        second.sent.filter((message) => message.type === "unsubscribe_events")
      ).toEqual([]);
      expect([...connection.commands.keys()]).toEqual([2, 3, 4]);
      connection.close();
    });

    it("settles a pending acknowledgement when its socket disconnects", async () => {
      vi.useFakeTimers();
      const first = new FakeSocket();
      first.deferredTypes.add("camera/webrtc/offer");
      const second = new FakeSocket();
      const connection = new Connection(first.asWebSocket(), {
        setupRetry: 0,
        createSocket: async () => second.asWebSocket(),
      });
      let failure: unknown;
      const pending = webRtcOffer(
        { connection },
        "camera.front",
        "offer",
        vi.fn()
      ).catch((error: unknown) => {
        failure = error;
      });
      await Promise.resolve();

      connection.reconnect(true);
      await vi.runAllTimersAsync();

      expect(failure).toMatchObject({ name: "AbortError" });
      await pending;
      expect(second.sent).toEqual([]);
      connection.close();
    });

    it("does not dispatch a cancelled queued initial offer after ready", async () => {
      vi.useFakeTimers();
      const first = new FakeSocket();
      const second = new FakeSocket();
      let finishHandshake!: (socket: NonNullable<Connection["socket"]>) => void;
      const connection = new Connection(first.asWebSocket(), {
        setupRetry: 0,
        createSocket: () =>
          new Promise((resolve) => {
            finishHandshake = resolve;
          }),
      });
      connection.suspendReconnectUntil(Promise.resolve());
      connection.reconnect(true);
      await vi.advanceTimersByTimeAsync(0);
      expect(connection._queuedMessages).toBeDefined();
      const controller = new AbortController();
      connection.addEventListener("ready", () => controller.abort());
      const pending = webRtcOffer(
        { connection },
        "camera.front",
        "expired queued offer",
        vi.fn(),
        controller.signal
      ).catch((error: unknown) => error);

      finishHandshake(second.asWebSocket());
      await vi.runAllTimersAsync();

      expect(await pending).toMatchObject({ name: "AbortError" });
      expect(second.sent).toEqual([]);
      connection.close();
    });

    it("cleans up a cancelled same-socket subscription after a late acknowledgement", async () => {
      const socket = new FakeSocket();
      socket.deferredTypes.add("camera/webrtc/offer");
      const connection = new Connection(socket.asWebSocket(), {
        setupRetry: 0,
        createSocket: async () => socket.asWebSocket(),
      });
      const controller = new AbortController();
      const pending = webRtcOffer(
        { connection },
        "camera.front",
        "offer",
        vi.fn(),
        controller.signal
      ).catch((error: unknown) => error);
      await Promise.resolve();
      controller.abort();
      socket.acknowledge(3);

      expect(await pending).toMatchObject({ name: "AbortError" });
      await vi.waitFor(() => expect(socket.subscriptions.size).toBe(0));
      expect(
        socket.sent.filter((message) => message.type === "unsubscribe_events")
      ).toEqual([expect.objectContaining({ subscription: 3 })]);
      connection.close();
    });
  });
});
