/**
 * Generic SOAP client for Sonos UPnP control
 */

const SONOS_PORT = 1400;

export interface SoapRequestOptions {
  ip: string;
  controlUrl: string;
  serviceType: string;
  action: string;
  params?: Record<string, string | number>;
}

/**
 * Build a SOAP envelope for a UPnP action
 */
export function buildSoapEnvelope(
  action: string,
  serviceType: string,
  params: Record<string, string | number> = {}
): string {
  const paramXml = Object.entries(params)
    .map(([key, value]) => {
      // Escape XML special characters
      const escaped = String(value)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&apos;');
      return `<${key}>${escaped}</${key}>`;
    })
    .join('');

  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" ' +
    's:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    '<s:Body>' +
    `<u:${action} xmlns:u="${serviceType}">` +
    paramXml +
    `</u:${action}>` +
    '</s:Body>' +
    '</s:Envelope>'
  );
}

/**
 * Send a SOAP request to a Sonos speaker
 */
export async function sendSoapRequest(options: SoapRequestOptions): Promise<string> {
  const { ip, controlUrl, serviceType, action, params = {} } = options;

  const url = `http://${ip}:${SONOS_PORT}${controlUrl}`;
  const body = buildSoapEnvelope(action, serviceType, params);
  const soapAction = `"${serviceType}#${action}"`;

  console.log(`[SOAP] ${action} -> ${url}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPAction: soapAction,
    },
    body,
  });

  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[SOAP] Error ${response.status}:`, errorText);
    throw new Error(`SOAP request failed: ${response.status} ${response.statusText}`);
  }

  return response.text();
}

/**
 * Extract a simple text value from SOAP response XML
 * This is a simple regex-based extractor - for complex XML, use a proper parser
 */
export function extractSoapValue(xml: string, tagName: string): string | null {
  const regex = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
  const match = xml.match(regex);
  return match && match[1] !== undefined ? match[1] : null;
}

/**
 * Unescape XML entities
 */
export function unescapeXml(xml: string): string {
  return xml
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}
