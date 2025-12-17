export type paths = Record<string, never>;
export type webhooks = Record<string, never>;
export type components = {
    schemas: {
        /**
         * @description Audio quality preset for streaming
         * @enum {string}
         */
        QualityPreset: "ultra-low" | "low" | "medium" | "high";
        /**
         * @description Audio codec for encoding
         * @enum {string}
         */
        AudioCodec: "he-aac" | "aac-lc" | "mp3";
        /**
         * @description Current status of a stream
         * @enum {string}
         */
        StreamStatus: "starting" | "active" | "stopped" | "error";
        /**
         * @description Sonos connection mode (cloud API vs local UPnP)
         * @enum {string}
         */
        SonosMode: "cloud" | "local";
        /**
         * @description UPnP AVTransport transport states
         * @enum {string}
         */
        TransportState: "PLAYING" | "PAUSED_PLAYBACK" | "STOPPED" | "TRANSITIONING";
        /**
         * @description Sonos UPnP services for GENA subscriptions
         * @enum {string}
         */
        GenaService: "AVTransport" | "ZoneGroupTopology" | "GroupRenderingControl";
        /**
         * @description Structured error codes for error handling
         * @enum {string}
         */
        ErrorCode: "NETWORK_TIMEOUT" | "NETWORK_UNREACHABLE" | "CONNECTION_REFUSED" | "SPEAKER_NOT_FOUND" | "SPEAKER_UNREACHABLE" | "DISCOVERY_FAILED" | "PLAYBACK_FAILED" | "INVALID_STREAM_URL" | "INVALID_IP_ADDRESS" | "INVALID_URL" | "INVALID_REQUEST" | "UNAUTHORIZED" | "SESSION_EXPIRED" | "UNKNOWN_ERROR";
        /** @description Stream metadata for Sonos display (ICY metadata) */
        StreamMetadata: {
            /** @description Song title or tab title */
            title?: string;
            /** @description Artist name */
            artist?: string;
            /** @description Album name */
            album?: string;
            /** @description Album art URL */
            artwork?: string;
        };
        /** @description Minimal speaker info from SSDP discovery */
        Speaker: {
            /** @description Unique identifier from SSDP */
            uuid: string;
            /** @description Local IP address */
            ip: string;
        };
        /** @description Full speaker info including zone name and model */
        LocalSpeaker: {
            /** @description Unique identifier from zone topology */
            uuid: string;
            /** @description Local IP address */
            ip: string;
            /** @description User-configured room name */
            zoneName: string;
            /** @description Sonos device model (e.g., "Sonos One") */
            model: string;
        };
        /** @description Sonos zone group with coordinator and members */
        LocalGroup: {
            /** @description Zone group identifier */
            id: string;
            /** @description Coordinator's zone name */
            name: string;
            /** @description UUID of the group coordinator */
            coordinatorUuid: string;
            /** @description IP address of the group coordinator */
            coordinatorIp: string;
            /** @description Speakers in this group */
            members: components["schemas"]["LocalSpeaker"][];
        };
        /** @description Sonos group from cloud API */
        SonosGroup: {
            /** @description Cloud API group identifier */
            id: string;
            /** @description Group display name */
            name: string;
        };
        /** @description Runtime status of a Sonos group from GENA events */
        GroupStatus: {
            /** @description IP address of the group coordinator */
            coordinatorIp: string;
            transportState: components["schemas"]["TransportState"];
            /** @description Current track/source URI */
            currentUri?: string | null;
            /** @description True if playing our stream, false if playing other source, null if unknown */
            isPlayingOurStream?: boolean | null;
            /** @description Group volume level (0-100) */
            volume: number;
            /** @description Whether the group is muted */
            isMuted: boolean;
        };
        /** @description Complete Sonos state snapshot emitted on any change */
        SonosStateSnapshot: {
            /** @description Zone groups with their members */
            groups: components["schemas"]["LocalGroup"][];
            /** @description Runtime status for each group coordinator */
            group_statuses: components["schemas"]["GroupStatus"][];
            /**
             * Format: uint64
             * @description Number of Sonos devices from last discovery
             */
            discovered_devices: number;
            /**
             * Format: uint64
             * @description Number of active GENA subscriptions
             */
            gena_subscriptions: number;
            /**
             * Format: uint64
             * @description Unix timestamp of last successful speaker discovery
             */
            last_discovery_at?: number | null;
            /** @description True while SSDP discovery is running */
            is_discovering: boolean;
        };
        /** @description Request to create a new audio stream */
        CreateStreamRequest: {
            groupId: string;
            quality: components["schemas"]["QualityPreset"];
            metadata?: components["schemas"]["StreamMetadata"];
            codec?: components["schemas"]["AudioCodec"];
        };
        /** @description Response after creating a stream */
        CreateStreamResponse: {
            streamId: string;
            /** @description WebSocket URL for audio ingest */
            ingestUrl: string;
            /** @description HTTP URL for stream playback */
            playbackUrl: string;
            /** @description Non-fatal issues (e.g., GENA subscription failed) */
            warning?: string;
        };
        /** @description GET /api/me response */
        MeResponse: {
            user: null | {
                id: string;
                email: string;
                name?: string;
            };
            sonosLinked: boolean;
        };
        /** @description GET /api/sonos/status response */
        SonosStatusResponse: {
            linked: boolean;
            householdId?: string;
        };
        /** @description GET /api/sonos/groups response (cloud API) */
        SonosGroupsResponse: {
            householdId: string;
            groups: components["schemas"]["SonosGroup"][];
        };
        /** @description GET /api/local/discover response */
        LocalDiscoveryResponse: {
            speakers: components["schemas"]["Speaker"][];
        };
        /** @description GET /api/local/groups response */
        LocalGroupsResponse: {
            groups: components["schemas"]["LocalGroup"][];
        };
        /** @description Basic API error response */
        ApiError: {
            error: string;
            message: string;
        };
        /** @description Enhanced API error response with structured code */
        ApiErrorResponse: {
            error: string;
            message: string;
            code?: components["schemas"]["ErrorCode"];
            details?: {
                [key: string]: unknown;
            };
        };
        /** @description GENA subscription info stored per speaker/service */
        GenaSubscription: {
            /** @description Subscription ID from SUBSCRIBE response */
            sid: string;
            speakerIp: string;
            service: components["schemas"]["GenaService"];
            /**
             * Format: int64
             * @description Unix timestamp when subscription expires
             */
            expiresAt: number;
            callbackPath: string;
        };
        /** @description Transport state change event from Sonos speaker */
        TransportStateEvent: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "transportState";
            state: components["schemas"]["TransportState"];
            speakerIp: string;
            /** Format: int64 */
            timestamp: number;
        };
        /** @description Zone group topology change event */
        ZoneChangeEvent: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "zoneChange";
            /** Format: int64 */
            timestamp: number;
        };
        /** @description Source changed event - fired when Sonos switches audio source */
        SourceChangedEvent: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "sourceChanged";
            currentUri: string;
            expectedUri?: string | null;
            speakerIp: string;
            /** Format: int64 */
            timestamp: number;
        };
        /** @description Group volume change event from GroupRenderingControl */
        GroupVolumeChangeEvent: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "groupVolume";
            volume: number;
            speakerIp: string;
            /** Format: int64 */
            timestamp: number;
        };
        /** @description Group mute state change event from GroupRenderingControl */
        GroupMuteChangeEvent: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "groupMute";
            mute: boolean;
            speakerIp: string;
            /** Format: int64 */
            timestamp: number;
        };
        /** @description Zone groups have been updated (from ZoneGroupTopology GENA event) */
        ZoneGroupsUpdatedEvent: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "zoneGroupsUpdated";
            groups: components["schemas"]["LocalGroup"][];
            /** Format: int64 */
            timestamp: number;
        };
        /** @description GENA subscription was lost and needs recovery */
        SubscriptionLostEvent: {
            /**
             * @description discriminator enum property added by openapi-typescript
             * @enum {string}
             */
            type: "subscriptionLost";
            speakerIp: string;
            /** Format: int64 */
            timestamp: number;
        };
        /** @description Union type for all Sonos events sent via WebSocket */
        SonosEvent: components["schemas"]["TransportStateEvent"] | components["schemas"]["ZoneChangeEvent"] | components["schemas"]["SourceChangedEvent"] | components["schemas"]["GroupVolumeChangeEvent"] | components["schemas"]["GroupMuteChangeEvent"] | components["schemas"]["ZoneGroupsUpdatedEvent"] | components["schemas"]["SubscriptionLostEvent"];
        /** @description Tauri get_status command response */
        StatusResponse: {
            server_running: boolean;
            /**
             * Format: uint16
             * @description HTTP server port
             */
            port: number;
            /**
             * Format: uint16
             * @description GENA listener port (null if not started)
             */
            gena_port?: number | null;
            /** @description Local network IP address */
            local_ip?: string | null;
            /** Format: uint64 */
            active_streams: number;
            /**
             * Format: uint64
             * @description Number of Sonos devices from last discovery
             */
            discovered_devices: number;
            /**
             * Format: uint64
             * @description Number of active GENA subscriptions
             */
            gena_subscriptions: number;
            /**
             * Format: uint64
             * @description Number of connected WebSocket clients (extensions)
             */
            connected_clients: number;
            /** @description Non-fatal errors encountered during startup */
            startup_errors?: string[];
            /**
             * Format: uint64
             * @description Unix timestamp of last successful speaker discovery
             */
            last_discovery_at?: number | null;
        };
        /** @description Tauri get_config command response */
        ConfigResponse: {
            /** Format: uint16 */
            port: number;
        };
        /**
         * @description WebSocket command actions
         * @enum {string}
         */
        WsAction: "getGroups" | "getVolume" | "setVolume" | "getMute" | "setMute" | "play" | "stop" | "createStream" | "stopStream" | "updateMetadata" | "discover";
        /** @description WebSocket command from client to server */
        WsCommand: {
            /** @description Unique request ID for response correlation */
            id: string;
            action: components["schemas"]["WsAction"];
            /** @description Action-specific payload data */
            payload?: {
                [key: string]: unknown;
            };
        };
        /** @description WebSocket response from server to client */
        WsResponse: {
            /** @description Request ID this response correlates to */
            id: string;
            success: boolean;
            /** @description Response payload on success */
            data?: {
                [key: string]: unknown;
            };
            /** @description Error message on failure */
            error?: string;
        };
        /** @description Event sent on WebSocket connection with initial state */
        WsConnectedEvent: {
            /** @constant */
            type: "connected";
            state: components["schemas"]["SonosStateSnapshot"];
        };
    };
    responses: never;
    parameters: never;
    requestBodies: never;
    headers: never;
    pathItems: never;
};
export type $defs = Record<string, never>;
export type operations = Record<string, never>;

