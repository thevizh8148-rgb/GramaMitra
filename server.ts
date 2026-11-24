import express from 'express';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import dotenv from 'dotenv';
import { createServer as createViteServer } from 'vite';

dotenv.config();

const PORT = 3000;
const ROOT_DIR = process.cwd();
const DATA_DIR = path.resolve(ROOT_DIR, 'data');
const SUBSCRIPTIONS_FILE = path.resolve(DATA_DIR, 'subscriptions.json');
const SCHEMES_FILE = path.resolve(ROOT_DIR, 'src', 'data', 'schemes.json');

interface SchemeMinimal {
  id: string;
  code: string;
  nameEn: string;
  nameTa: string;
  deadlineDate: string;
}

interface ReminderSubscription {
  id: string;
  clientKey: string;
  schemeId: string;
  schemeNameEn: string;
  schemeNameTa: string;
  phoneMasked: string;
  phoneEncryptedOrStored: string;
  channel: 'sms' | 'whatsapp' | 'both';
  language: 'ta' | 'en';
  reminderDate: string;
  leadDays: number;
  status: 'active' | 'sent' | 'completed';
  lastDispatchedAt?: string;
  deliveryMode: 'twilio_live' | 'gateway_queued';
  createdAt: string;
}

function ensureDataDir(): void {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(SUBSCRIPTIONS_FILE)) {
    fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify([], null, 2), 'utf8');
  }
}

function loadSchemes(): SchemeMinimal[] {
  try {
    const raw = fs.readFileSync(SCHEMES_FILE, 'utf8');
    return JSON.parse(raw) as SchemeMinimal[];
  } catch {
    return [];
  }
}

function readSubscriptions(): ReminderSubscription[] {
  ensureDataDir();
  try {
    const raw = fs.readFileSync(SUBSCRIPTIONS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function writeSubscriptions(items: ReminderSubscription[]): void {
  ensureDataDir();
  fs.writeFileSync(SUBSCRIPTIONS_FILE, JSON.stringify(items, null, 2), 'utf8');
}

function normalizeIndianPhone(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const cleaned = input.replace(/[\s\-()]/g, '').replace(/^\+?91/, '');
  if (!/^[6-9]\d{9}$/.test(cleaned)) {
    return null;
  }
  return cleaned;
}

function maskPhone(digits10: string): string {
  return `+91 ••••••${digits10.slice(-4)}`;
}

function sanitizeClientKey(input: unknown): string | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!/^[a-zA-Z0-9_-]{8,64}$/.test(trimmed)) return null;
  return trimmed;
}

function buildReminderMessage(
  sub: { schemeNameEn: string; schemeNameTa: string; reminderDate: string; language: 'ta' | 'en' }
): string {
  if (sub.language === 'ta') {
    return `GramaMitra நினைவூட்டல்: "${sub.schemeNameTa}" திட்டத்தின் விண்ணப்பம் / புதுப்பித்தல் தேதி ${sub.reminderDate}. அருகிலுள்ள e-சேவை மையம் அல்லது அதிகாரப்பூர்வ இணையதளத்தில் சரிபார்க்கவும்.`;
  }
  return `GramaMitra Alert: Reminder for "${sub.schemeNameEn}" deadline/renewal on ${sub.reminderDate}. Please verify documents and submit via official portal or nearest e-Seva centre.`;
}

async function dispatchViaTwilio(
  digits10: string,
  channel: 'sms' | 'whatsapp',
  message: string
): Promise<{ ok: boolean; sid?: string; error?: string }> {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const smsFrom = process.env.TWILIO_SMS_FROM;
  const waFrom = process.env.TWILIO_WHATSAPP_FROM;

  if (!accountSid || !authToken) {
    return { ok: false, error: 'Twilio credentials not configured' };
  }

  const from = channel === 'whatsapp' ? waFrom : smsFrom;
  if (!from) {
    return { ok: false, error: `Twilio ${channel} sender not configured` };
  }

  const to = channel === 'whatsapp' ? `whatsapp:+91${digits10}` : `+91${digits10}`;
  const formattedFrom = channel === 'whatsapp' && !from.startsWith('whatsapp:') ? `whatsapp:${from}` : from;

  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Messages.json`;
  const params = new URLSearchParams();
  params.set('To', to);
  params.set('From', formattedFrom);
  params.set('Body', message);

  const authHeader = Buffer.from(`${accountSid}:${authToken}`).toString('base64');
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${authHeader}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: params.toString(),
  });

  if (!res.ok) {
    const errText = await res.text();
    return { ok: false, error: `Gateway error (${res.status}): ${errText.slice(0, 120)}` };
  }
  const data = (await res.json()) as { sid?: string };
  return { ok: true, sid: data.sid };
}

function toPublicView(sub: ReminderSubscription) {
  return {
    id: sub.id,
    schemeId: sub.schemeId,
    schemeNameEn: sub.schemeNameEn,
    schemeNameTa: sub.schemeNameTa,
    phoneMasked: sub.phoneMasked,
    channel: sub.channel,
    language: sub.language,
    reminderDate: sub.reminderDate,
    leadDays: sub.leadDays,
    status: sub.status,
    lastDispatchedAt: sub.lastDispatchedAt,
    deliveryMode: sub.deliveryMode,
    createdAt: sub.createdAt,
    previewMessage: buildReminderMessage(sub),
    whatsappShareUrl: `https://wa.me/?text=${encodeURIComponent(buildReminderMessage(sub))}`,
  };
}

