const twilio = require('twilio');

let client = null;

function getTwilioConfig() {
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID } = process.env;
  if (!TWILIO_ACCOUNT_SID || !TWILIO_AUTH_TOKEN || !TWILIO_VERIFY_SERVICE_SID) {
    const err = new Error('Twilio Verify is not configured');
    err.code = 'SMS_NOT_CONFIGURED';
    throw err;
  }
  return { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID };
}

function getClient() {
  if (client) return client;
  const { TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN } = getTwilioConfig();
  client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);
  return client;
}

async function sendPhoneVerification(mobile) {
  const { TWILIO_VERIFY_SERVICE_SID } = getTwilioConfig();
  return getClient().verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verifications.create({
    to: mobile,
    channel: 'sms',
  });
}

async function verifyPhoneCode(mobile, code) {
  const { TWILIO_VERIFY_SERVICE_SID } = getTwilioConfig();
  const result = await getClient().verify.v2.services(TWILIO_VERIFY_SERVICE_SID).verificationChecks.create({
    to: mobile,
    code,
  });
  return result.status === 'approved';
}

module.exports = { sendPhoneVerification, verifyPhoneCode };