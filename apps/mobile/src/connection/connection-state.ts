/**
 * Connection state manager.
 *
 * Tracks FOUR independent states (locked decision 9). Critically, internet
 * availability is NOT the same as cloud API availability, and the local gateway
 * being reachable is independent of both.
 *
 *   1. shopIdentified        — a shop has been paired (QR/BLE)
 *   2. localGatewayReachable — the gateway responds on the local network
 *   3. internetAvailable     — the device has general internet
 *   4. cloudApiAvailable     — the Inklink Cloud API responds
 */

import type { ConnectionState } from "@inklink/shared-schemas";

const INTERNET_PROBE = "https://clients3.google.com/generate_204";

export class ConnectionManager {
  private state: ConnectionState = {
    shopIdentified: false,
    localGatewayReachable: false,
    internetAvailable: false,
    cloudApiAvailable: false,
  };

  private listeners = new Set<(s: ConnectionState) => void>();

  get snapshot(): ConnectionState {
    return { ...this.state };
  }

  subscribe(fn: (s: ConnectionState) => void): () => void {
    this.listeners.add(fn);
    fn(this.snapshot);
    return () => this.listeners.delete(fn);
  }

  setShopIdentified(v: boolean) {
    this.patch({ shopIdentified: v });
  }

  /** Probe the local gateway reachability (independent of internet). */
  async probeGateway(gatewayBaseOrigin: string): Promise<boolean> {
    const reachable = await this.timed(async () => {
      const res = await fetch(`${gatewayBaseOrigin}/health`);
      return res.ok;
    });
    this.patch({ localGatewayReachable: reachable });
    return reachable;
  }

  /** Probe general internet (independent of cloud API). */
  async probeInternet(): Promise<boolean> {
    const online = await this.timed(async () => {
      const res = await fetch(INTERNET_PROBE, { method: "GET" });
      return res.status === 204 || res.ok;
    });
    this.patch({ internetAvailable: online });
    return online;
  }

  /** Probe the cloud API (distinct from internet). */
  async probeCloud(cloudHealthUrl: string): Promise<boolean> {
    const up = await this.timed(async () => {
      const res = await fetch(cloudHealthUrl);
      return res.ok;
    });
    this.patch({ cloudApiAvailable: up });
    return up;
  }

  private async timed(fn: () => Promise<boolean>, ms = 3000): Promise<boolean> {
    try {
      return await Promise.race([
        fn(),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
      ]);
    } catch {
      return false;
    }
  }

  private patch(p: Partial<ConnectionState>) {
    this.state = { ...this.state, ...p };
    for (const l of this.listeners) l(this.snapshot);
  }
}

/** Human summary used by the UI banner. */
export function describeConnection(s: ConnectionState): string {
  if (!s.shopIdentified) return "No shop connected";
  if (s.localGatewayReachable) {
    return s.internetAvailable
      ? "Connected to shop (local + online)"
      : "Connected to shop (local only)";
  }
  return "Shop paired, gateway unreachable";
}
