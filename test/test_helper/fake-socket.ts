import type { Connection, MessageBase } from "home-assistant-js-websocket";

interface SocketCommand extends MessageBase {
  id: number;
  subscription?: number;
  event?: unknown;
  event_type?: string;
}

// Only the wire endpoint is fake; tests use the real Connection implementation.
export class FakeSocket extends EventTarget {
  public readonly OPEN = 1;

  public readyState = this.OPEN;

  public haVersion = "2026.9.3";

  public sent: SocketCommand[] = [];

  public subscriptions = new Map<number, string>();

  public deferredTypes = new Set<string>();

  public send(payload: string): void {
    const message = JSON.parse(payload) as SocketCommand;
    this.sent.push(message);
    if (message.type === "unsubscribe_events") {
      this.subscriptions.delete(message.subscription!);
    } else if (
      message.type === "subscribe_events" ||
      message.type === "camera/webrtc/offer"
    ) {
      this.subscriptions.set(message.id, message.event_type ?? message.type);
    }
    if (!this.deferredTypes.has(message.type)) {
      queueMicrotask(() => this.acknowledge(message.id));
    }
  }

  public acknowledge(id: number, result?: unknown): void {
    if (this.readyState === this.OPEN) {
      this.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({ id, type: "result", success: true, result }),
        })
      );
    }
  }

  public reject(id: number, message: string): void {
    this.subscriptions.delete(id);
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          id,
          type: "result",
          success: false,
          error: { code: "failed", message },
        }),
      })
    );
  }

  public emitEvent(id: number, event: unknown): void {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({ id, type: "event", event }),
      })
    );
  }

  public close(): void {
    if (this.readyState !== this.OPEN) {
      return;
    }
    this.readyState = 3;
    this.subscriptions.clear();
    this.dispatchEvent(new Event("close"));
  }

  public asWebSocket(): NonNullable<Connection["socket"]> {
    return this as unknown as NonNullable<Connection["socket"]>;
  }
}
