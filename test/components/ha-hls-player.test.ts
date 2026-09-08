import { ContextProvider } from "@lit/context";
import { Connection } from "home-assistant-js-websocket";
import type { ContextType } from "@lit/context";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  apiContext,
  configContext,
  connectionContext,
  internationalizationContext,
} from "../../src/data/context";
import { FakeSocket } from "../test_helper/fake-socket";
import type * as CameraModule from "../../src/data/camera";
import "../../src/components/ha-hls-player";
import "../../src/components/ha-camera-stream";

class MockHls {
  public static instances: MockHls[] = [];
  public static isSupported = vi.fn(() => true);
  public static Events = {
    MEDIA_ATTACHED: "attached",
    FRAG_LOADED: "fragment",
    ERROR: "error",
  };
  public static ErrorTypes = {
    NETWORK_ERROR: "network",
    MEDIA_ERROR: "media",
  };
  public static ErrorDetails = {
    MANIFEST_LOAD_ERROR: "manifest",
    MANIFEST_LOAD_TIMEOUT: "timeout",
  };
  public handlers = new Map<string, (event: string, data: unknown) => void>();
  public destroy = vi.fn();
  public loadSource = vi.fn();
  public startLoad = vi.fn();
  public recoverMediaError = vi.fn();
  public attachMedia = vi.fn(() => queueMicrotask(() => this.emit("attached")));
  public on(event: string, callback: (event: string, data: unknown) => void) {
    this.handlers.set(event, callback);
  }
  public emit(event: string, data: unknown = {}) {
    this.handlers.get(event)?.(event, data);
  }
  constructor() {
    MockHls.instances.push(this);
  }
}

vi.mock("hls.js/dist/hls.light.mjs", () => ({ default: MockHls }));

vi.mock("../../src/data/camera", async (importOriginal) => ({
  ...(await importOriginal<typeof CameraModule>()),
  fetchCameraCapabilities: vi
    .fn()
    .mockResolvedValue({ frontend_stream_types: ["hls"] }),
  fetchThumbnailUrlWithCache: vi.fn().mockResolvedValue(""),
}));

const currentHls = () => MockHls.instances[MockHls.instances.length - 1];
const oldUrl = "http://streams.test/old-token/master_playlist.m3u8";
const newUrl = "http://streams.test/new-token/master_playlist.m3u8";
const playlist =
  '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100,CODECS="avc1.42E01E,mp4a.40.2"\nplaylist.m3u8\n';
const networkError = {
  fatal: true,
  type: "network",
  details: "manifest",
  response: { code: 404 },
};
const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
};
let host: HTMLDivElement | undefined;
let connection: Connection;
let pip: Element | null;
let pipDescriptor: PropertyDescriptor | undefined;
const fetchMock = vi.fn<typeof fetch>();

const mountPlayer = async (native = false, waitForPlayback = true) => {
  MockHls.isSupported.mockReturnValue(!native);
  host = document.createElement("div");
  document.body.append(host);
  const socket = new FakeSocket();
  connection = new Connection(socket.asWebSocket(), {
    setupRetry: 0,
    createSocket: async () => socket.asWebSocket(),
  });
  const callWS = vi.fn().mockImplementation(async () => ({ url: oldUrl }));
  new ContextProvider(host, {
    context: apiContext,
    initialValue: { callWS } as unknown as ContextType<typeof apiContext>,
  });
  new ContextProvider(host, {
    context: connectionContext,
    initialValue: {
      connection,
      connected: true,
      debugConnection: false,
      hassUrl: (path = "") => path,
    },
  });
  new ContextProvider(host, {
    context: configContext,
    initialValue: {
      config: { state: "RUNNING", components: ["stream"] },
      auth: {},
    } as unknown as ContextType<typeof configContext>,
  });
  new ContextProvider(host, {
    context: internationalizationContext,
    initialValue: { localize: (key: string) => key } as unknown as ContextType<
      typeof internationalizationContext
    >,
  });
  const player = document.createElement("ha-hls-player");
  player.entityid = "camera.front";
  host.append(player);
  await player.updateComplete;
  if (waitForPlayback) {
    await vi.waitFor(() => {
      if (native) {
        expect(player.shadowRoot!.querySelector("video")!.src).toContain(
          "/old-token/"
        );
      } else {
        expect(MockHls.instances).toHaveLength(1);
        expect(MockHls.instances[0].loadSource).toHaveBeenCalledOnce();
      }
    });
  }
  return { player, callWS };
};

