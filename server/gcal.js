'use strict';

const API = 'https://www.googleapis.com/calendar/v3/calendars/primary/events';

// Cria um evento na agenda principal de quem está logado.
// start/end: "AAAA-MM-DDTHH:MM" no fuso informado. attendees: lista de e-mails.
async function createEvent(accessToken, ev, timeZone) {
  const body = {
    summary: String(ev.summary || 'Visita').slice(0, 500),
    description: String(ev.description || '').slice(0, 8000),
    start: { dateTime: toDateTime(ev.start), timeZone },
    end: { dateTime: toDateTime(ev.end || ev.start), timeZone },
  };
  if (ev.location) body.location = String(ev.location).slice(0, 500);
  const att = (Array.isArray(ev.attendees) ? ev.attendees : [])
    .map((e) => String(e || '').trim().toLowerCase())
    .filter((e) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))
    .slice(0, 20);
  if (att.length) body.attendees = att.map((email) => ({ email }));

  const url = API + (att.length ? '?sendUpdates=all' : '');
  const res = await fetch(url, {
    method: 'POST',
    headers: { authorization: 'Bearer ' + accessToken, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (j.error && j.error.message) || ('HTTP ' + res.status);
    const err = new Error(msg);
    err.code = res.status === 401 ? 'needs_reauth' : res.status === 403 ? 'forbidden' : 'google_error';
    throw err;
  }
  return { id: j.id, htmlLink: j.htmlLink };
}

function toDateTime(s) {
  const v = String(s || '');
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(v)) throw Object.assign(new Error('data/hora inválida'), { status: 400 });
  return v.length === 16 ? v + ':00' : v.slice(0, 19);
}

module.exports = { createEvent };
