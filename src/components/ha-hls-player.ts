import { consume, type ContextType } from "@lit/context";
import type HlsType from "hls.js";
import type { Connection } from "home-assistant-js-websocket";
import type { PropertyValues, TemplateResult } from "lit";
import { css, html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators";
import { styleMap } from "lit/directives/style-map";
import { isComponentLoaded } from "../common/config/is_component_loaded";
import { consumeLocalize } from "../common/decorators/consume-context-entry";
import { fireEvent } from "../common/dom/fire_event";
import type { LocalizeFunc } from "../common/translations/localize";
import { nextRender } from "../common/util/render-status";
import { fetchStreamUrl } from "../data/camera";
import { apiContext, configContext, connectionContext } from "../data/context";
import "./ha-alert";

type HlsLite = Omit<
  HlsType,
  "subtitleTrackController" | "audioTrackController" | "emeController"
>;

const HIDDEN_CLEANUP_DELAY = 60000;
const MAX_RECOVERY_ATTEMPTS = 2;

@customElement("ha-hls-player")
class HaHLSPlayer extends LitElement {
  @state()
  @consumeLocalize()
  private _localize!: LocalizeFunc;

  @state()
  @consume({ context: configContext, subscribe: true })
  private _config!: ContextType<typeof configContext>;

  @state()
  @consume({ context: apiContext, subscribe: true })
  private _api!: ContextType<typeof apiContext>;

  @state()
  @consume({ context: connectionContext, subscribe: true })
  private _connection!: ContextType<typeof connectionContext>;

  @property() public entityid?: string;

  @property() public url?: string;

  @property({ attribute: "poster-url" }) public posterUrl?: string;

  @property({ attribute: false }) public aspectRatio?: number;

  @property({ attribute: false }) public fitMode?: "cover" | "contain" | "fill";

  @property({ type: Boolean, attribute: "controls" })
  public controls = false;

  @property({ type: Boolean, attribute: "muted" })
  public muted = false;

  @property({ type: Boolean, attribute: "autoplay" })
  public autoPlay = false;

  @property({ type: Boolean, attribute: "playsinline" })
  public playsInline = false;

  @property({ type: Boolean, attribute: "allow-exoplayer" })
  public allowExoPlayer = false;

  // don't cache this, as we remove it on disconnects
  @query("video") private _videoEl!: HTMLVideoElement;

  @state() private _error?: string;

  @state() private _errorIsFatal = false;

  private _url = "";

  private _hlsPolyfillInstance?: HlsLite;

  private _exoPlayer = false;

  private static streamCount = 0;

  private _hiddenCleanupTimeout?: number;

  private _readyConnection?: Connection;

  private _urlRequest?: Promise<void>;

  private _urlRequestGeneration = 0;

  private _playbackGeneration = 0;

  private _playlistAbort?: AbortController;

  private _playing = false;

  private _recoveryAttempts = 0;

  private _recoveryTimer?: number;

  private _nativeCleanup?: () => void;

  private _isPictureInPicture(): boolean {
    const video = this._videoEl;
    return Boolean(
      video &&
      (document.pictureInPictureElement === video ||
        document.pictureInPictureElement === this ||
        this.shadowRoot?.pictureInPictureElement === video)
    );
  }

  private _canPlay(): boolean {
    return this.isConnected && (!document.hidden || this._isPictureInPicture());
  }

  private _handleVisibilityChange = () => {
    if (this._isPictureInPicture()) {
      // video is playing in picture-in-picture mode, don't do anything
      return;
    }
    if (document.hidden) {
      this._invalidateUrlRequest();
      this._clearRecoveryTimer();
      if (!this._playing) this._cleanUp();
      clearTimeout(this._hiddenCleanupTimeout);
      this._hiddenCleanupTimeout = window.setTimeout(() => {
        this._hiddenCleanupTimeout = undefined;
        if (document.hidden && !this._isPictureInPicture()) {
          this._cleanUp();
        }
      }, HIDDEN_CLEANUP_DELAY);
    } else {
      clearTimeout(this._hiddenCleanupTimeout);
      this._hiddenCleanupTimeout = undefined;
      this._recoveryAttempts = 0;
      this._refreshSource(Boolean(this._error));
    }
  };

  private _handleConnectionReady = () => {
    this._invalidateUrlRequest();
    this._clearRecoveryTimer();
    this._recoveryAttempts = 0;
    if (!this._playing) this._cleanUp();
    if (this._canPlay()) {
      clearTimeout(this._hiddenCleanupTimeout);
      this._hiddenCleanupTimeout = undefined;
      this._refreshSource(Boolean(this._error));
    }
  };

  private _handleConnectionDisconnected = () => {
    // The HTTP stream may still be healthy. Only invalidate pending WS work.
    this._invalidateUrlRequest();
    this._clearRecoveryTimer();
    if (!this._playing) this._cleanUp();
  };

  private _attachReadyListener(): boolean {
    const connection = this._connection?.connection;
    if (
      !this.isConnected ||
      !connection ||
      connection === this._readyConnection
    ) {
      return false;
    }
    this._detachReadyListener();
    connection.addEventListener("ready", this._handleConnectionReady);
    connection.addEventListener(
      "disconnected",
      this._handleConnectionDisconnected
    );
    this._readyConnection = connection;
    return true;
  }

  private _detachReadyListener(): void {
    this._readyConnection?.removeEventListener(
      "ready",
      this._handleConnectionReady
    );
    this._readyConnection?.removeEventListener(
      "disconnected",
      this._handleConnectionDisconnected
    );
    this._readyConnection = undefined;
  }

  private _invalidateUrlRequest(): void {
    this._urlRequestGeneration += 1;
    this._urlRequest = undefined;
  }

  private _refreshSource(restart = false): void {
    if (!this._canPlay()) return;
    if (this.entityid) {
      this._getStreamUrlFromEntityId(restart);
    } else if (this._url && (restart || !this._playing)) {
      this._startHls();
    }
  }

  public connectedCallback() {
    super.connectedCallback();
    HaHLSPlayer.streamCount += 1;
    this._attachReadyListener();
    if (this.hasUpdated) {
      this._refreshSource();
    }
    document.addEventListener("visibilitychange", this._handleVisibilityChange);
  }

  public disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(
      "visibilitychange",
      this._handleVisibilityChange
    );
    clearTimeout(this._hiddenCleanupTimeout);
    this._hiddenCleanupTimeout = undefined;
    HaHLSPlayer.streamCount -= 1;
    this._detachReadyListener();
    this._invalidateUrlRequest();
    this._cleanUp();
  }

  protected render(): TemplateResult {
    return html`
      ${
        this._error
          ? html`<ha-alert
              alert-type="error"
              class=${this._errorIsFatal ? "fatal" : "retry"}
            >
              ${this._error}
            </ha-alert>`
          : ""
      }
      ${
        !this._errorIsFatal
          ? html`<video
              .poster=${this.posterUrl}
              ?autoplay=${this.autoPlay}
              .muted=${this.muted}
              ?playsinline=${this.playsInline}
              ?controls=${this.controls}
              @loadeddata=${this._loadedData}
              @leavepictureinpicture=${this._handleVisibilityChange}
              style=${styleMap({
                height: this.aspectRatio == null ? "100%" : "auto",
                aspectRatio: this.aspectRatio,
                objectFit: this.fitMode,
              })}
            ></video>`
          : ""
      }
    `;
  }

  protected updated(changedProps: PropertyValues) {
    super.updated(changedProps);

    const entityChanged = changedProps.has("entityid");
    const urlChanged = changedProps.has("url");
    const connectionChanged =
      changedProps.has("_connection") && this._attachReadyListener();

    if (entityChanged) {
      this._invalidateUrlRequest();
      this._cleanUp();
      this._url = "";
      this._recoveryAttempts = 0;
      if (this.entityid) this._getStreamUrlFromEntityId();
    }
    if (!this.entityid && (urlChanged || entityChanged) && this.url) {
      this._invalidateUrlRequest();
      this._url = this.url;
      this._recoveryAttempts = 0;
      this._startHls();
    } else if (!entityChanged && connectionChanged) {
      this._handleConnectionReady();
    }
  }

  private _getStreamUrlFromEntityId(
    restart = false
  ): Promise<void> | undefined {
    if (
      !this._canPlay() ||
      !this.entityid ||
      !this._connection?.connection.connected
    ) {
      return undefined;
    }
    if (this._urlRequest) {
      if (!restart) return this._urlRequest;
      this._invalidateUrlRequest();
    }
    if (!isComponentLoaded(this._config.config, "stream")) {
      this._setFatalError("Streaming component is not loaded.");
      return undefined;
    }

    const entityId = this.entityid;
    const connection = this._connection.connection;
    const socket = connection.socket;
    const generation = ++this._urlRequestGeneration;
    const isCurrent = () =>
      generation === this._urlRequestGeneration &&
      entityId === this.entityid &&
      connection === this._connection.connection &&
      socket === connection.socket &&
      this._canPlay();
    const request = async () => {
      try {
        const { url } = await fetchStreamUrl(
          { callWS: this._api.callWS, hassUrl: this._connection.hassUrl },
          entityId
        );
        if (!isCurrent()) return;
        if (url !== this._url || !this._playing || (restart && this._error)) {
          this._url = url;
          await this._startHls();
        }
      } catch (error: unknown) {
        if (isCurrent()) this._scheduleRecovery(this._errorMessage(error));
      } finally {
        if (generation === this._urlRequestGeneration) {
          this._urlRequest = undefined;
        }
      }
    };
    this._urlRequest = request();
    return this._urlRequest;
  }

  private _isCurrentPlayback(generation: number): boolean {
    return generation === this._playbackGeneration && this._canPlay();
  }

  private _errorMessage(error: unknown): string {
    return error && typeof error === "object" && "message" in error
      ? String(error.message)
      : "Error starting stream, see logs for details";
  }

  private async _startHls(): Promise<void> {
    if (!this._canPlay() || !this._url) return;
    this._cleanUp();
    this._resetError();
    const generation = this._playbackGeneration;
    const url = this._url;
    const controller = new AbortController();
    this._playlistAbort = controller;
    try {
      const masterPlaylistPromise = fetch(url, {
        signal: controller.signal,
      }).then(async (response) => {
        if (!response.ok) {
          throw new Error("Error starting stream, see logs for details");
        }
        return response.text();
      });

      const [module, masterPlaylist] = await Promise.all([
        import("hls.js/dist/hls.light.mjs"),
        masterPlaylistPromise,
      ]);
      // eslint-disable-next-line @typescript-eslint/naming-convention
      const Hls: typeof HlsType = module.default;

      await this.updateComplete;
      if (!this._isCurrentPlayback(generation)) {
        return;
      }

      let hlsSupported = Hls.isSupported();

      if (!hlsSupported) {
        hlsSupported =
          this._videoEl.canPlayType("application/vnd.apple.mpegurl") !== "";
      }

      if (!hlsSupported) {
        this._setFatalError(
          this._localize("ui.components.media-browser.video_not_supported")
        );
        return;
      }

      const useExoPlayer =
        this.allowExoPlayer && this._config.auth.external?.config.hasExoPlayer;

      // Parse playlist assuming it is a master playlist. Match group 1 and 2 are codec, match group 3 is regular playlist url
      // See https://tools.ietf.org/html/rfc8216 for HLS spec details
      const playlistRegexp =
        /#EXT-X-STREAM-INF:.*?(?:CODECS=".*?([^.]*)?\..*?,([^.]*)?\..*?".*?)?(?:\n|\r\n)(.+)/g;
      const match = playlistRegexp.exec(masterPlaylist);
      const matchTwice = playlistRegexp.exec(masterPlaylist);

      // Get the regular playlist url from the input (master) playlist, falling back to the input playlist if necessary
      // This avoids the player having to load and parse the master playlist again before loading the regular playlist
      let playlist_url: string;
      if (match !== null && matchTwice === null) {
        // Only send the regular playlist url if we match exactly once
        playlist_url = new URL(match[3], url).href;
      } else {
        playlist_url = url;
      }

      const codecs = match ? `${match[1]},${match[2]}` : undefined;

      this._reportStreams(codecs);

      // If codec is HEVC and ExoPlayer is supported, use ExoPlayer.
      if (
        useExoPlayer &&
        (codecs?.includes("hevc") || codecs?.includes("hev1"))
      ) {
        await this._renderHLSExoPlayer(playlist_url, generation);
      } else if (Hls.isSupported()) {
        this._renderHLSPolyfill(this._videoEl, Hls, playlist_url, generation);
      } else {
        this._renderHLSNative(this._videoEl, playlist_url, generation);
      }
      if (this._isCurrentPlayback(generation)) this._playing = true;
    } catch (error: unknown) {
      if (this._isCurrentPlayback(generation)) {
        this._scheduleRecovery(this._errorMessage(error));
      }
    } finally {
      if (generation === this._playbackGeneration) {
        this._playlistAbort = undefined;
      }
    }
  }

  private async _renderHLSExoPlayer(url: string, generation: number) {
    this._exoPlayer = true;
    window.addEventListener("resize", this._resizeExoPlayer);
    this.updateComplete
      .then(() => nextRender())
      .then(() => {
        if (this._isCurrentPlayback(generation)) this._resizeExoPlayer();
      });
    this._videoEl.style.visibility = "hidden";
    await this._config.auth.external!.fireMessage({
      type: "exoplayer/play_hls",
      payload: {
        url,
        muted: this.muted,
      },
    });
  }

  private _resizeExoPlayer = () => {
    if (!this._videoEl) {
      return;
    }
    const rect = this._videoEl.getBoundingClientRect();
    this._config.auth.external!.fireMessage({
      type: "exoplayer/resize",
      payload: {
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
      },
    });
  };

  private _isLLHLSSupported(): boolean {
    // LL-HLS keeps multiple requests in flight, which can run into browser limitations without
    // an http/2 proxy to pipeline requests. However, a small number of streams active at
    // once should be OK.
    // The stream count may be incremented multiple times before this function is called to check
    // the count e.g. when loading a page with many streams on it. The race can work in our favor
    // so we now have a better idea on if we'll use too many browser connections later.
    if (HaHLSPlayer.streamCount <= 2) {
      return true;
    }
    if (
      !("performance" in window) ||
      performance.getEntriesByType("resource").length === 0
    ) {
      return false;
    }
    const perfEntry = performance.getEntriesByType(
      "resource"
    )[0] as PerformanceResourceTiming;
    return "nextHopProtocol" in perfEntry && perfEntry.nextHopProtocol === "h2";
  }

  private _renderHLSPolyfill(
    videoEl: HTMLVideoElement,
    Hls: typeof HlsType,
    url: string,
    generation: number
  ) {
    const hls = new Hls({
      backBufferLength: 60,
      fragLoadingTimeOut: 30000,
      manifestLoadingTimeOut: 30000,
      levelLoadingTimeOut: 30000,
      maxLiveSyncPlaybackRate: 2,
      lowLatencyMode: this._isLLHLSSupported(),
    });
    this._hlsPolyfillInstance = hls;
    hls.attachMedia(videoEl);
    hls.on(Hls.Events.MEDIA_ATTACHED, () => {
      if (!this._isCurrentPlayback(generation)) return;
      this._resetError();
      hls.loadSource(url);
    });
    hls.on(Hls.Events.FRAG_LOADED, (_event, _data: any) => {
      if (!this._isCurrentPlayback(generation)) return;
      this._recoveryAttempts = 0;
      this._clearRecoveryTimer();
      this._resetError();
    });
    hls.on(Hls.Events.ERROR, (_event, data: any) => {
      if (!this._isCurrentPlayback(generation)) return;
      // Some errors are recovered automatically by the hls player itself, and the others handled
      // in this function require special actions to recover. Errors retried in this function
      // are done with backoff to not cause unnecessary failures.
      if (!data.fatal) {
        return;
      }
      if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
        switch (data.details) {
          case Hls.ErrorDetails.MANIFEST_LOAD_ERROR: {
            let error = "Error starting stream, see logs for details";
            if (
              data.response !== undefined &&
              data.response.code !== undefined
            ) {
              if (data.response.code >= 500) {
                error += " (Server failure)";
              } else if (data.response.code >= 400) {
                error += " (Stream never started)";
              } else {
                error += ` (${data.response.code})`;
              }
            }
            this._scheduleRecovery(error);
            break;
          }
          case Hls.ErrorDetails.MANIFEST_LOAD_TIMEOUT:
            this._scheduleRecovery("Timeout while starting stream");
            break;
          default:
            this._scheduleRecovery("Stream network error");
            break;
        }
      } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
        this._scheduleRecovery("Error with media stream contents");
      } else {
        this._setFatalError("Error playing stream");
      }
    });
  }

  private _renderHLSNative(
    videoEl: HTMLVideoElement,
    url: string,
    generation: number
  ) {
    videoEl.src = url;
    const loaded = () => {
      if (!this._isCurrentPlayback(generation)) return;
      videoEl.play().catch((error: unknown) => {
        if (!this._isCurrentPlayback(generation)) return;
        if (error instanceof DOMException && error.name === "NotAllowedError") {
          this._setRetryableError(this._errorMessage(error));
        } else {
          this._scheduleRecovery(this._errorMessage(error));
        }
      });
    };
    const failed = () => {
      if (this._isCurrentPlayback(generation)) {
        this._scheduleRecovery("Stream network error");
      }
    };
    videoEl.addEventListener("loadedmetadata", loaded);
    videoEl.addEventListener("error", failed);
    this._nativeCleanup = () => {
      videoEl.removeEventListener("loadedmetadata", loaded);
      videoEl.removeEventListener("error", failed);
    };
  }

  private _clearRecoveryTimer(): void {
    clearTimeout(this._recoveryTimer);
    this._recoveryTimer = undefined;
  }

  private _scheduleRecovery(message: string): void {
    this._setRetryableError(message);
    if (
      !this._canPlay() ||
      (this.entityid && !this._connection.connection.connected)
    ) {
      return;
    }
    if (this._recoveryTimer !== undefined) return;
    if (this._recoveryAttempts >= MAX_RECOVERY_ATTEMPTS) {
      this._setFatalError(message);
      return;
    }
    this._recoveryAttempts += 1;
    this._recoveryTimer = window.setTimeout(() => {
      this._recoveryTimer = undefined;
      this._refreshSource(true);
    }, this._recoveryAttempts * 1000);
  }

  private _cleanUp() {
    this._playbackGeneration += 1;
    this._playing = false;
    this._playlistAbort?.abort();
    this._playlistAbort = undefined;
    this._clearRecoveryTimer();
    this._nativeCleanup?.();
    this._nativeCleanup = undefined;
    if (this._hlsPolyfillInstance) {
      this._hlsPolyfillInstance.destroy();
      this._hlsPolyfillInstance = undefined;
    }
    if (this._exoPlayer) {
      window.removeEventListener("resize", this._resizeExoPlayer);
      this._config.auth.external!.fireMessage({ type: "exoplayer/stop" });
      this._exoPlayer = false;
    }
    if (this._videoEl && !this._isPictureInPicture()) {
      this._videoEl.removeAttribute("src");
      this._videoEl.load();
    }
  }

  private _resetError() {
    this._error = undefined;
    this._errorIsFatal = false;
  }

  private _setFatalError(errorMessage: string) {
    this._invalidateUrlRequest();
    this._cleanUp();
    this._error = errorMessage;
    this._errorIsFatal = true;
    fireEvent(this, "streams", { hasAudio: false, hasVideo: false });
  }

  private _setRetryableError(errorMessage: string) {
    this._error = errorMessage;
    this._errorIsFatal = false;
  }

  private _reportStreams(codecs?: string) {
    const codec = codecs?.split(",");
    fireEvent(this, "streams", {
      hasAudio: codec?.includes("mp4a") ?? false,
      hasVideo: codec?.includes("mp4a")
        ? codec?.length > 1
        : Boolean(codec?.length),
    });
  }

  private _loadedData() {
    if (!this._playing) return;
    this._recoveryAttempts = 0;
    this._clearRecoveryTimer();
    this._resetError();
    fireEvent(this, "load");
  }

  static styles = css`
    :host,
    video {
      display: block;
    }

    video {
      width: 100%;
      max-height: var(--video-max-height, calc(100vh - 97px));
    }

    .fatal {
      display: block;
      padding: 100px 16px;
    }

    .retry {
      display: block;
    }
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-hls-player": HaHLSPlayer;
  }
}