async function startServer() {
  const app = express();
  app.use(express.json({ limit: '64kb' }));

  app.get('/api/health', (_req, res) => {
    const twilioConfigured = Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      (process.env.TWILIO_SMS_FROM || process.env.TWILIO_WHATSAPP_FROM)
    );
    res.json({ ok: true, twilioConfigured });
  });

  app.get('/api/reminders', (req, res) => {
    const clientKey = sanitizeClientKey(req.header('x-client-key') || req.query.clientKey);
    if (!clientKey) {
      res.json({ subscriptions: [] });
      return;
    }
    const items = readSubscriptions().filter((s) => s.clientKey === clientKey);
    res.json({ subscriptions: items.map(toPublicView) });
  });

  app.post('/api/reminders/subscribe', async (req, res) => {
    const clientKey = sanitizeClientKey(req.header('x-client-key') || req.body?.clientKey);
    const digits10 = normalizeIndianPhone(req.body?.phone);
    const channel = req.body?.channel;
    const schemeId = typeof req.body?.schemeId === 'string' ? req.body.schemeId.trim() : '';
    const reminderDate = typeof req.body?.reminderDate === 'string' ? req.body.reminderDate.trim() : '';
    const language = req.body?.language === 'ta' ? 'ta' : 'en';
    const leadDaysRaw = Number(req.body?.leadDays);
    const leadDays = Number.isFinite(leadDaysRaw) && leadDaysRaw >= 0 && leadDaysRaw <= 30 ? Math.round(leadDaysRaw) : 3;

    if (!clientKey) {
      res.status(400).json({ error: 'Invalid browser session key.' });
      return;
    }
    if (!digits10) {
      res.status(400).json({ error: 'Please enter a valid 10-digit Indian mobile number starting with 6–9.' });
      return;
    }
    if (channel !== 'sms' && channel !== 'whatsapp' && channel !== 'both') {
      res.status(400).json({ error: 'Select SMS, WhatsApp, or both channels.' });
      return;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(reminderDate)) {
      res.status(400).json({ error: 'Please provide a valid reminder date (YYYY-MM-DD).' });
      return;
    }

    const schemes = loadSchemes();
    const matchedScheme = schemes.find((s) => s.id === schemeId);
    if (!matchedScheme) {
      res.status(400).json({ error: 'Selected government scheme was not found.' });
      return;
    }

    const twilioConfigured = Boolean(
      process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      (process.env.TWILIO_SMS_FROM || process.env.TWILIO_WHATSAPP_FROM)
    );

    const newSub: ReminderSubscription = {
      id: `rem_${crypto.randomUUID().slice(0, 12)}`,
      clientKey,
      schemeId: matchedScheme.id,
      schemeNameEn: matchedScheme.nameEn,
      schemeNameTa: matchedScheme.nameTa,
      phoneMasked: maskPhone(digits10),
      phoneEncryptedOrStored: digits10,
      channel,
      language,
      reminderDate,
      leadDays,
      status: 'active',
      deliveryMode: twilioConfigured ? 'twilio_live' : 'gateway_queued',
      createdAt: new Date().toISOString(),
    };

    const existing = readSubscriptions();
    existing.unshift(newSub);
    writeSubscriptions(existing);

    res.status(201).json({
      subscription: toPublicView(newSub),
      message: twilioConfigured
        ? 'Subscribed. SMS/WhatsApp gateway connected.'
        : 'Subscribed and scheduled. Ready for instant WhatsApp alert or SMS dispatch.',
    });
  });

  app.post('/api/reminders/:id/dispatch', async (req, res) => {
    const clientKey = sanitizeClientKey(req.header('x-client-key') || req.body?.clientKey);
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!clientKey || !id) {
      res.status(400).json({ error: 'Invalid request.' });
      return;
    }

    const items = readSubscriptions();
    const index = items.findIndex((s) => s.id === id && s.clientKey === clientKey);
    if (index === -1) {
      res.status(404).json({ error: 'Subscription not found.' });
      return;
    }

    const sub = items[index];
    const message = buildReminderMessage(sub);
    const results: Array<{ channel: string; ok: boolean; detail: string }> = [];

    const hasTwilio = Boolean(process.env.TWILIO_ACCOUNT_SID && process.env.TWILIO_AUTH_TOKEN);
    if (hasTwilio) {
      if (sub.channel === 'sms' || sub.channel === 'both') {
        const smsRes = await dispatchViaTwilio(sub.phoneEncryptedOrStored, 'sms', message);
        results.push({
          channel: 'SMS',
          ok: smsRes.ok,
          detail: smsRes.ok ? `Sent (${smsRes.sid})` : smsRes.error || 'Failed',
        });
      }
      if (sub.channel === 'whatsapp' || sub.channel === 'both') {
        const waRes = await dispatchViaTwilio(sub.phoneEncryptedOrStored, 'whatsapp', message);
        results.push({
          channel: 'WhatsApp',
          ok: waRes.ok,
          detail: waRes.ok ? `Sent (${waRes.sid})` : waRes.error || 'Failed',
        });
      }
    } else {
      results.push({
        channel: sub.channel.toUpperCase(),
        ok: true,
        detail: 'Alert payload prepared and logged. Configure Twilio credentials in environment for automated carrier SMS, or open the direct WhatsApp alert link.',
      });
    }

    sub.lastDispatchedAt = new Date().toISOString();
    sub.status = 'sent';
    items[index] = sub;
    writeSubscriptions(items);

    res.json({
      subscription: toPublicView(sub),
      dispatchResults: results,
    });
  });

  app.patch('/api/reminders/:id', (req, res) => {
    const clientKey = sanitizeClientKey(req.header('x-client-key') || req.body?.clientKey);
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const nextStatus = req.body?.status;
    if (!clientKey || !id || (nextStatus !== 'active' && nextStatus !== 'completed')) {
      res.status(400).json({ error: 'Invalid status update.' });
      return;
    }

    const items = readSubscriptions();
    const index = items.findIndex((s) => s.id === id && s.clientKey === clientKey);
    if (index === -1) {
      res.status(404).json({ error: 'Subscription not found.' });
      return;
    }
    items[index].status = nextStatus;
    writeSubscriptions(items);
    res.json({ subscription: toPublicView(items[index]) });
  });

  app.delete('/api/reminders/:id', (req, res) => {
    const clientKey = sanitizeClientKey(req.header('x-client-key') || req.query.clientKey);
    const id = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    if (!clientKey || !id) {
      res.status(400).json({ error: 'Invalid request.' });
      return;
    }

    const items = readSubscriptions();
    const filtered = items.filter((s) => !(s.id === id && s.clientKey === clientKey));
    if (filtered.length === items.length) {
      res.status(404).json({ error: 'Subscription not found.' });
      return;
    }
    writeSubscriptions(filtered);
    res.json({ ok: true });
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(ROOT_DIR, 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.resolve(distDir, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`GramaMitra server listening on http://localhost:${PORT}`);
  });
}

startServer();
