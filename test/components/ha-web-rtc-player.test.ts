import { ContextProvider } from "@lit/context";
import { Connection } from "home-assistant-js-websocket";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CameraModule from "../../src/data/camera";
import type {
  HomeAssistantApi,
  HomeAssistantConnection,
} from "../../src/types";
import { apiContext, connectionContext } from "../../src/data/context";
import { FakeSocket } from "../test_helper/fake-socket";
import "../../src/components/ha-web-rtc-player";

const { fetchWebRtcClientConfiguration, webRtcOffer } = vi.hoisted(() => ({
  fetchWebRtcClientConfiguration: vi.fn(),
  webRtcOffer: vi.fn<typeof CameraModule.webRtcOffer>(),
}));

vi.mock("../../src/data/camera", async (importOriginal) => {
  const original = await importOriginal<typeof CameraModule>();
  webRtcOffer.mockImplementation(original.webRtcOffer);
  return { ...original, fetchWebRtcClientConfiguration, webRtcOffer };
});

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

class MockMediaStream {
  private tracks: MediaStreamTrack[] = [];
  public addTrack = vi.fn((track: MediaStreamTrack) => this.tracks.push(track));
  public getTracks = () => this.tracks;
  public getAudioTracks = () =>
    this.tracks.filter((track) => track.kind === "audio");
  public getVideoTracks = () =>
    this.tracks.filter((track) => track.kind === "video");
}

class MockRTCPeerConnection {
  public static instances: MockRTCPeerConnection[] = [];
  public signalingState: RTCSignalingState = "stable";
  public iceConnectionState: RTCIceConnectionState = "new";
  public close = vi.fn(() => {
    this.signalingState = "closed";
  });
  public createDataChannel = vi.fn();
  public addTransceiver = vi.fn();
  public createOffer = vi
    .fn()
    .mockResolvedValue({ type: "offer", sdp: "v=0\r\n" });
  public setLocalDescription = vi.fn().mockImplementation(async () => {
    this.signalingState = "have-local-offer";
  });
  public setRemoteDescription = vi.fn().mockImplementation(async () => {
    this.signalingState = "stable";
  });
  public addIceCandidate = vi.fn().mockResolvedValue(undefined);
  public restartIce = vi.fn();
  public onnegotiationneeded: (() => Promise<void>) | null = null;
  public onicecandidate: ((event: RTCPeerConnectionIceEvent) => void) | null =
    null;
  public oniceconnectionstatechange: (() => void) | null = null;
  public onicegatheringstatechange: (() => void) | null = null;
  public ontrack: ((event: RTCTrackEvent) => Promise<void>) | null = null;
  public onsignalingstatechange: (() => void) | null = null;

  constructor(public configuration?: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this);
  }
}

let host: HTMLDivElement | undefined;
let connections: Connection[] = [];
let pipElement: Element | null = null;
let pipDescriptor: PropertyDescriptor | undefined;

const makeConnection = (
  socket = new FakeSocket(),
  reconnectSocket = socket
) => {
  const connection = new Connection(socket.asWebSocket(), {
    setupRetry: 0,
    createSocket: async () => reconnectSocket.asWebSocket(),
  });
  connections.push(connection);
  return { connection, socket };
};

const connectionValue = (connection: Connection): HomeAssistantConnection => ({
  connection,
  connected: true,
  debugConnection: false,
  hassUrl: (path = "") => path,
});

const mountPlayer = async (
  waitForStart = true,
  reconnectSocket?: FakeSocket
) => {
  host = document.createElement("div");
  document.body.append(host);
  const { connection, socket } = makeConnection(
    new FakeSocket(),
    reconnectSocket
  );
  const callWS = vi.fn().mockResolvedValue(undefined);
  new ContextProvider(host, {
    context: apiContext,
    initialValue: { callWS } as unknown as HomeAssistantApi,
  });
  const provider = new ContextProvider(host, {
    context: connectionContext,
    initialValue: connectionValue(connection),
  });
  const player = document.createElement("ha-web-rtc-player");
  player.entityid = "camera.front";
  host.append(player);
  await player.updateComplete;
  if (waitForStart) {
    await vi.waitFor(() =>
      expect(fetchWebRtcClientConfiguration).toHaveBeenCalledOnce()
    );
  }
  return { connection, socket, player, provider, callWS };
};

