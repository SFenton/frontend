import { ContextProvider } from "@lit/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as CameraModule from "../../src/data/camera";
import type {
  HomeAssistantApi,
  HomeAssistantConnection,
} from "../../src/types";
import { apiContext, connectionContext } from "../../src/data/context";
import "../../src/components/ha-web-rtc-player";

const { fetchWebRtcClientConfiguration } = vi.hoisted(() => ({
  fetchWebRtcClientConfiguration: vi.fn(),
}));

vi.mock("../../src/data/camera", async (importOriginal) => ({
  ...(await importOriginal<typeof CameraModule>()),
  fetchWebRtcClientConfiguration,
}));

class MockMediaStream {
  public addTrack = vi.fn();

  public getTracks = () => [];
}

class MockRTCPeerConnection {
  public static instances: MockRTCPeerConnection[] = [];

  public close = vi.fn();

  public createDataChannel = vi.fn();

  public addTransceiver = vi.fn();

  public createOffer = vi.fn().mockResolvedValue({
    type: "offer",
    sdp: "v=0\r\n",
  });

  public setLocalDescription = vi.fn().mockImplementation(async () => {
    this.signalingState = "have-local-offer";
  });

  public restartIce = vi.fn();

  public signalingState: RTCSignalingState = "stable";

  public iceConnectionState: RTCIceConnectionState = "new";

  public onnegotiationneeded:
    ((this: RTCPeerConnection, ev: Event) => any) | null = null;

  public onicecandidate:
    ((this: RTCPeerConnection, ev: RTCPeerConnectionIceEvent) => any) | null =
    null;

  public oniceconnectionstatechange:
    ((this: RTCPeerConnection, ev: Event) => any) | null = null;

  public onicegatheringstatechange:
    ((this: RTCPeerConnection, ev: Event) => any) | null = null;

  public ontrack: ((this: RTCPeerConnection, ev: RTCTrackEvent) => any) | null =
    null;

  public onsignalingstatechange:
    ((this: RTCPeerConnection, ev: Event) => any) | null = null;

  constructor(public configuration?: RTCConfiguration) {
    MockRTCPeerConnection.instances.push(this);
  }
}

let host: HTMLDivElement | undefined;

const mountPlayer = async () => {
  host = document.createElement("div");
  document.body.append(host);
  const connection = new EventTarget();

  new ContextProvider(host, {
    context: apiContext,
    initialValue: {} as HomeAssistantApi,
  });
  new ContextProvider(host, {
    context: connectionContext,
    initialValue: {
      connection,
      connected: true,
      debugConnection: false,
      hassUrl: (path = "") => path,
    } as unknown as HomeAssistantConnection,
  });

  const player = document.createElement("ha-web-rtc-player");
  player.entityid = "camera.front";
  host.append(player);
  await player.updateComplete;
  await vi.waitFor(() =>
    expect(fetchWebRtcClientConfiguration).toHaveBeenCalledOnce()
  );

  return { connection, player };
};

beforeEach(() => {
  MockRTCPeerConnection.instances = [];
  fetchWebRtcClientConfiguration.mockReset().mockResolvedValue({
    configuration: { iceServers: [] },
  });
  vi.stubGlobal("MediaStream", MockMediaStream);
  vi.stubGlobal("RTCPeerConnection", MockRTCPeerConnection);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined
  );
});

