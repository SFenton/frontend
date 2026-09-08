import { consume, type ContextType } from "@lit/context";
import type { Connection, UnsubscribeFunc } from "home-assistant-js-websocket";
import type { PropertyValues, TemplateResult } from "lit";
import { css, html, LitElement } from "lit";
import { customElement, property, query, state } from "lit/decorators";
import { ifDefined } from "lit/directives/if-defined";
import { styleMap } from "lit/directives/style-map";
import { fireEvent } from "../common/dom/fire_event";
import {
  addWebRtcCandidate,
  fetchWebRtcClientConfiguration,
  type WebRtcAnswer,
  type WebRTCClientConfiguration,
  webRtcOffer,
  type WebRtcOfferEvent,
} from "../data/camera";
import { apiContext, connectionContext } from "../data/context";
import "./ha-alert";

const HIDDEN_CLEANUP_DELAY = 60000;

/**
 * A WebRTC stream is established by first sending an offer through a signal
 * path via an integration. An answer is returned, then the rest of the stream
 * is handled entirely client side.
 */
@customElement("ha-web-rtc-player")
class HaWebRtcPlayer extends LitElement {
  @state()
  @consume({ context: apiContext, subscribe: true })
  private _api!: ContextType<typeof apiContext>;

  @state()
  @consume({ context: connectionContext, subscribe: true })
  private _connection!: ContextType<typeof connectionContext>;

  @property() public entityid?: string;

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

  @property({ attribute: "poster-url" }) public posterUrl?: string;

  @state() private _error?: string;

  @query("#remote-stream") private _videoEl!: HTMLVideoElement;

  private _peerConnection?: RTCPeerConnection;

  private _remoteStream?: MediaStream;

  private _unsub?: UnsubscribeFunc;

  private _offerAbort?: AbortController;

  private _negotiationGeneration = 0;

  private _sessionId?: string;

  private _candidatesList: RTCIceCandidate[] = [];

  private _hiddenCleanupTimeout?: number;

  private _startGeneration = 0;

  private _startedEntityId?: string;

  private _startedSocket?: Connection["socket"];

  private _readyConnection?: Connection;

  private _readySocket?: Connection["socket"];

  private _pictureInPictureReconnect?: {
    connection: Connection;
    entityId: string;
    expires: number;
  };

  private _timerRunning = false;

  private _handleVisibilityChange = () => {
    if (this._isPictureInPicture()) {
      // video is playing in picture-in-picture mode, don't do anything
      return;
    }
    if (document.hidden) {
      this._scheduleHiddenCleanup();
    } else if (this._hiddenCleanupTimeout) {
      // stream was not cleaned up yet, just cancel the cleanup
      clearTimeout(this._hiddenCleanupTimeout);
      this._hiddenCleanupTimeout = undefined;
    } else {
      this._startWebRtc();
    }
  };

  private _scheduleHiddenCleanup(delay = HIDDEN_CLEANUP_DELAY): void {
    clearTimeout(this._hiddenCleanupTimeout);
    this._hiddenCleanupTimeout = window.setTimeout(() => {
      this._hiddenCleanupTimeout = undefined;
      if (document.hidden && !this._isPictureInPicture()) {
        this._cleanUp();
      }
    }, delay);
  }

  private _handleConnectionReady = () => {
    this._attachSocketCloseListener();
    clearTimeout(this._hiddenCleanupTimeout);
    this._hiddenCleanupTimeout = undefined;
    this._startWebRtc();
  };

  private _handleConnectionDisconnected = () => {
    if (this._isPictureInPicture() && this._readyConnection && this.entityid) {
      // Stopping tracks can end PiP before the replacement socket is ready.
      this._pictureInPictureReconnect = {
        connection: this._readyConnection,
        entityId: this.entityid,
        expires: Date.now() + HIDDEN_CLEANUP_DELAY,
      };
    }
    this._detachSocketCloseListener();
    clearTimeout(this._hiddenCleanupTimeout);
    this._hiddenCleanupTimeout = undefined;
    this._cleanUp();
  };

  private _handleSocketClose = (event: Event) => {
    if (event.currentTarget === this._readySocket) {
      this._handleConnectionDisconnected();
    }
  };

