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
