type TelegramUpdate = {
  update_id: number;
  message?: {
    message_id: number;
    from?: { id: number; username?: string; first_name?: string; last_name?: string };
    chat: { id: number; type: string };
    text?: string;
  };
};

export {};

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_TOKEN = process.env.TELEGRAM_BOT_ADMIN_TOKEN;
const API_BASE_URL = (process.env.APP_BASE_URL || 'http://localhost:3000').replace(/\/$/, '');
const ALLOWED_USER_IDS = (process.env.TELEGRAM_ALLOWED_USER_IDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((s) => Number(s))
  .filter((n) => Number.isFinite(n));

if (!BOT_TOKEN) throw new Error('Missing TELEGRAM_BOT_TOKEN');
if (!ADMIN_TOKEN) throw new Error('Missing TELEGRAM_BOT_ADMIN_TOKEN');

function apiUrl(path: string) {
  return `https://api.telegram.org/bot${BOT_TOKEN}${path}`;
}

async function sendMessage(chatId: number, text: string) {
  await fetch(apiUrl('/sendMessage'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

function parsePostCommand(text: string) {
  // Format:
  // /post <title>\n\n<content>
  // Optional first lines in content:
  // category: Something
  // tags: a,b,c
  // status: draft|published
  const raw = text.replace(/^\/post\s*/, '');
  const parts = raw.split(/\n\n+/);
  const title = (parts.shift() || '').trim();
  const rest = parts.join('\n\n').trim();

  let category: string | undefined;
  let tags: string | undefined;
  let status: 'draft' | 'published' | undefined;

  const lines = rest.split('\n');
  let bodyStart = 0;
  for (let i = 0; i < Math.min(lines.length, 5); i++) {
    const line = lines[i].trim();
    const m = /^([a-zA-Z_]+)\s*:\s*(.+)$/.exec(line);
    if (!m) break;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'category') category = value;
    if (key === 'tags') tags = value;
    if (key === 'status' && (value === 'draft' || value === 'published')) status = value;
    bodyStart = i + 1;
  }

  const content = lines.slice(bodyStart).join('\n').trim();
  return { title, content, category, tags, status };
}

async function createBlogPost(post: { title: string; content: string; category?: string; tags?: string; status?: 'draft' | 'published' }) {
  const res = await fetch(`${API_BASE_URL}/api/integrations/telegram/blog`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
    body: JSON.stringify(post),
  });

  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${res.status} ${(json as any).error || 'request_failed'}`);
  return json as { ok: true; slug: string };
}

let offset = 0;

async function pollOnce() {
  const res = await fetch(apiUrl(`/getUpdates?timeout=30&offset=${offset}`));
  const data = (await res.json()) as { ok: boolean; result: TelegramUpdate[] };
  if (!data.ok) return;

  for (const update of data.result) {
    offset = update.update_id + 1;

    const msg = update.message;
    if (!msg?.text) continue;

    const chatId = msg.chat.id;
    const fromId = msg.from?.id;

    if (ALLOWED_USER_IDS.length > 0 && (!fromId || !ALLOWED_USER_IDS.includes(fromId))) {
      await sendMessage(chatId, 'Unauthorized user.');
      continue;
    }

    const text = msg.text.trim();

    if (text === '/start') {
      await sendMessage(chatId, 'Commands:\n/post <title>\\n\\n<content>\nOptional header lines in content: category: ..., tags: ..., status: draft|published');
      continue;
    }

    if (text.startsWith('/post')) {
      try {
        const parsed = parsePostCommand(text);
        if (!parsed.title || !parsed.content) {
          await sendMessage(chatId, 'Format: /post <title>\\n\\n<content>');
          continue;
        }

        const created = await createBlogPost({
          title: parsed.title,
          content: parsed.content,
          category: parsed.category,
          tags: parsed.tags,
          status: parsed.status,
        });

        await sendMessage(chatId, `OK. Saved as ${created.slug} (status: ${parsed.status || 'draft'}).`);
      } catch (e) {
        await sendMessage(chatId, `Failed: ${(e as Error).message}`);
      }
      continue;
    }

    await sendMessage(chatId, 'Unknown command. Use /start.');
  }
}

while (true) {
  try {
    await pollOnce();
  } catch {
    await new Promise((r) => setTimeout(r, 1000));
  }
}