  private _attachSocketCloseListener(): void {
    const socket = this._readyConnection?.socket;
    if (socket === this._readySocket) return;
    this._detachSocketCloseListener();
    this._readySocket = socket;
    socket?.addEventListener("close", this._handleSocketClose);
  }

  private _detachSocketCloseListener(): void {
    this._readySocket?.removeEventListener("close", this._handleSocketClose);
    this._readySocket = undefined;
  }

  private _isPictureInPicture(): boolean {
    const video = this._videoEl;
    return Boolean(
      video &&
      (document.pictureInPictureElement === video ||
        document.pictureInPictureElement === this ||
        this.shadowRoot?.pictureInPictureElement === video)
    );
  }

  protected override render(): TemplateResult {
    if (this._error) {
      return html`<ha-alert alert-type="error">${this._error}</ha-alert>`;
    }
    return html`
      <video
        id="remote-stream"
        ?autoplay=${this.autoPlay}
        .muted=${this.muted}
        ?playsinline=${this.playsInline}
        ?controls=${this.controls}
        poster=${ifDefined(this.posterUrl)}
        @loadeddata=${this._loadedData}
        @leavepictureinpicture=${this._handleVisibilityChange}
        style=${styleMap({
          height: this.aspectRatio == null ? "100%" : "auto",
          aspectRatio: this.aspectRatio,
          objectFit: this.fitMode,
        })}
      ></video>
    `;
  }

  public override connectedCallback() {
    super.connectedCallback();
    this._attachReadyListener();
    if (this.hasUpdated && this.entityid) {
      this._startWebRtc();
    }
    document.addEventListener("visibilitychange", this._handleVisibilityChange);
  }

  public override disconnectedCallback() {
    super.disconnectedCallback();
    document.removeEventListener(
      "visibilitychange",
      this._handleVisibilityChange
    );
    this._detachReadyListener();
    clearTimeout(this._hiddenCleanupTimeout);
    this._hiddenCleanupTimeout = undefined;
    this._cleanUp();
  }

