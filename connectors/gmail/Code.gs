// Install in the dedicated receipt mailbox. Configure Script Properties first.
function installSamSaku() {
  configBca_();
  const triggers = ScriptApp.getProjectTriggers();
  if (!triggers.some(t => t.getHandlerFunction() === 'syncBca')) {
    ScriptApp.newTrigger('syncBca').timeBased().everyMinutes(5).create();
  }
  if (PropertiesService.getScriptProperties().getProperty('JOB_RUNNER_TOKEN') &&
      !triggers.some(t => t.getHandlerFunction() === 'resumeSamSakuJobs')) {
    ScriptApp.newTrigger('resumeSamSakuJobs').timeBased().everyHours(1).create();
  }
}

function resumeSamSakuJobs() {
  const cfg = configBca_();
  const token = cfg.props.getProperty('JOB_RUNNER_TOKEN');
  if (!token) return;
  const result = UrlFetchApp.fetch(cfg.base + '/v1/jobs/tick', {method: 'post',
    followRedirects: false, muteHttpExceptions: true, headers: {'X-Job-Token': token}});
  if (result.getResponseCode() < 200 || result.getResponseCode() >= 300) {
    throw new Error('SamSaku jobs HTTP ' + result.getResponseCode());
  }
}

function configBca_() {
  const props = PropertiesService.getScriptProperties();
  const base = (props.getProperty('API_BASE') || '').replace(/\/+$/, '');
  const token = props.getProperty('BCA_TOKEN');
  const label = props.getProperty('LABEL_ID');
  const start = props.getProperty('START_UNIX_SECONDS');
  if (!/^https:\/\/[^/?#@]+(?:\/[\w/-]*)?$/.test(base) || !token || !label || !/^\d{9,10}$/.test(start || '')) {
    throw new Error('Set API_BASE (HTTPS), BCA_TOKEN, LABEL_ID and START_UNIX_SECONDS.');
  }
  return {props, base, token, label, start: Number(start)};
}

function bodyBca_(part) {
  if (!part) return '';
  const mime = (part.mimeType || '').toLowerCase();
  if (part.filename || (part.body && part.body.attachmentId)) return '';
  if (part.parts) {
    const text = part.parts.filter(p => p.mimeType === 'text/plain').map(bodyBca_).join('\n').trim();
    return text || part.parts.map(bodyBca_).filter(Boolean).join('\n');
  }
  if (!['text/plain','text/html'].includes(mime) || !part.body || !part.body.data) return '';
  const decoded = Utilities.newBlob(Utilities.base64DecodeWebSafe(part.body.data)).getDataAsString('UTF-8');
  return mime === 'text/html' ? decoded.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<(?:br|\/p|\/tr|\/div)\b[^>]*>/gi, '\n').replace(/<[^>]+>/g,' ')
    .replace(/&nbsp;|&#160;/gi,' ').replace(/&amp;/gi,'&') : decoded;
}

function sendBca_(cfg, id) {
  const message = Gmail.Users.Messages.get('me', id, {format: 'full'});
  if (!(message.labelIds || []).includes(cfg.label)) return;
  const headers = message.payload.headers || [];
  const header = name => (headers.find(h => h.name.toLowerCase() === name) || {}).value || '';
  const text = [header('subject'), bodyBca_(message.payload)].join('\n').trim();
  if (!text || /\b(?:OTP|one.time.password|kode verifikasi|verification code)\b/i.test(text)) return;
  const packet = {external_id: id, text: text.slice(0, 6000),
    occurred_at: new Date(Number(message.internalDate)).toISOString(),
    metadata: {subject: header('subject').slice(0, 180)}};
  const response = UrlFetchApp.fetch(cfg.base + '/v1/events/bca', {
    method: 'post', contentType: 'application/json', payload: JSON.stringify(packet),
    followRedirects: false, muteHttpExceptions: true, headers: {Authorization: 'Bearer ' + cfg.token}
  });
  if (response.getResponseCode() < 200 || response.getResponseCode() >= 300) {
    throw new Error('SamSaku HTTP ' + response.getResponseCode() + '. Checkpoint retained.');
  }
}

function syncBca() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(1000)) return;
  try {
    const cfg = configBca_();
    const state = JSON.parse(cfg.props.getProperty('SYNC_CURSOR') || 'null') ||
      {from: cfg.start, until: 0, page: ''};
    if (!state.until) state.until = Math.floor(Date.now() / 1000);
    if (state.until <= state.from) return;
    // Freeze the upper bound while traversing pages. Overlap the next window by
    // one second for timestamp granularity; Gmail message IDs deduplicate replay.
    const options = {labelIds: [cfg.label], q: 'after:' + (state.from - 1) + ' before:' + state.until, maxResults: 15};
    if (state.page) options.pageToken = state.page;
    let result;
    try {
      result = Gmail.Users.Messages.list('me', options);
    } catch (err) {
      if (state.page) cfg.props.setProperty('SYNC_CURSOR', JSON.stringify({...state, page: ''}));
      throw err;
    }
    for (const m of (result.messages || [])) sendBca_(cfg, m.id);
    const next = result.nextPageToken ? {...state, page: result.nextPageToken} :
      {from: state.until, until: 0, page: ''};
    cfg.props.setProperty('SYNC_CURSOR', JSON.stringify(next));
  } finally { lock.releaseLock(); }
}