afterEach(() => {
  host?.remove();
  host = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

// Reconnect recovery must replace the expired peer negotiation without
// depending on the player being removed and recreated by its parent.
describe("ha-web-rtc-player reconnect handling", () => {
  it("restarts the peer connection when Home Assistant reconnects", async () => {
    const { connection, player } = await mountPlayer();

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
    const firstPeer = MockRTCPeerConnection.instances[0];

    connection.dispatchEvent(new Event("ready"));

    await vi.waitFor(() => {
      expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
      expect(MockRTCPeerConnection.instances).toHaveLength(2);
    });
    expect(firstPeer.close).toHaveBeenCalledOnce();

    player.remove();
    connection.dispatchEvent(new Event("ready"));
    await Promise.resolve();
    expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
  });

  it("ignores a stale start that resolves after reconnect", async () => {
    let resolveFirst!: (value: CameraModule.WebRTCClientConfiguration) => void;
    const firstConfig = new Promise<CameraModule.WebRTCClientConfiguration>(
      (resolve) => {
        resolveFirst = resolve;
      }
    );
    fetchWebRtcClientConfiguration
      .mockReset()
      .mockReturnValueOnce(firstConfig)
      .mockResolvedValue({ configuration: { iceServers: [] } });

    const mounting = mountPlayer();
    await vi.waitFor(() =>
      expect(fetchWebRtcClientConfiguration).toHaveBeenCalledOnce()
    );

    const { connection } = await mounting;
    connection.dispatchEvent(new Event("ready"));
    await vi.waitFor(() => {
      expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
      expect(MockRTCPeerConnection.instances).toHaveLength(1);
    });

    resolveFirst({ configuration: { iceServers: [] } });
    await Promise.resolve();

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
  });

  it("ignores a stale start failure after reconnect", async () => {
    let rejectFirst!: (reason?: unknown) => void;
    const firstConfig = new Promise<CameraModule.WebRTCClientConfiguration>(
      (_resolve, reject) => {
        rejectFirst = reject;
      }
    );
    fetchWebRtcClientConfiguration
      .mockReset()
      .mockReturnValueOnce(firstConfig)
      .mockResolvedValue({ configuration: { iceServers: [] } });

    const mounting = mountPlayer();
    await vi.waitFor(() =>
      expect(fetchWebRtcClientConfiguration).toHaveBeenCalledOnce()
    );

    const { connection } = await mounting;
    connection.dispatchEvent(new Event("ready"));
    await vi.waitFor(() => {
      expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
      expect(MockRTCPeerConnection.instances).toHaveLength(1);
    });

    rejectFirst(new Error("stale connection"));
    await Promise.resolve();

    expect(MockRTCPeerConnection.instances).toHaveLength(1);
  });

  it("does not apply a stale negotiation to the replacement peer", async () => {
    const { connection } = await mountPlayer();
    const firstPeer = MockRTCPeerConnection.instances[0];
    let resolveOffer!: (offer: RTCSessionDescriptionInit) => void;
    firstPeer.createOffer.mockReturnValueOnce(
      new Promise<RTCSessionDescriptionInit>((resolve) => {
        resolveOffer = resolve;
      })
    );

    const negotiation = firstPeer.onnegotiationneeded?.call(
      firstPeer as unknown as RTCPeerConnection,
      new Event("negotiationneeded")
    );
    connection.dispatchEvent(new Event("ready"));
    await vi.waitFor(() =>
      expect(MockRTCPeerConnection.instances).toHaveLength(2)
    );

    resolveOffer({ type: "offer", sdp: "v=0\r\n" });
    await negotiation;

    expect(firstPeer.setLocalDescription).not.toHaveBeenCalled();
    expect(
      MockRTCPeerConnection.instances[1].setLocalDescription
    ).not.toHaveBeenCalled();
  });

  it("waits until the document is visible to restart", async () => {
    const { connection } = await mountPlayer();
    const firstPeer = MockRTCPeerConnection.instances[0];
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);

    connection.dispatchEvent(new Event("ready"));
    await vi.waitFor(() => expect(firstPeer.close).toHaveBeenCalledOnce());
    expect(fetchWebRtcClientConfiguration).toHaveBeenCalledOnce();

    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => {
      expect(fetchWebRtcClientConfiguration).toHaveBeenCalledTimes(2);
      expect(MockRTCPeerConnection.instances).toHaveLength(2);
    });
  });
});
