//! Shared test fixtures for GENA notification payloads.
//!
//! These constants are used by multiple test modules to avoid duplication.

/// Sample RenderingControl NOTIFY body with volume and mute.
/// RenderingControl uses LastChange XML format like AVTransport.
pub const RENDERING_CONTROL_NOTIFY_FULL: &str = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>&lt;Event xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/RCS/&quot;&gt;
      &lt;InstanceID val=&quot;0&quot;&gt;
        &lt;Volume channel=&quot;Master&quot; val=&quot;42&quot;/&gt;
        &lt;Mute channel=&quot;Master&quot; val=&quot;0&quot;/&gt;
      &lt;/InstanceID&gt;
    &lt;/Event&gt;</LastChange>
  </e:property>
</e:propertyset>"#;

/// RenderingControl NOTIFY with muted speaker.
pub const RENDERING_CONTROL_NOTIFY_MUTED: &str = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>&lt;Event xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/RCS/&quot;&gt;
      &lt;InstanceID val=&quot;0&quot;&gt;
        &lt;Volume channel=&quot;Master&quot; val=&quot;75&quot;/&gt;
        &lt;Mute channel=&quot;Master&quot; val=&quot;1&quot;/&gt;
      &lt;/InstanceID&gt;
    &lt;/Event&gt;</LastChange>
  </e:property>
</e:propertyset>"#;

/// RenderingControl NOTIFY with only volume (no mute change).
pub const RENDERING_CONTROL_NOTIFY_VOLUME_ONLY: &str = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>&lt;Event xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/RCS/&quot;&gt;
      &lt;InstanceID val=&quot;0&quot;&gt;
        &lt;Volume channel=&quot;Master&quot; val=&quot;100&quot;/&gt;
      &lt;/InstanceID&gt;
    &lt;/Event&gt;</LastChange>
  </e:property>
</e:propertyset>"#;

/// Stream URI used by the AVTransport fixture below, as Sonos reports it
/// (decoded; the raw payload carries it with `&amp;`).
pub const AV_TRANSPORT_STREAM_URI: &str =
    "x-rincon-mp3radio://192.168.1.50:8080/stream/abc123.mp3?token=t1&fmt=mp3";

