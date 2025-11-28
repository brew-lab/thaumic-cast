// API request/response types shared between server and extension

export type QualityPreset = 'low' | 'medium' | 'high';

export type StreamStatus = 'starting' | 'active' | 'stopped' | 'error';

// GET /api/me
export interface MeResponse {
  user: {
    id: string;
    email: string;
    name?: string;
  } | null;
  sonosLinked: boolean;
}

// GET /api/sonos/groups
export interface SonosGroup {
  id: string;
  name: string;
}

export interface SonosGroupsResponse {
  householdId: string;
  groups: SonosGroup[];
}

// POST /api/streams
export interface CreateStreamRequest {
  groupId: string;
  quality: QualityPreset;
}

export interface CreateStreamResponse {
  streamId: string;
  ingestUrl: string;
  playbackUrl: string;
}

// GET /api/sonos/status
export interface SonosStatusResponse {
  linked: boolean;
  householdId?: string;
}

// Error response
export interface ApiError {
  error: string;
  message: string;
}
