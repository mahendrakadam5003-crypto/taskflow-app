const axios = require('axios');
const FormData = require('form-data');

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN || null;
const CHANNEL_ID = process.env.TELEGRAM_CHANNEL_ID || null;

function assertConfigured() {
  if (!TELEGRAM_TOKEN || !CHANNEL_ID) {
    throw new Error('Telegram storage is not configured (missing TELEGRAM_BOT_TOKEN / TELEGRAM_CHANNEL_ID).');
  }
}

async function uploadToTelegram(file) {
  assertConfigured();
  const form = new FormData();
  form.append('chat_id', CHANNEL_ID);
  form.append('document', file.buffer, {
    filename: file.originalname,
    contentType: file.mimetype || 'application/octet-stream'
  });
  let response;
  try {
    response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendDocument`,
      form,
      { headers: form.getHeaders(), maxContentLength: Infinity, maxBodyLength: Infinity }
    );
  } catch (error) {
    throw new Error(`Telegram upload failed: ${error.response?.data?.description || error.message}`);
  }
  if (response.data?.ok === false) {
    throw new Error(`Telegram rejected the attachment: ${response.data.description || 'unknown Telegram API error'}`);
  }
  const result = response.data?.result;
  const document = result?.document || (Array.isArray(result?.photo) ? result.photo[result.photo.length - 1] : null);
  if (!document?.file_id || !result?.message_id) {
    throw new Error(`Telegram response was missing attachment details${response.data?.description ? `: ${response.data.description}` : '.'}`);
  }
  return { fileId: document.file_id, messageId: result.message_id };
}

async function streamFromTelegram(fileId, res, metadata = {}) {
  assertConfigured();
  const fileInfo = await axios.get(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/getFile`, { params: { file_id: fileId } });
  const filePath = fileInfo.data?.result?.file_path;
  if (!filePath) throw new Error('Telegram did not return a file path.');
  const response = await axios.get(`https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${filePath}`, { responseType: 'stream' });
  const filename = metadata.originalName || filePath.split('/').pop() || 'attachment';
  res.setHeader('Content-Disposition', `inline; filename="${String(filename).replace(/["\r\n]/g, '_')}"`);
  if (response.headers['content-type']) res.setHeader('Content-Type', response.headers['content-type']);
  response.data.pipe(res);
}

async function sendLocationToTelegram(latitude, longitude, caption) {
  assertConfigured();
  try {
    const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendLocation`, {
      chat_id: CHANNEL_ID,
      latitude,
      longitude,
      disable_notification: true
    });
    const messageId = response.data?.result?.message_id;
    if (!messageId) throw new Error('Telegram did not return a location message ID.');
    if (caption) {
      await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/editMessageCaption`, {
        chat_id: CHANNEL_ID,
        message_id: messageId,
        caption
      });
    }
    return messageId;
  } catch (error) {
    throw new Error(`Telegram location upload failed: ${error.response?.data?.description || error.message}`);
  }
}

module.exports = { uploadToTelegram, streamFromTelegram, sendLocationToTelegram };