/// Realistic AVTransport NOTIFY body (Sonos S2 firmware shape).
///
/// The `LastChange` text is an escaped `<Event>` document whose
/// `CurrentTrackMetaData`, `EnqueuedTransportURIMetaData` and
/// `AVTransportURIMetaData` attributes carry a further-escaped DIDL-Lite
/// document, so the DIDL entities are escaped three deep
/// (`&amp;amp;quot;` -> `&amp;quot;` -> `&quot;` -> `"`). The track title is
/// `Tom's "Work" Tab`, the shape of a browser tab title this project streams.
///
/// Decoding the `LastChange` text twice splices that DIDL into the document as
/// raw markup; the `"` in the title then terminates the `val` attribute early
/// and `CurrentTrackMetaData` truncates to `<DIDL-Lite xmlns:dc=`. quick-xml
/// resynchronises afterwards, so the *other* state variables still parse -
/// see the tests in `gena_parser` for exactly what a double decode does and
/// does not corrupt.
pub const AV_TRANSPORT_NOTIFY_WITH_METADATA: &str = r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><LastChange>&lt;Event xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/AVT/&quot; xmlns:r=&quot;urn:schemas-rinconnetworks-com:metadata-1-0/&quot;&gt;&lt;InstanceID val=&quot;0&quot;&gt;&lt;TransportState val=&quot;PLAYING&quot;/&gt;&lt;CurrentPlayMode val=&quot;NORMAL&quot;/&gt;&lt;CurrentCrossfadeMode val=&quot;0&quot;/&gt;&lt;NumberOfTracks val=&quot;1&quot;/&gt;&lt;CurrentTrack val=&quot;1&quot;/&gt;&lt;CurrentSection val=&quot;0&quot;/&gt;&lt;CurrentTrackURI val=&quot;x-rincon-mp3radio://192.168.1.50:8080/stream/abc123.mp3?token=t1&amp;amp;fmt=mp3&quot;/&gt;&lt;CurrentTrackDuration val=&quot;0:00:00&quot;/&gt;&lt;CurrentTrackMetaData val=&quot;&amp;lt;DIDL-Lite xmlns:dc=&amp;quot;http://purl.org/dc/elements/1.1/&amp;quot; xmlns:upnp=&amp;quot;urn:schemas-upnp-org:metadata-1-0/upnp/&amp;quot; xmlns:r=&amp;quot;urn:schemas-rinconnetworks-com:metadata-1-0/&amp;quot; xmlns=&amp;quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&amp;quot;&amp;gt;&amp;lt;item id=&amp;quot;-1&amp;quot; parentID=&amp;quot;-1&amp;quot; restricted=&amp;quot;true&amp;quot;&amp;gt;&amp;lt;res protocolInfo=&amp;quot;x-rincon-mp3radio:*:audio/mpeg:*&amp;quot;&amp;gt;x-rincon-mp3radio://192.168.1.50:8080/stream/abc123.mp3?token=t1&amp;amp;amp;fmt=mp3&amp;lt;/res&amp;gt;&amp;lt;r:streamContent&amp;gt;Tom&amp;amp;apos;s &amp;amp;quot;Work&amp;amp;quot; Tab&amp;lt;/r:streamContent&amp;gt;&amp;lt;dc:title&amp;gt;Thaumic Cast&amp;lt;/dc:title&amp;gt;&amp;lt;upnp:class&amp;gt;object.item.audioItem.audioBroadcast&amp;lt;/upnp:class&amp;gt;&amp;lt;/item&amp;gt;&amp;lt;/DIDL-Lite&amp;gt;&quot;/&gt;&lt;r:NextTrackURI val=&quot;&quot;/&gt;&lt;r:NextTrackMetaData val=&quot;&quot;/&gt;&lt;r:EnqueuedTransportURI val=&quot;x-rincon-mp3radio://192.168.1.50:8080/stream/abc123.mp3?token=t1&amp;amp;fmt=mp3&quot;/&gt;&lt;r:EnqueuedTransportURIMetaData val=&quot;&amp;lt;DIDL-Lite xmlns:dc=&amp;quot;http://purl.org/dc/elements/1.1/&amp;quot; xmlns:upnp=&amp;quot;urn:schemas-upnp-org:metadata-1-0/upnp/&amp;quot; xmlns:r=&amp;quot;urn:schemas-rinconnetworks-com:metadata-1-0/&amp;quot; xmlns=&amp;quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&amp;quot;&amp;gt;&amp;lt;item id=&amp;quot;-1&amp;quot; parentID=&amp;quot;-1&amp;quot; restricted=&amp;quot;true&amp;quot;&amp;gt;&amp;lt;res protocolInfo=&amp;quot;x-rincon-mp3radio:*:audio/mpeg:*&amp;quot;&amp;gt;x-rincon-mp3radio://192.168.1.50:8080/stream/abc123.mp3?token=t1&amp;amp;amp;fmt=mp3&amp;lt;/res&amp;gt;&amp;lt;r:streamContent&amp;gt;Tom&amp;amp;apos;s &amp;amp;quot;Work&amp;amp;quot; Tab&amp;lt;/r:streamContent&amp;gt;&amp;lt;dc:title&amp;gt;Thaumic Cast&amp;lt;/dc:title&amp;gt;&amp;lt;upnp:class&amp;gt;object.item.audioItem.audioBroadcast&amp;lt;/upnp:class&amp;gt;&amp;lt;/item&amp;gt;&amp;lt;/DIDL-Lite&amp;gt;&quot;/&gt;&lt;PlaybackStorageMedium val=&quot;NETWORK&quot;/&gt;&lt;AVTransportURI val=&quot;x-rincon-mp3radio://192.168.1.50:8080/stream/abc123.mp3?token=t1&amp;amp;fmt=mp3&quot;/&gt;&lt;AVTransportURIMetaData val=&quot;&amp;lt;DIDL-Lite xmlns:dc=&amp;quot;http://purl.org/dc/elements/1.1/&amp;quot; xmlns:upnp=&amp;quot;urn:schemas-upnp-org:metadata-1-0/upnp/&amp;quot; xmlns:r=&amp;quot;urn:schemas-rinconnetworks-com:metadata-1-0/&amp;quot; xmlns=&amp;quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&amp;quot;&amp;gt;&amp;lt;item id=&amp;quot;-1&amp;quot; parentID=&amp;quot;-1&amp;quot; restricted=&amp;quot;true&amp;quot;&amp;gt;&amp;lt;res protocolInfo=&amp;quot;x-rincon-mp3radio:*:audio/mpeg:*&amp;quot;&amp;gt;x-rincon-mp3radio://192.168.1.50:8080/stream/abc123.mp3?token=t1&amp;amp;amp;fmt=mp3&amp;lt;/res&amp;gt;&amp;lt;r:streamContent&amp;gt;Tom&amp;amp;apos;s &amp;amp;quot;Work&amp;amp;quot; Tab&amp;lt;/r:streamContent&amp;gt;&amp;lt;dc:title&amp;gt;Thaumic Cast&amp;lt;/dc:title&amp;gt;&amp;lt;upnp:class&amp;gt;object.item.audioItem.audioBroadcast&amp;lt;/upnp:class&amp;gt;&amp;lt;/item&amp;gt;&amp;lt;/DIDL-Lite&amp;gt;&quot;/&gt;&lt;NextAVTransportURI val=&quot;&quot;/&gt;&lt;NextAVTransportURIMetaData val=&quot;&quot;/&gt;&lt;CurrentTransportActions val=&quot;Set, Play, Stop, Pause, Seek, X_DLNA_SeekTime, X_DLNA_SeekTrackNr&quot;/&gt;&lt;r:SleepTimerGeneration val=&quot;0&quot;/&gt;&lt;r:AlarmRunning val=&quot;0&quot;/&gt;&lt;r:SnoozeRunning val=&quot;0&quot;/&gt;&lt;r:RestartPending val=&quot;0&quot;/&gt;&lt;TransportPlaySpeed val=&quot;NOT_IMPLEMENTED&quot;/&gt;&lt;CurrentMediaDuration val=&quot;NOT_IMPLEMENTED&quot;/&gt;&lt;RecordStorageMedium val=&quot;NOT_IMPLEMENTED&quot;/&gt;&lt;PossiblePlaybackStorageMedia val=&quot;NONE, NETWORK&quot;/&gt;&lt;PossibleRecordStorageMedia val=&quot;NOT_IMPLEMENTED&quot;/&gt;&lt;RecordMediumWriteStatus val=&quot;NOT_IMPLEMENTED&quot;/&gt;&lt;CurrentRecordQualityMode val=&quot;NOT_IMPLEMENTED&quot;/&gt;&lt;PossibleRecordQualityModes val=&quot;NOT_IMPLEMENTED&quot;/&gt;&lt;/InstanceID&gt;&lt;/Event&gt;</LastChange></e:property></e:propertyset>"#;