beforeEach(() => {
  MockHls.instances = [];
  MockHls.isSupported.mockReset();
  fetchMock.mockReset().mockImplementation(async () => new Response(playlist));
  vi.stubGlobal("fetch", fetchMock);
  vi.spyOn(HTMLMediaElement.prototype, "load").mockImplementation(
    () => undefined
  );
  vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
  vi.spyOn(HTMLMediaElement.prototype, "canPlayType").mockReturnValue(
    "probably"
  );
  pip = null;
  pipDescriptor = Object.getOwnPropertyDescriptor(
    document,
    "pictureInPictureElement"
  );
  Object.defineProperty(document, "pictureInPictureElement", {
    configurable: true,
    get: () => pip,
  });
});

afterEach(() => {
  host?.remove();
  host = undefined;
  connection?.close();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (pipDescriptor) {
    Object.defineProperty(document, "pictureInPictureElement", pipDescriptor);
  } else Reflect.deleteProperty(document, "pictureInPictureElement");
});

describe("ha-hls-player URL lifetime recovery", () => {
  it("keeps healthy playback when reconnect returns the same URL", async () => {
    const { player, callWS } = await mountPlayer();
    const first = MockHls.instances[0];
    const video = player.shadowRoot!.querySelector("video");
    connection.fireEvent("ready");
    await vi.waitFor(() => expect(callWS).toHaveBeenCalledTimes(2));
    await player.updateComplete;
    expect(MockHls.instances).toHaveLength(1);
    expect(first.destroy).not.toHaveBeenCalled();
    expect(player.shadowRoot!.querySelector("video")).toBe(video);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it.each([false, true])(
    "refreshes an expired URL without a RUNNING transition (native=%s)",
    async (native) => {
      const { player, callWS } = await mountPlayer(native);
      callWS.mockResolvedValueOnce({ url: newUrl });
      connection.fireEvent("ready");
      await vi.waitFor(() => expect(callWS).toHaveBeenCalledTimes(2));
      await vi.waitFor(() => {
        if (native) {
          expect(player.shadowRoot!.querySelector("video")!.src).toContain(
            "/new-token/"
          );
        } else {
          expect(currentHls().loadSource).toHaveBeenCalledWith(
            "http://streams.test/new-token/playlist.m3u8"
          );
        }
      });
      if (!native) expect(MockHls.instances[0].destroy).toHaveBeenCalledOnce();
    }
  );

  it.each([false, true])(
    "reacquires the URL on a media network failure (native=%s)",
    async (native) => {
      const { player, callWS } = await mountPlayer(native);
      vi.useFakeTimers();
      callWS.mockResolvedValueOnce({ url: newUrl });
      if (native) {
        player
          .shadowRoot!.querySelector("video")!
          .dispatchEvent(new Event("error"));
      } else MockHls.instances[0].emit("error", networkError);
      await vi.advanceTimersByTimeAsync(1200);
      expect(callWS).toHaveBeenCalledTimes(2);
      if (native) {
        expect(player.shadowRoot!.querySelector("video")!.src).toContain(
          "/new-token/"
        );
      } else {
        expect(currentHls().loadSource).toHaveBeenCalledWith(
          "http://streams.test/new-token/playlist.m3u8"
        );
      }
    }
  );

  it("ignores an old URL result after a newer reconnect", async () => {
    const { callWS } = await mountPlayer();
    const old = deferred<{ url: string }>();
    callWS.mockReturnValueOnce(old.promise);
    connection.fireEvent("ready");
    await vi.waitFor(() => expect(callWS).toHaveBeenCalledTimes(2));
    callWS.mockResolvedValueOnce({ url: newUrl });
    connection.fireEvent("ready");
    await vi.waitFor(() => expect(MockHls.instances).toHaveLength(2));
    old.resolve({ url: "http://streams.test/stale/master_playlist.m3u8" });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(MockHls.instances).toHaveLength(2);
    expect(MockHls.instances[1].loadSource).toHaveBeenCalledWith(
      "http://streams.test/new-token/playlist.m3u8"
    );
  });

  it("ignores an old playlist completion after native replacement playback starts", async () => {
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const { callWS, player } = await mountPlayer(true, false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    callWS.mockResolvedValueOnce({ url: newUrl });
    connection.fireEvent("ready");
    await vi.waitFor(() => expect(callWS).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    await player.updateComplete;
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([oldUrl, newUrl]);
    expect((await fetchMock.mock.results[1].value).bodyUsed).toBe(true);
    await vi.waitFor(() =>
      expect(player.shadowRoot!.querySelector("video")!.src).toContain(
        "/new-token/"
      )
    );
    expect(
      fetchMock.mock.calls.map(([, init]) => init?.signal?.aborted)
    ).toEqual([true, false]);
    old.resolve(new Response(playlist));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(player.shadowRoot!.querySelector("video")!.src).toContain(
      "/new-token/"
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not acquire or start hidden media and resumes when visible", async () => {
    const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    const { callWS } = await mountPlayer(false, false);
    connection.fireEvent("ready");
    expect(callWS).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    hidden.mockReturnValue(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.waitFor(() => expect(MockHls.instances).toHaveLength(1));
  });

  it("refreshes an actively viewed PiP stream while hidden", async () => {
    const { player, callWS } = await mountPlayer();
    const video = player.shadowRoot!.querySelector("video")!;
    pip = video;
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    callWS.mockResolvedValueOnce({ url: newUrl });
    connection.fireEvent("ready");
    await vi.waitFor(() => expect(MockHls.instances).toHaveLength(2));
    expect(player.shadowRoot!.querySelector("video")).toBe(video);
  });

  it("does not clean up a stream that entered PiP during the hidden grace period", async () => {
    const { player } = await mountPlayer();
    const hls = currentHls();
    vi.useFakeTimers();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    pip = player.shadowRoot!.querySelector("video");
    await vi.advanceTimersByTimeAsync(60000);
    expect(hls.destroy).not.toHaveBeenCalled();
  });

  it("does not start a URL result that arrives after hiding", async () => {
    const { callWS } = await mountPlayer();
    const old = deferred<{ url: string }>();
    callWS.mockReturnValueOnce(old.promise);
    connection.fireEvent("ready");
    await vi.waitFor(() => expect(callWS).toHaveBeenCalledTimes(2));
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    old.resolve({ url: newUrl });
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(MockHls.instances).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("bounds repeated recovery failures and reports a terminal failure", async () => {
    const { player, callWS } = await mountPlayer();
    vi.useFakeTimers();
    const statuses: unknown[] = [];
    player.addEventListener("streams", (event) =>
      statuses.push((event as CustomEvent).detail)
    );
    currentHls().emit("error", networkError);
    await vi.advanceTimersByTimeAsync(1200);
    currentHls().emit("error", networkError);
    await vi.advanceTimersByTimeAsync(2200);
    currentHls().emit("error", networkError);
    await vi.advanceTimersByTimeAsync(10000);
    await player.updateComplete;
    expect(callWS).toHaveBeenCalledTimes(3);
    expect(MockHls.instances).toHaveLength(3);
    expect(player.shadowRoot!.querySelector("ha-alert")).not.toBeNull();
    expect(statuses[statuses.length - 1]).toEqual({
      hasAudio: false,
      hasVideo: false,
    });
    expect(currentHls().destroy).toHaveBeenCalledOnce();
  });

  it("cancels recovery when the existing stream becomes healthy again", async () => {
    const { callWS } = await mountPlayer();
    vi.useFakeTimers();
    const first = currentHls();
    first.emit("error", networkError);
    first.emit("fragment");
    await vi.advanceTimersByTimeAsync(5000);
    expect(callWS).toHaveBeenCalledOnce();
    expect(first.destroy).not.toHaveBeenCalled();
  });

  it("does not install a stale startup while a reconnect URL request is pending", async () => {
    const old = deferred<Response>();
    fetchMock.mockReturnValueOnce(old.promise);
    const { player, callWS } = await mountPlayer(true, false);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    const url = deferred<{ url: string }>();
    callWS.mockReturnValueOnce(url.promise);
    connection.fireEvent("ready");
    await vi.waitFor(() => expect(callWS).toHaveBeenCalledTimes(2));
    old.resolve(new Response(playlist));
    await new Promise((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(player.shadowRoot!.querySelector("video")!.src).toBe("");
    url.resolve({ url: newUrl });
    await vi.waitFor(() =>
      expect(player.shadowRoot!.querySelector("video")!.src).toContain(
        "/new-token/"
      )
    );
  });

  it("recovers the HLS-only camera parent from an image fallback on ready", async () => {
    const { player, callWS } = await mountPlayer();
    player.remove();
    const camera = document.createElement("ha-camera-stream");
    camera.stateObj = {
      entity_id: "camera.front",
      state: "idle",
      attributes: { supported_features: 2, access_token: "fixture" },
    } as unknown as CameraModule.CameraEntity;
    host!.append(camera);
    await camera.updateComplete;
    await vi.waitFor(() => expect(MockHls.instances).toHaveLength(2));
    const failedPlayer = camera.shadowRoot!.querySelector("ha-hls-player")!;
    failedPlayer.dispatchEvent(
      new CustomEvent("streams", {
        detail: { hasAudio: false, hasVideo: false },
      })
    );
    await camera.updateComplete;
    expect(camera.shadowRoot!.querySelector("ha-hls-player")).toBeNull();
    callWS.mockResolvedValueOnce({ url: newUrl });
    connection.fireEvent("ready");
    await vi.waitFor(() => expect(MockHls.instances).toHaveLength(3));
    expect(camera.shadowRoot!.querySelector("ha-hls-player")).not.toBe(
      failedPlayer
    );
    expect(currentHls().loadSource).toHaveBeenCalledWith(
      "http://streams.test/new-token/playlist.m3u8"
    );
  });
});
