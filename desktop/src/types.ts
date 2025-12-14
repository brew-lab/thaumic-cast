// Desktop-specific types that match the Tauri backend responses

/**
 * Status response from the Tauri backend's get_status command
 */
export interface Status {
  server_running: boolean;
  port: number;
  active_streams: number;
  discovered_speakers: number;
}

/**
 * Speaker info from the Tauri backend's get_speakers command
 * Note: This is a simpler type than @thaumic-cast/shared's LocalSpeaker
 * which includes additional fields like zoneName and model
 */
export interface Speaker {
  uuid: string;
  ip: string;
}