/// Escaped `ZoneGroupState` text shared by the SOAP and NOTIFY fixtures below.
/// A macro so `concat!` can splice the identical literal into both payloads.
///
/// Three rooms, named `Tom's Office`, `Kitchen & Bar` and `Tom's "Den"`. Every
/// entity is escaped twice here (`&amp;apos;`, `&amp;amp;`, `&amp;quot;`)
/// because Sonos escapes the room name once inside the `ZoneGroupState`
/// document and escapes that whole document again to embed it as element text,
/// so a single decode leaves `ZoneName="Tom&apos;s Office"`.
///
/// The third room earns its place: `'` and `&` both survive a stray second
/// decode by luck (`'` needs no escape once decoded, and a bare `&` makes
/// attribute normalization fail so `get_xml_attr` falls back to the raw text),
/// but a `"` in a decoded name terminates the attribute early and truncates
/// `Tom's "Den"` to `Tom's `. It is the only one of the three that detects a
/// double decode of the `ZoneGroupState`.
macro_rules! zone_group_state_escaped {
    () => {
        r#"&lt;ZoneGroupState&gt;&lt;ZoneGroups&gt;&lt;ZoneGroup Coordinator=&quot;RINCON_000E58AAAAAA01400&quot; ID=&quot;RINCON_000E58AAAAAA01400:12&quot;&gt;&lt;ZoneGroupMember UUID=&quot;RINCON_000E58AAAAAA01400&quot; Location=&quot;http://192.168.1.10:1400/xml/device_description.xml&quot; ZoneName=&quot;Tom&amp;apos;s Office&quot; Icon=&quot;x-rincon-roomicon:office&quot; Configuration=&quot;1&quot; SoftwareVersion=&quot;83.1-61240&quot; SWGen=&quot;2&quot; MinCompatibleVersion=&quot;82.0-00000&quot; LegacyCompatibleVersion=&quot;58.0-00000&quot; BootSeq=&quot;42&quot; TVConfigurationError=&quot;0&quot; HdmiCecAvailable=&quot;0&quot; WirelessMode=&quot;1&quot; WirelessLeafOnly=&quot;0&quot; ChannelFreq=&quot;2412&quot; BehindWifiExtender=&quot;0&quot; WifiEnabled=&quot;1&quot; EthLink=&quot;0&quot; Orientation=&quot;0&quot; RoomCalibrationState=&quot;4&quot; SecureRegState=&quot;3&quot; VoiceConfigState=&quot;0&quot; MicEnabled=&quot;0&quot; AirPlayEnabled=&quot;1&quot; IdleState=&quot;1&quot; MoreInfo=&quot;&quot; SSLPort=&quot;1443&quot; HHSSLPort=&quot;1843&quot;/&gt;&lt;/ZoneGroup&gt;&lt;ZoneGroup Coordinator=&quot;RINCON_000E58BBBBBB01400&quot; ID=&quot;RINCON_000E58BBBBBB01400:34&quot;&gt;&lt;ZoneGroupMember UUID=&quot;RINCON_000E58BBBBBB01400&quot; Location=&quot;http://192.168.1.11:1400/xml/device_description.xml&quot; ZoneName=&quot;Kitchen &amp;amp; Bar&quot; Icon=&quot;x-rincon-roomicon:kitchen&quot; Configuration=&quot;1&quot; SoftwareVersion=&quot;83.1-61240&quot; SWGen=&quot;2&quot; MinCompatibleVersion=&quot;82.0-00000&quot; LegacyCompatibleVersion=&quot;58.0-00000&quot; BootSeq=&quot;42&quot; TVConfigurationError=&quot;0&quot; HdmiCecAvailable=&quot;0&quot; WirelessMode=&quot;1&quot; WirelessLeafOnly=&quot;0&quot; ChannelFreq=&quot;2412&quot; BehindWifiExtender=&quot;0&quot; WifiEnabled=&quot;1&quot; EthLink=&quot;0&quot; Orientation=&quot;0&quot; RoomCalibrationState=&quot;4&quot; SecureRegState=&quot;3&quot; VoiceConfigState=&quot;0&quot; MicEnabled=&quot;0&quot; AirPlayEnabled=&quot;1&quot; IdleState=&quot;1&quot; MoreInfo=&quot;&quot; SSLPort=&quot;1443&quot; HHSSLPort=&quot;1843&quot;/&gt;&lt;/ZoneGroup&gt;&lt;ZoneGroup Coordinator=&quot;RINCON_000E58CCCCCC01400&quot; ID=&quot;RINCON_000E58CCCCCC01400:56&quot;&gt;&lt;ZoneGroupMember UUID=&quot;RINCON_000E58CCCCCC01400&quot; Location=&quot;http://192.168.1.12:1400/xml/device_description.xml&quot; ZoneName=&quot;Tom&amp;apos;s &amp;quot;Den&amp;quot;&quot; Icon=&quot;x-rincon-roomicon:den&quot; Configuration=&quot;1&quot; SoftwareVersion=&quot;83.1-61240&quot; SWGen=&quot;2&quot; MinCompatibleVersion=&quot;82.0-00000&quot; LegacyCompatibleVersion=&quot;58.0-00000&quot; BootSeq=&quot;42&quot; TVConfigurationError=&quot;0&quot; HdmiCecAvailable=&quot;0&quot; WirelessMode=&quot;1&quot; WirelessLeafOnly=&quot;0&quot; ChannelFreq=&quot;2412&quot; BehindWifiExtender=&quot;0&quot; WifiEnabled=&quot;1&quot; EthLink=&quot;0&quot; Orientation=&quot;0&quot; RoomCalibrationState=&quot;4&quot; SecureRegState=&quot;3&quot; VoiceConfigState=&quot;0&quot; MicEnabled=&quot;0&quot; AirPlayEnabled=&quot;1&quot; IdleState=&quot;1&quot; MoreInfo=&quot;&quot; SSLPort=&quot;1443&quot; HHSSLPort=&quot;1843&quot;/&gt;&lt;/ZoneGroup&gt;&lt;/ZoneGroups&gt;&lt;VanishedDevices&gt;&lt;/VanishedDevices&gt;&lt;/ZoneGroupState&gt;"#
    };
}

