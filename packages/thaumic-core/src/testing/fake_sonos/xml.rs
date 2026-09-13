//! XML the fake speakers serve and parse, shaped like Sonos S2 firmware
//! output so the crate's real parsers accept it.

use std::net::Ipv4Addr;
use std::sync::Arc;

use quick_xml::events::Event;
use quick_xml::reader::Reader;

use crate::sonos::services::SonosService;
use crate::sonos::types::TransportState;
use crate::sonos::utils::escape_xml;

use super::FakeSpeaker;

const SOAP_ENVELOPE_OPEN: &str = r#"<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body>"#;
const SOAP_ENVELOPE_CLOSE: &str = "</s:Body></s:Envelope>";

/// The AVTransport wire spelling of a transport state.
pub(super) fn transport_state_str(state: TransportState) -> &'static str {
    match state {
        TransportState::Playing => "PLAYING",
        TransportState::Paused => "PAUSED_PLAYBACK",
        TransportState::Stopped => "STOPPED",
        TransportState::Transitioning => "TRANSITIONING",
    }
}

/// `/xml/device_description.xml`, with the fields the discovery parser reads.
pub(super) fn device_description(uuid: &str, name: &str, ip: Ipv4Addr) -> String {
    format!(
        concat!(
            r#"<?xml version="1.0" encoding="utf-8"?>"#,
            r#"<root xmlns="urn:schemas-upnp-org:device-1-0"><device>"#,
            "<deviceType>urn:schemas-upnp-org:device:ZonePlayer:1</deviceType>",
            "<friendlyName>{ip} - Sonos One</friendlyName>",
            "<roomName>{name}</roomName>",
            "<modelName>Sonos One</modelName>",
            "<UDN>uuid:{uuid}</UDN>",
            "</device></root>"
        ),
        ip = ip,
        name = escape_xml(name),
        uuid = uuid
    )
}

/// A successful SOAP response carrying `out` as `<Name>value</Name>` children.
pub(super) fn soap_response(
    service: SonosService,
    action: &str,
    out: &[(String, String)],
) -> String {
    let mut body = String::from(SOAP_ENVELOPE_OPEN);
    body.push_str(&format!(
        r#"<u:{action}Response xmlns:u="{}">"#,
        service.urn()
    ));
    for (name, value) in out {
        body.push_str(&format!("<{name}>{}</{name}>", escape_xml(value)));
    }
    body.push_str(&format!("</u:{action}Response>"));
    body.push_str(SOAP_ENVELOPE_CLOSE);
    body
}

/// A SOAP fault in the shape Sonos sends: `faultstring` is `UPnPError` and
/// the UPnP error code sits in the detail block.
pub(super) fn soap_fault(code: u16, description: &str) -> String {
    format!(
        concat!(
            "{open}<s:Fault><faultcode>s:Client</faultcode><faultstring>UPnPError</faultstring>",
            r#"<detail><UPnPError xmlns="urn:schemas-upnp-org:control-1-0">"#,
            "<errorCode>{code}</errorCode><errorDescription>{description}</errorDescription>",
            "</UPnPError></detail></s:Fault>{close}"
        ),
        open = SOAP_ENVELOPE_OPEN,
        code = code,
        description = escape_xml(description),
        close = SOAP_ENVELOPE_CLOSE
    )
}

/// The arguments of the `<u:{action}>` element of a SOAP request, in order,
/// with their text decoded once (so `CurrentURI` comes back as the URI).
pub(super) fn parse_soap_args(body: &str, action: &str) -> Vec<(String, String)> {
    let mut reader = Reader::from_str(body);
    let mut buf = Vec::new();
    let mut args = Vec::new();
    let mut inside_action = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref element)) => {
                let local = String::from_utf8_lossy(element.local_name().as_ref()).into_owned();
                if !inside_action {
                    if local == action {
                        inside_action = true;
                    }
                } else {
                    let text = reader
                        .read_text(element.name())
                        .ok()
                        .and_then(|t| t.decode().ok())
                        .map(|t| html_escape::decode_html_entities(&t).into_owned())
                        .unwrap_or_default();
                    args.push((local, text));
                }
            }
            Ok(Event::Empty(ref element)) if inside_action => {
                let local = String::from_utf8_lossy(element.local_name().as_ref()).into_owned();
                args.push((local, String::new()));
            }
            Ok(Event::End(ref element)) if inside_action => {
                if element.local_name().as_ref() == action.as_bytes() {
                    break;
                }
            }
            Ok(Event::Eof) | Err(_) => break,
            _ => {}
        }
        buf.clear();
    }

    args
}

