// Vercel serverless function: /api/chat
// NEC Assistant AI backend. Multi-provider -- uses whichever key is set in Vercel env:
//   ANTHROPIC_API_KEY (preferred), OPENAI_API_KEY, GEMINI_API_KEY, or XAI_API_KEY

const SYSTEM_PROMPT = `You are the NEC Assistant for a solar / battery / roofing electrical contractor.
You are an expert on NEC 2020 and NEC 2023 (NFPA 70) and on this equipment: Tesla Powerwall 3 & Backup Gateway 3,
Generac PWRcell ATS, Qcells Q.HOME COMBINER, SolarEdge inverters & power optimizers, Enphase microinverters,
SnapNrack racking, and Owens Corning roofing.
Guidelines:
- Be concise, practical, and field-ready. Give the code article number when relevant (e.g. 210.8, 250.122, 690.8, 690.12, 705, 706).
- For sizing questions, show the quick calculation and the result.
- ALWAYS reply in the SAME language the user wrote in (English, Spanish, or Portuguese).
- Remind the installer to verify local AHJ requirements when giving code guidance.
- If a photo is provided, identify the equipment and flag any visible code or safety issues.
- Keep answers short unless the user asks for detail. Use plain text, no markdown headers.`;

function dataUrlParts(dataUrl) {
  const m = /^data:([^;]+);base64,(.*)$/.exec(dataUrl || '');
  if (!m) return null;
  return { media_type: m[1], base64: m[2] };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }
  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch (e) { body = {}; } }
  body = body || {};
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const image = body.image || null;
  if (!messages.length) { res.status(400).json({ error: 'No messages' }); return; }
  const A = process.env.ANTHROPIC_API_KEY;
  const O = process.env.OPENAI_API_KEY;
  const G = process.env.GEMINI_API_KEY;
  const X = process.env.XAI_API_KEY;
  if (!A && !O && !G && !X) {
    res.status(503).json({ error: 'AI not configured', reply: null,
      hint: 'Add ANTHROPIC_API_KEY, OPENAI_API_KEY, GEMINI_API_KEY or XAI_API_KEY in Vercel -> Settings -> Environment Variables.' });
    return;
  }
  try {
    let reply;
    if (A) reply = await callAnthropic(A, messages, image);
    else if (O) reply = await callOpenAI(O, messages, image);
    else if (X) reply = await callOpenAICompatible(X, messages, 'https://api.x.ai/v1/chat/completions', 'grok-2-latest');
    else if (G) reply = await callGemini(G, messages, image);
    res.status(200).json({ reply: reply || '(no response)' });
  } catch (err) {
    res.status(500).json({ error: 'AI request failed', detail: String(err && err.message || err) });
  }
}

async function callAnthropic(key, messages, image) {
  const msgs = messages.map(function (m, i) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const isLastUser = (i === messages.length - 1) && role === 'user';
    if (isLastUser && image) {
      const p = dataUrlParts(image);
      const content = [];
      if (p) content.push({ type: 'image', source: { type: 'base64', media_type: p.media_type, data: p.base64 } });
      content.push({ type: 'text', text: m.text || '(see image)' });
      return { role: role, content: content };
    }
    return { role: role, content: m.text || '' };
  });
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: 'claude-3-5-sonnet-20241022', max_tokens: 1024, system: SYSTEM_PROMPT, messages: msgs })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Anthropic ' + r.status));
  return (j.content && j.content[0] && j.content[0].text) || '';
}

async function callOpenAI(key, messages, image) {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }].concat(messages.map(function (m, i) {
    const role = m.role === 'assistant' ? 'assistant' : 'user';
    const isLastUser = (i === messages.length - 1) && role === 'user';
    if (isLastUser && image) {
      return { role: role, content: [{ type: 'text', text: m.text || '(see image)' }, { type: 'image_url', image_url: { url: image } }] };
    }
    return { role: role, content: m.text || '' };
  }));
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: 'gpt-4o-mini', max_tokens: 1024, messages: msgs })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('OpenAI ' + r.status));
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

async function callOpenAICompatible(key, messages, url, model) {
  const msgs = [{ role: 'system', content: SYSTEM_PROMPT }].concat(messages.map(function (m) {
    return { role: m.role === 'assistant' ? 'assistant' : 'user', content: m.text || '' };
  }));
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'authorization': 'Bearer ' + key },
    body: JSON.stringify({ model: model, max_tokens: 1024, messages: msgs })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Provider ' + r.status));
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
}

async function callGemini(key, messages, image) {
  const contents = messages.map(function (m, i) {
    const role = m.role === 'assistant' ? 'model' : 'user';
    const parts = [{ text: m.text || '' }];
    const isLastUser = (i === messages.length - 1) && role === 'user';
    if (isLastUser && image) {
      const p = dataUrlParts(image);
      if (p) parts.unshift({ inline_data: { mime_type: p.media_type, data: p.base64 } });
    }
    return { role: role, parts: parts };
  });
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=' + key;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ system_instruction: { parts: [{ text: SYSTEM_PROMPT }] }, contents: contents })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || ('Gemini ' + r.status));
  return (j.candidates && j.candidates[0] && j.candidates[0].content && j.candidates[0].content.parts && j.candidates[0].content.parts[0] && j.candidates[0].content.parts[0].text) || '';
}
