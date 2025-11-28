import { db } from '../db';

const SONOS_API_BASE = 'https://api.ws.sonos.com/control/api/v1';

interface SonosTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
}

interface SonosHousehold {
  id: string;
  name: string;
}

interface SonosGroup {
  id: string;
  name: string;
  coordinatorId: string;
  playbackState: string;
}

interface SonosGroupsResponse {
  groups: SonosGroup[];
  players: unknown[];
}

export class SonosClient {
  private userId: string;
  private tokens: SonosTokens | null = null;

  constructor(userId: string) {
    this.userId = userId;
  }

  private async loadTokens(): Promise<SonosTokens | null> {
    if (this.tokens) {
      return this.tokens;
    }

    const row = db
      .query<
        { access_token: string; refresh_token: string; expires_at: number },
        [string]
      >('SELECT access_token, refresh_token, expires_at FROM sonos_accounts WHERE user_id = ?')
      .get(this.userId);

    if (!row) {
      return null;
    }

    this.tokens = {
      accessToken: row.access_token,
      refreshToken: row.refresh_token,
      expiresAt: row.expires_at,
    };

    return this.tokens;
  }

  private async refreshTokenIfNeeded(): Promise<boolean> {
    const tokens = await this.loadTokens();
    if (!tokens) return false;

    // Refresh if expires within 5 minutes
    const now = Math.floor(Date.now() / 1000);
    if (tokens.expiresAt - now > 300) {
      return true;
    }

    const clientId = Bun.env.SONOS_CLIENT_ID;
    const clientSecret = Bun.env.SONOS_CLIENT_SECRET;

    if (!clientId || !clientSecret) {
      console.error('[Sonos] Missing SONOS_CLIENT_ID or SONOS_CLIENT_SECRET');
      return false;
    }

    try {
      const response = await fetch('https://api.sonos.com/login/v3/oauth/access', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          Authorization: `Basic ${btoa(`${clientId}:${clientSecret}`)}`,
        },
        body: new URLSearchParams({
          grant_type: 'refresh_token',
          refresh_token: tokens.refreshToken,
        }),
      });

      if (!response.ok) {
        console.error('[Sonos] Token refresh failed:', response.status);
        // Clear tokens on failure
        db.query('DELETE FROM sonos_accounts WHERE user_id = ?').run(this.userId);
        this.tokens = null;
        return false;
      }

      const data = (await response.json()) as {
        access_token: string;
        refresh_token: string;
        expires_in: number;
      };

      const newExpiresAt = now + data.expires_in;

      db.query(
        'UPDATE sonos_accounts SET access_token = ?, refresh_token = ?, expires_at = ?, updated_at = unixepoch() WHERE user_id = ?'
      ).run(data.access_token, data.refresh_token, newExpiresAt, this.userId);

      this.tokens = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        expiresAt: newExpiresAt,
      };

      return true;
    } catch (error) {
      console.error('[Sonos] Token refresh error:', error);
      return false;
    }
  }

  private async request<T>(endpoint: string, options: RequestInit = {}): Promise<T | null> {
    const ready = await this.refreshTokenIfNeeded();
    if (!ready || !this.tokens) {
      return null;
    }

    const response = await fetch(`${SONOS_API_BASE}${endpoint}`, {
      ...options,
      headers: {
        ...options.headers,
        Authorization: `Bearer ${this.tokens.accessToken}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      console.error(`[Sonos] API error ${response.status}:`, await response.text());
      return null;
    }

    return response.json() as Promise<T>;
  }

  async getHouseholds(): Promise<SonosHousehold[] | null> {
    const result = await this.request<{ households: SonosHousehold[] }>('/households');
    return result?.households ?? null;
  }

  async getGroups(householdId: string): Promise<SonosGroup[] | null> {
    const result = await this.request<SonosGroupsResponse>(`/households/${householdId}/groups`);
    return result?.groups ?? null;
  }

  async loadStreamUrl(
    sessionId: string,
    streamUrl: string,
    playOnCompletion = true
  ): Promise<boolean> {
    const result = await this.request(
      `/playbackSessions/${sessionId}/playbackSession/loadStreamUrl`,
      {
        method: 'POST',
        body: JSON.stringify({
          streamUrl,
          playOnCompletion,
        }),
      }
    );

    return result !== null;
  }

  async createPlaybackSession(groupId: string): Promise<string | null> {
    // First get household ID from stored account
    const row = db
      .query<
        { household_id: string },
        [string]
      >('SELECT household_id FROM sonos_accounts WHERE user_id = ?')
      .get(this.userId);

    if (!row?.household_id) {
      return null;
    }

    const result = await this.request<{ sessionId: string }>(
      `/households/${row.household_id}/groups/${groupId}/playbackSession`,
      { method: 'POST' }
    );

    return result?.sessionId ?? null;
  }

  get isLinked(): boolean {
    const row = db
      .query<{ user_id: string }, [string]>('SELECT user_id FROM sonos_accounts WHERE user_id = ?')
      .get(this.userId);
    return !!row;
  }
}