  protected override willUpdate(changedProperties: PropertyValues) {
    super.willUpdate(changedProperties);
    const connectionChanged =
      changedProperties.has("_connection") && this._attachReadyListener();
    if (
      changedProperties.has("entityid") ||
      (connectionChanged && this.hasUpdated)
    ) {
      this._startWebRtc();
    }
  }

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
    this._attachSocketCloseListener();
    return true;
  }

  private _detachReadyListener(): void {
    this._pictureInPictureReconnect = undefined;
    this._detachSocketCloseListener();
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

  private async _startWebRtc(): Promise<void> {
    const presentation = this._pictureInPictureReconnect;
    this._pictureInPictureReconnect = undefined;
    const presentationDeadline = this._isPictureInPicture()
      ? Date.now() + HIDDEN_CLEANUP_DELAY
      : presentation &&
          presentation.connection === this._connection?.connection &&
          presentation.entityId === this.entityid &&
          presentation.expires > Date.now()
        ? presentation.expires
        : undefined;
    this._cleanUp();
    const startGeneration = this._startGeneration;
    if (
      !this.isConnected ||
      (document.hidden && presentationDeadline === undefined)
    ) {
      return;
    }

    // Browser support required for WebRTC
    if (typeof RTCPeerConnection === "undefined") {
      this._error = "WebRTC is not supported in this browser";
      fireEvent(this, "streams", { hasAudio: false, hasVideo: false });
      return;
    }

    if (
      !this._api ||
      !this._connection?.connection.connected ||
      !this.entityid
    ) {
      return;
    }
    if (
      document.hidden &&
      presentationDeadline !== undefined &&
      !this._isPictureInPicture()
    ) {
      // Finish the admitted recovery, but retain the normal hidden cleanup limit.
      this._scheduleHiddenCleanup(
        Math.max(0, presentationDeadline - Date.now())
      );
    }
    this._startedEntityId = this.entityid;
    this._startedSocket = this._connection.connection.socket;

    this._error = undefined;

    this._startTimer();

    this._logEvent("start clientConfig");

    let clientConfig: WebRTCClientConfiguration;
    try {
      clientConfig = await fetchWebRtcClientConfiguration(
        this._api,
        this.entityid
      );
    } catch (error: unknown) {
      this._fail(
        "Failed to load WebRTC configuration: ",
        error,
        startGeneration
      );
      return;
    }

    if (!this._isCurrent(startGeneration)) {
      return;
    }

    this._logEvent("end clientConfig", clientConfig);
    try {
      const peer = new RTCPeerConnection(clientConfig.configuration);
      this._peerConnection = peer;
      if (clientConfig.dataChannel) {
        // Some cameras (such as nest) require a data channel to establish a stream
        // however, not used by any integrations.
        peer.createDataChannel(clientConfig.dataChannel);
      }

      peer.onnegotiationneeded = () =>
        this._startNegotiation(peer, startGeneration);
      peer.onicecandidate = (event) =>
        this._handleIceCandidate(event, peer, startGeneration);
      peer.oniceconnectionstatechange = () => {
        if (this._isCurrent(startGeneration, peer)) {
          this._iceConnectionStateChanged();
        }
      };

      // just for debugging
      peer.onsignalingstatechange = (ev) => {
        if (!this._isCurrent(startGeneration, peer)) return;
        switch ((ev.target as RTCPeerConnection).signalingState) {
          case "stable":
            this._logEvent("ICE negotiation complete");
            break;
          default:
            this._logEvent(
              "Signaling state changed",
              (ev.target as RTCPeerConnection).signalingState
            );
        }
      };

      // Setup callbacks to render remote stream once media tracks are discovered.
      this._remoteStream = new MediaStream();
      peer.ontrack = (event) => this._addTrack(event, peer, startGeneration);
      peer.addTransceiver("audio", { direction: "recvonly" });
      peer.addTransceiver("video", { direction: "recvonly" });
    } catch (error: unknown) {
      this._fail("Failed to start WebRTC stream: ", error, startGeneration);
    }
  }

  private _isCurrent(generation: number, peer?: RTCPeerConnection): boolean {
    return (
      this.isConnected &&
      generation === this._startGeneration &&
      this.entityid === this._startedEntityId &&
      this._connection?.connection === this._readyConnection &&
      this._readyConnection?.socket === this._startedSocket &&
      (!peer || peer === this._peerConnection)
    );
  }

  private _fail(prefix: string, error: unknown, generation: number): void {
    if (!this._isCurrent(generation)) return;
    const message =
      error && typeof error === "object" && "message" in error
        ? String(error.message)
        : String(error);
    this._error = prefix + message;
    this._cleanUp();
  }

  private async _startNegotiation(
    peerConnection: RTCPeerConnection,
    startGeneration: number
  ) {
    if (
      !this._isCurrent(startGeneration, peerConnection) ||
      !this._connection.connection.connected
    ) {
      return;
    }
    const negotiationGeneration = ++this._negotiationGeneration;
    this._offerAbort?.abort();
    this._unsubscribeOffer();
    const controller = new AbortController();
    this._offerAbort = controller;
    this._sessionId = undefined;
    const isCurrent = () =>
      this._isCurrent(startGeneration, peerConnection) &&
      negotiationGeneration === this._negotiationGeneration &&
      !controller.signal.aborted;

    try {
      const offerOptions: RTCOfferOptions = {
        offerToReceiveAudio: true,
        offerToReceiveVideo: true,
      };

      this._logEvent("start createOffer", offerOptions);

      const offer: RTCSessionDescriptionInit =
        await peerConnection.createOffer(offerOptions);

      if (!isCurrent()) {
        return;
      }

      this._logEvent("end createOffer", offer);

      this._logEvent("start setLocalDescription");

      await peerConnection.setLocalDescription(offer);

      if (!isCurrent() || !this.entityid) {
        return;
      }

      this._logEvent("end setLocalDescription");

      let candidates = "";

      while (this._candidatesList.length) {
        const candidate = this._candidatesList.pop();
        if (candidate) {
          candidates += `a=${candidate.candidate}\r\n`;
        }
      }

      const offer_sdp = offer.sdp! + candidates;

      this._logEvent("start webRtcOffer", offer_sdp);

      const unsubscribe = await webRtcOffer(
        this._connection,
        this.entityid,
        offer_sdp,
        (event) => {
          if (isCurrent()) {
            this._handleOfferEvent(
              event,
              peerConnection,
              startGeneration,
              isCurrent
            );
          }
        },
        controller.signal
      );
      if (!isCurrent()) {
        await unsubscribe();
        return;
      }
      this._unsub = unsubscribe;
    } catch (error: unknown) {
      if (isCurrent()) {
        this._fail("Failed to start WebRTC stream: ", error, startGeneration);
      }
    }
  }

  private _iceConnectionStateChanged = () => {
    this._logEvent(
      "ice connection state change",
      this._peerConnection?.iceConnectionState
    );
    if (this._peerConnection?.iceConnectionState === "failed") {
      this._peerConnection.restartIce();
    }
  };

  private async _handleOfferEvent(
    event: WebRtcOfferEvent,
    peer: RTCPeerConnection,
    generation: number,
    isCurrent: () => boolean
  ) {
    if (!this.entityid || !isCurrent()) {
      return;
    }
    if (event.type === "session") {
      this._sessionId = event.session_id;
      this._candidatesList.forEach((candidate) =>
        this._sendCandidate(candidate, event.session_id, isCurrent)
      );
      this._candidatesList = [];
    }
    if (event.type === "answer") {
      this._logEvent("answer", event.answer);

      this._handleAnswer(event, peer, generation, isCurrent);
    }
    if (event.type === "candidate") {
      this._logEvent("remote ice candidate", event.candidate);

      try {
        // The spdMid or sdpMLineIndex is required so set sdpMid="0" if not
        // sent from the backend.
        const candidate =
          event.candidate.sdpMid || event.candidate.sdpMLineIndex != null
            ? new RTCIceCandidate(event.candidate)
            : new RTCIceCandidate({
                candidate: event.candidate.candidate,
                sdpMid: "0",
              });

        await peer.addIceCandidate(candidate);
      } catch (error: unknown) {
        if (isCurrent()) {
          this._reportCandidateFailure("remote", error);
        }
      }
    }
    if (event.type === "error") {
      this._error = "Failed to start WebRTC stream: " + event.message;
      this._cleanUp();
    }
  }

  private _handleIceCandidate = (
    event: RTCPeerConnectionIceEvent,
    peer: RTCPeerConnection,
    generation: number
  ) => {
    if (
      !this._isCurrent(generation, peer) ||
      !this.entityid ||
      !event.candidate?.candidate
    ) {
      return;
    }

    this._logEvent(
      "local ice candidate",
      event.candidate?.candidate,
      event.candidate?.sdpMLineIndex
    );

    if (this._sessionId) {
      const negotiation = this._negotiationGeneration;
      this._sendCandidate(
        event.candidate,
        this._sessionId,
        () =>
          this._isCurrent(generation, peer) &&
          negotiation === this._negotiationGeneration
      );
    } else {
      this._candidatesList.push(event.candidate);
    }
  };

  private async _sendCandidate(
    candidate: RTCIceCandidate,
    sessionId: string,
    isCurrent: () => boolean
  ): Promise<void> {
    if (
      !isCurrent() ||
      !this.entityid ||
      !this._connection.connection.connected
    ) {
      return;
    }
    try {
      await addWebRtcCandidate(
        this._api,
        this.entityid,
        sessionId,
        candidate.toJSON()
      );
    } catch (error: unknown) {
      if (isCurrent()) {
        this._reportCandidateFailure("local", error);
      }
    }
  }

  private _reportCandidateFailure(
    direction: "remote" | "local",
    error: unknown
  ): void {
    // Other candidates can establish or maintain media after one is rejected.
    // eslint-disable-next-line no-console
    console.warn(`Failed to add ${direction} WebRTC ICE candidate`, error);
  }

  private _addTrack = async (
    event: RTCTrackEvent,
    peer: RTCPeerConnection,
    generation: number
  ) => {
    if (!this._isCurrent(generation, peer) || !this._remoteStream) {
      event.track.stop();
      return;
    }
    // If the track is audio and the player is muted, we do not add it to the stream.
    if (event.track.kind === "audio" && this.muted) {
      return;
    }
    const stream = this._remoteStream;
    stream.addTrack(event.track);
    if (!this.hasUpdated) {
      await this.updateComplete;
    }
    if (this._isCurrent(generation, peer) && this._videoEl) {
      this._videoEl.srcObject = stream;
    }
  };

  private async _handleAnswer(
    event: WebRtcAnswer,
    peer: RTCPeerConnection,
    generation: number,
    isCurrent: () => boolean
  ) {
    if (!isCurrent() || ["stable", "closed"].includes(peer.signalingState)) {
      return;
    }

    // Initiate the stream with the remote device
    try {
      const remoteDesc = new RTCSessionDescription({
        type: "answer",
        sdp: event.answer,
      });
      this._logEvent("start setRemoteDescription", remoteDesc);
      await peer.setRemoteDescription(remoteDesc);
    } catch (error: unknown) {
      if (isCurrent()) {
        this._fail("Failed to connect WebRTC stream: ", error, generation);
      }
    }
    if (isCurrent()) this._logEvent("end setRemoteDescription");
  }

  private _cleanUp() {
    this._startGeneration += 1;
    this._negotiationGeneration += 1;
    this._offerAbort?.abort();
    this._offerAbort = undefined;
    this._startedEntityId = undefined;
    this._startedSocket = undefined;

    if (this._remoteStream) {
      this._remoteStream.getTracks().forEach((track) => {
        track.stop();
      });

      this._remoteStream = undefined;
    }
    const videoEl = this._videoEl;
    if (videoEl && !this._isPictureInPicture()) {
      videoEl.srcObject = null;
      videoEl.removeAttribute("src");
      videoEl.load();
    }
    if (this._peerConnection) {
      this._peerConnection.close();

      this._peerConnection.onnegotiationneeded = null;
      this._peerConnection.onicecandidate = null;
      this._peerConnection.oniceconnectionstatechange = null;
      this._peerConnection.onicegatheringstatechange = null;
      this._peerConnection.ontrack = null;

      // just for debugging
      this._peerConnection.onsignalingstatechange = null;

      this._peerConnection = undefined;

      this._logEvent("stopped");
    }
    this._unsubscribeOffer();
    this._sessionId = undefined;
    this._candidatesList = [];
    this._stopTimer();
  }

  private _unsubscribeOffer(): void {
    const unsubscribe = this._unsub;
    this._unsub = undefined;
    if (unsubscribe) {
      Promise.resolve(unsubscribe()).catch((error: unknown) => {
        // eslint-disable-next-line no-console
        console.error("Failed to unsubscribe WebRTC stream", error);
      });
    }
  }

  private _loadedData() {
    const video = this._videoEl;
    const stream = video?.srcObject as MediaStream | null;
    if (!stream || stream !== this._remoteStream || !this._peerConnection) {
      return;
    }

    const data = {
      hasAudio: Boolean(stream?.getAudioTracks().length),
      hasVideo: Boolean(stream?.getVideoTracks().length),
    };

    fireEvent(this, "load");
    fireEvent(this, "streams", data);

    this._logEvent("loadedData", data);
    this._stopTimer();
  }

  private _startTimer() {
    if (!__DEV__ || this._timerRunning) {
      return;
    }
    // eslint-disable-next-line no-console
    console.time("WebRTC");
    this._timerRunning = true;
  }

  private _stopTimer() {
    if (!__DEV__ || !this._timerRunning) {
      return;
    }
    // eslint-disable-next-line no-console
    console.timeEnd("WebRTC");
    this._timerRunning = false;
  }

  private _logEvent(msg: string, ...args: unknown[]) {
    if (!__DEV__ || !this._timerRunning) {
      return;
    }
    // eslint-disable-next-line no-console
    console.timeLog("WebRTC", msg, ...args);
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
  `;
}

declare global {
  interface HTMLElementTagNameMap {
    "ha-web-rtc-player": HaWebRtcPlayer;
  }
}