const currentPeer = () =>
  MockRTCPeerConnection.instances[MockRTCPeerConnection.instances.length - 1];
const offerCallback = () =>
  webRtcOffer.mock.calls[webRtcOffer.mock.calls.length - 1][3];
const assertAlive = (peer: MockRTCPeerConnection) => {
  expect(peer.close).not.toHaveBeenCalled();
  expect(peer.signalingState).not.toBe("closed");
};
const restart = async (connection: Connection) => {
  const previous = currentPeer();
  connection.fireEvent("ready");
  await vi.waitFor(() => expect(currentPeer()).not.toBe(previous));
  return currentPeer();
};

beforeEach(() => {
  MockRTCPeerConnection.instances = [];
  fetchWebRtcClientConfiguration.mockReset().mockResolvedValue({
    configuration: { iceServers: [] },
  });
  webRtcOffer.mockClear();
  vi.stubGlobal("MediaStream", MockMediaStream);
  vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection);
  vi.stubGlobal(
    "RTCSessionDescription",
    class {
      constructor(public description: RTCSessionDescriptionInit) {}
    }
  );
  vi.stubGlobal(
    "RTCIceCandidate",
    class {
      constructor(public candidate: RTCIceCandidateInit) {}
      public toJSON() {
        return this.candidate;
      }
    }
  );
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined
  );
  pipElement = null;
  pipDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "pictureInPictureElement"
  );
  Object.defineProperty(document, "pictureInPictureElement", {
    configurable: true,
    get: () => pipElement,
  });
});