/// `GetZoneGroupState` SOAP response carrying the escaped `ZoneGroupState`.
///
/// `extract_xml_text` decodes the payload once, yielding a `ZoneGroupState`
/// document whose attributes are still escaped, exactly as Sonos sends them.
pub const ZONE_GROUP_STATE_SOAP_RESPONSE: &str = concat!(
    r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:GetZoneGroupStateResponse xmlns:u="urn:schemas-upnp-org:service:ZoneGroupTopology:1"><ZoneGroupState>"#,
    zone_group_state_escaped!(),
    r#"</ZoneGroupState></u:GetZoneGroupStateResponse></s:Body></s:Envelope>"#
);

/// ZoneGroupTopology NOTIFY body carrying the same escaped `ZoneGroupState`
/// as [`ZONE_GROUP_STATE_SOAP_RESPONSE`], followed by the other properties
/// Sonos sends alongside it.
pub const ZONE_GROUP_TOPOLOGY_NOTIFY: &str = concat!(
    r#"<?xml version="1.0"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0"><e:property><ZoneGroupState>"#,
    zone_group_state_escaped!(),
    r#"</ZoneGroupState></e:property><e:property><ThirdPartyMediaServersX></ThirdPartyMediaServersX></e:property><e:property><AvailableSoftwareUpdate>&lt;UpdateItem xmlns=&quot;urn:schemas-rinconnetworks-com:update-1-0/&quot; Type=&quot;Software&quot; Version=&quot;83.1-61240&quot; UpdateURL=&quot;http://update-firmware.sonos.com/firmware/Gold/83.1-61240-1-1/^83.1-61240&quot; DownloadSize=&quot;0&quot; ManifestURL=&quot;http://update-firmware.sonos.com/firmware/Gold/83.1-61240-1-1/update_manifest.xml&quot;/&gt;</AvailableSoftwareUpdate></e:property><e:property><AlarmRunSequence>RINCON_000E58AAAAAA01400:42:0</AlarmRunSequence></e:property><e:property><ZoneGroupName>Tom&apos;s Office</ZoneGroupName></e:property><e:property><ZoneGroupID>RINCON_000E58AAAAAA01400:12</ZoneGroupID></e:property><e:property><ZonePlayerUUIDsInGroup>RINCON_000E58AAAAAA01400</ZonePlayerUUIDsInGroup></e:property></e:propertyset>"#
);
