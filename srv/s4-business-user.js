// Resolves an S/4HANA Cloud business user's e-mail address from the user ID via the SOAP service
// "Business User - Read" (communication scenario SAP_COM_0093, QUERYBUSINESSUSERIN).
// Results are cached per process; a missing e-mail resolves to null (the caller falls back).
const { executeHttpRequest } = require('@sap-cloud-sdk/http-client');

const DESTINATION = process.env.S4_JOB_LOG_DESTINATION || 'S4HC_JournalEntry';
const SERVICE_PATH = '/sap/bc/srt/scs_ext/sap/querybusinessuserin';
// The request element must be in the ABA namespace and the SOAPAction header must be set;
// other namespace / header combinations are rejected by the service with a generic fault.
const SOAP_ACTION = 'http://sap.com/xi/ABA/QueryBusinessUserIn/QueryBusinessUserInRequest';
const cache = new Map();

function escapeXml(value) {
  return String(value).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
}

function envelope(userId) {
  return `<soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:aba="http://sap.com/xi/ABA">
  <soapenv:Header/>
  <soapenv:Body>
    <aba:BusinessUserSimpleByElementsQuery_sync>
      <BusinessUser>
        <UserIDInterval>
          <IntervalBoundaryTypeCode>1</IntervalBoundaryTypeCode>
          <LowerBoundaryUserID>${escapeXml(userId)}</LowerBoundaryUserID>
        </UserIDInterval>
      </BusinessUser>
      <QueryProcessingConditions>
        <QueryHitsUnlimitedIndicator>false</QueryHitsUnlimitedIndicator>
      </QueryProcessingConditions>
    </aba:BusinessUserSimpleByElementsQuery_sync>
  </soapenv:Body>
</soapenv:Envelope>`;
}

function text(xml, tag) {
  const match = new RegExp(`<(?:[A-Za-z0-9_]+:)?${tag}>([^<]*)<`).exec(xml);
  return match ? match[1].trim() : '';
}

async function lookupUser(userId) {
  if (!userId) return null;
  if (cache.has(userId)) return cache.get(userId);
  let result = null;
  try {
    const response = await executeHttpRequest({ destinationName: DESTINATION }, {
      method: 'post',
      url: SERVICE_PATH,
      headers: { 'content-type': 'text/xml; charset=utf-8', soapaction: `"${SOAP_ACTION}"` },
      data: envelope(userId),
      timeout: 20000
    }, { fetchCsrfToken: false });
    const xml = String(response.data);
    if (/<soap-env:Fault|<soapenv:Fault/.test(xml)) throw new Error(text(xml, 'faultstring') || 'SOAP fault');
    const email = text(xml, 'EmailAddress');
    const fullName = text(xml, 'PersonFullName') || [text(xml, 'FirstName'), text(xml, 'LastName')].filter(Boolean).join(' ');
    result = { userId, email: email || null, fullName: fullName || null };
  } catch (error) {
    const status = error.cause?.response?.status || error.response?.status;
    console.warn('[BUSINESS_USER] Lookup failed.', { userId, status, message: String(error.message).slice(0, 200) });
  }
  cache.set(userId, result);
  if (cache.size > 2000) cache.clear();
  return result;
}

module.exports = { lookupUser };