/// The `ZoneGroupState` document for `groups`, unescaped.
pub(super) fn zone_group_state(
    groups: &[(Arc<FakeSpeaker>, Vec<Arc<FakeSpeaker>>)],
    port: u16,
) -> String {
    let mut state = String::from("<ZoneGroupState><ZoneGroups>");
    for (coordinator, members) in groups {
        state.push_str(&format!(
            r#"<ZoneGroup Coordinator="{uuid}" ID="{uuid}:1">"#,
            uuid = coordinator.uuid
        ));
        for member in members {
            state.push_str(&format!(
                concat!(
                    r#"<ZoneGroupMember UUID="{uuid}" "#,
                    r#"Location="http://{ip}:{port}/xml/device_description.xml" "#,
                    r#"ZoneName="{name}" Icon="x-rincon-roomicon:living" Configuration="1" "#,
                    r#"SoftwareVersion="83.1-61240" SWGen="2" BootSeq="1" WirelessMode="0"/>"#
                ),
                uuid = member.uuid,
                ip = member.ip,
                port = port,
                name = escape_xml(&member.name)
            ));
        }
        state.push_str("</ZoneGroup>");
    }
    state.push_str("</ZoneGroups><VanishedDevices></VanishedDevices></ZoneGroupState>");
    state
}

fn property_set(properties: &str) -> String {
    format!(
        concat!(
            r#"<?xml version="1.0"?>"#,
            r#"<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">{}</e:propertyset>"#
        ),
        properties
    )
}

/// An AVTransport NOTIFY body: a `LastChange` event with the transport state
/// and current track URI, escaped once as element text like hardware does.
pub(super) fn av_transport_notify(state: TransportState, current_uri: &str) -> String {
    let uri = escape_xml(current_uri);
    let event = format!(
        concat!(
            r#"<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/" "#,
            r#"xmlns:r="urn:schemas-rinconnetworks-com:metadata-1-0/"><InstanceID val="0">"#,
            r#"<TransportState val="{state}"/><CurrentPlayMode val="NORMAL"/>"#,
            r#"<CurrentTrackURI val="{uri}"/><AVTransportURI val="{uri}"/>"#,
            "</InstanceID></Event>"
        ),
        state = transport_state_str(state),
        uri = uri
    );
    property_set(&format!(
        "<e:property><LastChange>{}</LastChange></e:property>",
        escape_xml(&event)
    ))
}

/// A RenderingControl NOTIFY body with Master-channel volume and mute.
pub(super) fn rendering_control_notify(volume: u8, mute: bool) -> String {
    let event = format!(
        concat!(
            r#"<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0">"#,
            r#"<Volume channel="Master" val="{volume}"/><Volume channel="LF" val="100"/>"#,
            r#"<Mute channel="Master" val="{mute}"/></InstanceID></Event>"#
        ),
        volume = volume,
        mute = u8::from(mute)
    );
    property_set(&format!(
        "<e:property><LastChange>{}</LastChange></e:property>",
        escape_xml(&event)
    ))
}

/// A GroupRenderingControl NOTIFY body, which carries plain properties.
pub(super) fn group_rendering_notify(volume: u8, mute: bool) -> String {
    property_set(&format!(
        concat!(
            "<e:property><GroupVolume>{volume}</GroupVolume></e:property>",
            "<e:property><GroupMute>{mute}</GroupMute></e:property>",
            "<e:property><GroupVolumeChangeable>1</GroupVolumeChangeable></e:property>"
        ),
        volume = volume,
        mute = u8::from(mute)
    ))
}

/// A ZoneGroupTopology NOTIFY body carrying `zone_group_state` escaped once.
pub(super) fn zone_group_topology_notify(zone_group_state: &str) -> String {
    property_set(&format!(
        concat!(
            "<e:property><ZoneGroupState>{}</ZoneGroupState></e:property>",
            "<e:property><ThirdPartyMediaServersX></ThirdPartyMediaServersX></e:property>"
        ),
        escape_xml(zone_group_state)
    ))
}