// Type aliases for easier consumption
export type QualityPreset = components["schemas"]["QualityPreset"];
export type AudioCodec = components["schemas"]["AudioCodec"];
export type StreamStatus = components["schemas"]["StreamStatus"];
export type SonosMode = components["schemas"]["SonosMode"];
export type TransportState = components["schemas"]["TransportState"];
export type GenaService = components["schemas"]["GenaService"];
export type ErrorCode = components["schemas"]["ErrorCode"];
export type StreamMetadata = components["schemas"]["StreamMetadata"];
export type Speaker = components["schemas"]["Speaker"];
export type LocalSpeaker = components["schemas"]["LocalSpeaker"];
export type LocalGroup = components["schemas"]["LocalGroup"];
export type SonosGroup = components["schemas"]["SonosGroup"];
export type GroupStatus = components["schemas"]["GroupStatus"];
export type SonosStateSnapshot = components["schemas"]["SonosStateSnapshot"];
export type CreateStreamRequest = components["schemas"]["CreateStreamRequest"];
export type CreateStreamResponse = components["schemas"]["CreateStreamResponse"];
export type MeResponse = components["schemas"]["MeResponse"];
export type SonosStatusResponse = components["schemas"]["SonosStatusResponse"];
export type SonosGroupsResponse = components["schemas"]["SonosGroupsResponse"];
export type LocalDiscoveryResponse = components["schemas"]["LocalDiscoveryResponse"];
export type LocalGroupsResponse = components["schemas"]["LocalGroupsResponse"];
export type ApiError = components["schemas"]["ApiError"];
export type ApiErrorResponse = components["schemas"]["ApiErrorResponse"];
export type GenaSubscription = components["schemas"]["GenaSubscription"];
export type TransportStateEvent = components["schemas"]["TransportStateEvent"];
export type ZoneChangeEvent = components["schemas"]["ZoneChangeEvent"];
export type SourceChangedEvent = components["schemas"]["SourceChangedEvent"];
export type GroupVolumeChangeEvent = components["schemas"]["GroupVolumeChangeEvent"];
export type GroupMuteChangeEvent = components["schemas"]["GroupMuteChangeEvent"];
export type ZoneGroupsUpdatedEvent = components["schemas"]["ZoneGroupsUpdatedEvent"];
export type SubscriptionLostEvent = components["schemas"]["SubscriptionLostEvent"];
export type SonosEvent = components["schemas"]["SonosEvent"];
export type StatusResponse = components["schemas"]["StatusResponse"];
export type ConfigResponse = components["schemas"]["ConfigResponse"];
export type WsAction = components["schemas"]["WsAction"];
export type WsCommand = components["schemas"]["WsCommand"];
export type WsResponse = components["schemas"]["WsResponse"];
export type WsConnectedEvent = components["schemas"]["WsConnectedEvent"];