afterEach(() => {
  host?.remove();
  host = undefined;
  connections.forEach((connection) => connection.close());
  connections = [];
  vi.useRealTimers();
  if (pipDescriptor) {
    Object.defineProperty(document, "pictureInPictureElement", pipDescriptor);
  } else {
    Reflect.deleteProperty(document, "pictureInPictureElement");
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("ha-web-rtc-player reconnect ownership", () => {
  it.each(["remote", "local"] as const)(
    "reports a rejected %s candidate without destroying healthy media",
    async (direction) => {
      const warning = vi
        .spyOn(console, "warn")
        .mockImplementation(() => undefined);
      const { player, callWS } = await mountPlayer();
      const peer = currentPeer();
      await peer.onnegotiationneeded!();
      offerCallback()({ type: "session", session_id: "active-session" });
      offerCallback()({ type: "answer", answer: "answer" });
      await vi.waitFor(() => expect(peer.signalingState).toBe("stable"));
      peer.iceConnectionState = "connected";
      const track = {
        kind: "video",
        stop: vi.fn(),
      } as unknown as MediaStreamTrack;
      await peer.ontrack!({ track } as RTCTrackEvent);
      const failure = new Error("candidate rejected");
      if (direction === "remote") {
        peer.addIceCandidate.mockRejectedValueOnce(failure);
        offerCallback()({
          type: "candidate",
          candidate: { candidate: "remote candidate" },
        });
      } else {
        callWS.mockRejectedValueOnce(failure);
        peer.onicecandidate!({
          candidate: {
            candidate: "local candidate",
            toJSON: () => ({ candidate: "local candidate" }),
          },
        } as RTCPeerConnectionIceEvent);
      }
      await vi.waitFor(() => expect(warning).toHaveBeenCalledOnce());
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining("candidate"),
        failure
      );
      assertAlive(peer);
      expect(track.stop).not.toHaveBeenCalled();
      expect(Reflect.get(player, "_sessionId")).toBe("active-session");
      expect(player.shadowRoot!.querySelector("ha-alert")).toBeNull();
    }
  );

  it("closes the peer and tracks when the real Connection is explicitly closed", async () => {
    const { connection, player } = await mountPlayer();
    const peer = currentPeer();
    await peer.onnegotiationneeded!();
    const track = {
      kind: "video",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    await peer.ontrack!({ track } as RTCTrackEvent);
    connection.close();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
    expect(player.shadowRoot!.querySelector("video")!.srcObject).toBeNull();
    player.remove();
    expect(peer.close).toHaveBeenCalledOnce();
    expect(track.stop).toHaveBeenCalledOnce();
  });

  it("moves raw close cleanup to a new socket on the same real Connection", async () => {
    const nextSocket = new FakeSocket();
    const { connection, socket } = await mountPlayer(true, nextSocket);
    const first = currentPeer();
    vi.useFakeTimers();
    connection.reconnect(true);
    await vi.runAllTimersAsync();
    const replacement = currentPeer();
    expect(replacement).not.toBe(first);
    expect(first.close).toHaveBeenCalledOnce();
    assertAlive(replacement);
    socket.dispatchEvent(new Event("close"));
    assertAlive(replacement);
    connection.close();
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
  });

  it("detaches old raw close listeners when the Connection context changes", async () => {
    const { connection, provider, player } = await mountPlayer();
    const { connection: next, socket: nextSocket } = makeConnection();
    provider.setValue(connectionValue(next));
    await vi.waitFor(() =>
      expect(MockRTCPeerConnection.instances).toHaveLength(2)
    );
    const replacement = currentPeer();
    connection.close();
    assertAlive(replacement);
    next.close();
    expect(replacement.close).toHaveBeenCalledOnce();
    player.remove();
    nextSocket.dispatchEvent(new Event("close"));
    expect(replacement.close).toHaveBeenCalledOnce();
    expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
  });

  it("serializes queued ICE candidate text into the offer SDP", async () => {
    const { socket } = await mountPlayer();
    const peer = currentPeer();
    const localDescription = deferred<undefined>();
    peer.setLocalDescription.mockReturnValueOnce(localDescription.promise);
    const negotiation = peer.onnegotiationneeded!();
    await vi.waitFor(() =>
      expect(peer.setLocalDescription).toHaveBeenCalledOnce()
    );
    peer.onicecandidate!({
      candidate: {
        candidate: "candidate:fixture",
        toJSON: () => ({ candidate: "candidate:fixture" }),
      },
    } as RTCPeerConnectionIceEvent);
    localDescription.resolve(undefined);
    await negotiation;
    expect(socket.sent).toContainEqual(
      expect.objectContaining({
        type: "camera/webrtc/offer",
        offer: "v=0\r\na=candidate:fixture\r\n",
      })
    );
  });

  it.each(["ready", "reconnect"] as const)(
    "continues admitted PiP recovery if %s cleanup synchronously exits PiP",
    async (event) => {
      const { connection, player } = await mountPlayer(true, new FakeSocket());
      const first = currentPeer();
      const track = {
        kind: "video",
        stop: vi.fn(() => {
          pipElement = null;
        }),
      } as unknown as MediaStreamTrack;
      await first.ontrack!({ track } as RTCTrackEvent);
      pipElement = player.shadowRoot!.querySelector("video");
      vi.spyOn(document, "hidden", "get").mockReturnValue(true);
      vi.useFakeTimers();
      if (event === "ready") connection.fireEvent("ready");
      else connection.reconnect(true);
      await vi.waitFor(() =>
        expect(MockRTCPeerConnection.instances).toHaveLength(2)
      );
      const replacement = currentPeer();
      assertAlive(replacement);
      expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(60000);
      expect(replacement.close).toHaveBeenCalledOnce();
    }
  );

  it("expires PiP reconnect admission rather than starting hidden media much later", async () => {
    const { connection, player } = await mountPlayer();
    const first = currentPeer();
    await first.ontrack!({
      track: {
        kind: "video",
        stop: () => {
          pipElement = null;
        },
      },
    } as unknown as RTCTrackEvent);
    pipElement = player.shadowRoot!.querySelector("video");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const handshake = deferred<NonNullable<Connection["socket"]>>();
    connection.options.createSocket = () => handshake.promise;
    vi.useFakeTimers();
    connection.reconnect(true);
    await vi.advanceTimersByTimeAsync(60001);
    handshake.resolve(new FakeSocket().asWebSocket());
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchWebRtcClientConfiguration).toHaveBeenCalledOnce();
    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    expect(first.close).toHaveBeenCalledOnce();
  });

  it("does not renew the hidden grace period when recovering lost PiP after an outage", async () => {
    const { connection, player } = await mountPlayer();
    await currentPeer().ontrack!({
      track: {
        kind: "video",
        stop: () => {
          pipElement = null;
        },
      },
    } as unknown as RTCTrackEvent);
    pipElement = player.shadowRoot!.querySelector("video");
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const handshake = deferred<NonNullable<Connection["socket"]>>();
    connection.options.createSocket = () => handshake.promise;
    vi.useFakeTimers();
    connection.reconnect(true);
    await vi.advanceTimersByTimeAsync(30000);
    handshake.resolve(new FakeSocket().asWebSocket());
    await vi.advanceTimersByTimeAsync(0);
    expect(MockRTCPeerConnection.instances).toHaveLength(2);
    const replacement = currentPeer();
    assertAlive(replacement);
    await vi.advanceTimersByTimeAsync(30001);
    expect(replacement.close).toHaveBeenCalledOnce();
  });

  it("replaces the peer and removes its connection listeners on detach", async () => {
    const { connection, player } = await mountPlayer();
    const first = currentPeer();
    const replacement = await restart(connection);
    expect(first.close).toHaveBeenCalledOnce();
    assertAlive(replacement);
    player.remove();
    connection.fireEvent("ready");
    await Promise.resolve();
    expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
    expect(connection.eventListeners.get("ready")).toEqual([]);
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a stale configuration %s",
    async (outcome) => {
      const old = deferred<CameraModule.WebRTCClientConfiguration>();
      fetchWebRtcClientConfiguration.mockReturnValueOnce(old.promise);
      const { connection, player } = await mountPlayer();
      connection.fireEvent("ready");
      await vi.waitFor(() =>
        expect(MockRTCPeerConnection.instances).toHaveLength(1)
      );
      const replacement = currentPeer();
      if (outcome === "resolve") {
        old.resolve({ configuration: {} });
      } else {
        old.reject(new Error("old configuration"));
      }
      await Promise.resolve();
      await player.updateComplete;
      assertAlive(replacement);
      expect(MockRTCPeerConnection.instances).toHaveLength(1);
      expect(player.shadowRoot!.querySelector("ha-alert")).toBeNull();
    }
  );

  it.each(["createOffer", "setLocalDescription"] as const)(
    "ignores stale %s completion",
    async (operation) => {
      const { connection } = await mountPlayer();
      const first = currentPeer();
      const pending = deferred<RTCSessionDescriptionInit>();
      first[operation].mockReturnValueOnce(pending.promise);
      const negotiation = first.onnegotiationneeded!();
      if (operation === "setLocalDescription") {
        await vi.waitFor(() =>
          expect(first.setLocalDescription).toHaveBeenCalledOnce()
        );
      }
      const replacement = await restart(connection);
      pending.resolve({ type: "offer", sdp: "v=0\r\n" });
      await negotiation;
      assertAlive(replacement);
      expect(webRtcOffer).not.toHaveBeenCalled();
    }
  );

  it("rejects late old session, candidate and error callbacks without touching the replacement", async () => {
    const { connection, player } = await mountPlayer();
    await currentPeer().onnegotiationneeded!();
    const oldCallback = offerCallback();
    const replacement = await restart(connection);
    await replacement.onnegotiationneeded!();
    offerCallback()({ type: "session", session_id: "current" });
    oldCallback({ type: "session", session_id: "old" });
    oldCallback({
      type: "candidate",
      candidate: { candidate: "old candidate" },
    });
    oldCallback({ type: "error", code: "old", message: "expired" });
    await player.updateComplete;
    assertAlive(replacement);
    expect(Reflect.get(player, "_sessionId")).toBe("current");
    expect(replacement.addIceCandidate).not.toHaveBeenCalled();
  });

  it("ignores an old remote-description rejection after replacement", async () => {
    const { connection, player } = await mountPlayer();
    const first = currentPeer();
    await first.onnegotiationneeded!();
    const answer = deferred<undefined>();
    first.setRemoteDescription.mockReturnValueOnce(answer.promise);
    offerCallback()({ type: "answer", answer: "old answer" });
    expect(first.setRemoteDescription).toHaveBeenCalledOnce();
    const replacement = await restart(connection);
    answer.reject(new Error("old answer rejected"));
    await Promise.resolve();
    await player.updateComplete;
    assertAlive(replacement);
    expect(player.shadowRoot!.querySelector("ha-alert")).toBeNull();
  });

  it("does not attach tracks or send candidates from an old peer", async () => {
    const { connection, player, callWS } = await mountPlayer();
    const first = currentPeer();
    const oldTrack = first.ontrack!;
    const oldCandidate = first.onicecandidate!;
    const replacement = await restart(connection);
    await replacement.onnegotiationneeded!();
    offerCallback()({ type: "session", session_id: "current" });
    const track = {
      kind: "video",
      stop: vi.fn(),
    } as unknown as MediaStreamTrack;
    await oldTrack({ track } as RTCTrackEvent);
    oldCandidate({
      candidate: { candidate: "old", toJSON: () => ({ candidate: "old" }) },
    } as RTCPeerConnectionIceEvent);
    assertAlive(replacement);
    expect(callWS).not.toHaveBeenCalled();
    expect(
      (Reflect.get(player, "_remoteStream") as MockMediaStream).getTracks()
    ).toEqual([]);
  });

  it("surfaces a current configuration failure", async () => {
    fetchWebRtcClientConfiguration.mockRejectedValueOnce(
      new Error("configuration failed")
    );
    const { player } = await mountPlayer();
    await vi.waitFor(() =>
      expect(player.shadowRoot!.textContent).toContain("configuration failed")
    );
    expect(MockRTCPeerConnection.instances).toHaveLength(0);
  });

  it.each([
    "createOffer",
    "setLocalDescription",
    "setRemoteDescription",
  ] as const)(
    "surfaces a current %s failure and closes its peer",
    async (operation) => {
      const { player } = await mountPlayer();
      const peer = currentPeer();
      peer[operation].mockRejectedValueOnce(new Error("SDP failed"));
      await peer.onnegotiationneeded!();
      if (operation === "setRemoteDescription") {
        offerCallback()({ type: "answer", answer: "answer" });
      }
      await vi.waitFor(() =>
        expect(player.shadowRoot!.textContent).toContain("SDP failed")
      );
      expect(peer.close).toHaveBeenCalledOnce();
    }
  );

  it("handles a rejected subscription acknowledgement immediately", async () => {
    const { socket, player } = await mountPlayer();
    socket.deferredTypes.add("camera/webrtc/offer");
    const peer = currentPeer();
    const negotiation = peer.onnegotiationneeded!();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    socket.reject(socket.sent[0].id, "offer refused");
    await negotiation;
    await vi.waitFor(() =>
      expect(player.shadowRoot!.textContent).toContain("offer refused")
    );
    expect(peer.close).toHaveBeenCalledOnce();
  });

  it("does not start media in a hidden document, and recovers when visible", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const { connection } = await mountPlayer(false);
    connection.fireEvent("ready");
    expect(fetchWebRtcClientConfiguration).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() =>
      expect(MockRTCPeerConnection.instances).toHaveLength(1)
    );
    assertAlive(currentPeer());
  });

  it("reestablishes an actively viewed PiP session while hidden", async () => {
    const { connection, player } = await mountPlayer();
    const video = player.shadowRoot!.querySelector("video")!;
    pipElement = video;
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const replacement = await restart(connection);
    assertAlive(replacement);
    expect(player.shadowRoot!.querySelector("video")).toBe(video);
  });

  it("does not expire the hidden grace period after the video enters PiP", async () => {
    const { player } = await mountPlayer();
    const peer = currentPeer();
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    pipElement = player.shadowRoot!.querySelector("video");
    await vi.advanceTimersByTimeAsync(60000);
    assertAlive(peer);
  });

  it("cleans up an expired hidden peer and waits for visibility before replacing it", async () => {
    const { connection } = await mountPlayer();
    const first = currentPeer();
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    connection.fireEvent("ready");
    expect(first.close).toHaveBeenCalledOnce();
    expect(fetchWebRtcClientConfiguration).toHaveBeenCalledOnce();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() =>
      expect(MockRTCPeerConnection.instances).toHaveLength(2)
    );
    assertAlive(currentPeer());
  });

  it("recovers an already-ready replacement Connection exactly once", async () => {
    const { connection, provider, player } = await mountPlayer();
    const first = currentPeer();
    const { connection: next } = makeConnection();
    provider.setValue(connectionValue(next));
    await player.updateComplete;
    await vi.waitFor(() =>
      expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2)
    );
    expect(first.close).toHaveBeenCalledOnce();
    assertAlive(currentPeer());
    expect(connection.eventListeners.get("ready")).toEqual([]);
    expect(next.eventListeners.get("ready")).toHaveLength(1);
    provider.setValue(connectionValue(next));
    await player.updateComplete;
    expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
  });
});
