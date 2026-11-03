// Points Table Engine — screenshot analysis (Vercel serverless function)
// The browser sends a result screenshot + the match lineup. This function
// reads it with an AI vision provider and returns strict JSON rows; the
// browser then matches names against the lineup and lands on Review.
//
// Provider failover (all keys live ONLY in Vercel Environment Variables —
// never in the browser, the repo, or chat):
//   1. Google Gemini (free tier): one or more keys — VISION_API_KEY (or a
//      comma-separated list in it) plus VISION_API_KEY_2 … _5. Keys are
//      tried in order; per key, models are tried in order
//      (gemini-3.8-flash → gemini-3.6-flash → gemini-3.5-flash-lite) with
//      one retry on overload (429/503). A rejected key (400/401/403)
//      moves straight to the next key.
//   2. OpenAI (only if every Gemini key/model fails): OPENAI_API_KEY,
//      model OPENAI_MODEL or gpt-4o-mini. OpenAI has no free tier.
//
// Optional lock: set ADMIN_PASSCODE_SHA256 in the environment to the same
// SHA-256 hash the app stores for the admin passcode, and requests must send
// that hash in the x-admin-hash header. Without it, a non-empty hash header
// is still required (the app's logged-in state), which keeps casual abuse out.

const MODELS = [...new Set([process.env.VISION_MODEL, "gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite"].filter(Boolean))];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function geminiKeys() {
  const out = [];
  const push = (v) => { String(v || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((k) => { if (!out.includes(k)) out.push(k); }); };
  push(process.env.VISION_API_KEY);
  for (let i = 2; i <= 5; i++) push(process.env["VISION_API_KEY_" + i]);
  return out;
}

async function fetchJson(url, opts, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs || 20000);
  try {
    const r = await fetch(url, { ...opts, signal: ctrl.signal });
    let body = null;
    try { body = await r.json(); } catch (e) {}
    return { ok: r.ok, status: r.status, body };
  } catch (e) {
    return { ok: false, status: 0, unreachable: true, body: null };
  } finally {
    clearTimeout(timer);
  }
}

// Both providers return { ok, text } on success, { ok:false, status, detail } otherwise.
async function callGemini(key, model, prompt, mimeType, imageBase64) {
  const r = await fetchJson(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "x-goog-api-key": key },
    body: JSON.stringify({
      contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
      generationConfig: { temperature: 0, responseMimeType: "application/json" },
    }),
  });
  if (!r.ok) return { ok: false, status: r.status, unreachable: !!r.unreachable, detail: String((r.body && r.body.error && r.body.error.message) || "").slice(0, 240) };
  const text = (((r.body || {}).candidates || [])[0] || {}).content?.parts?.map((p) => p.text || "").join("") || "";
  return { ok: true, text };
}

async function callOpenAI(key, model, prompt, mimeType, imageBase64) {
  const r = await fetchJson("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer " + key },
    body: JSON.stringify({
      model,
      temperature: 0,
      response_format: { type: "json_object" },
      messages: [{
        role: "user",
        content: [
          { type: "text", text: prompt },
          { type: "image_url", image_url: { url: `data:${mimeType};base64,${imageBase64}` } },
        ],
      }],
    }),
  });
  if (!r.ok) return { ok: false, status: r.status, unreachable: !!r.unreachable, detail: String((r.body && r.body.error && r.body.error.message) || "").slice(0, 240) };
  const text = ((((r.body || {}).choices || [])[0] || {}).message || {}).content || "";
  return { ok: true, text };
}

function send(res, code, obj) {
  res.statusCode = code;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(obj));
}

function buildPrompt(lineup, mode) {
  const teams = lineup
    .map((lu, i) => `${i + 1}. Team "${lu.team}" — players: ${lu.players.map((p) => `"${p}"`).join(", ")}`)
    .join("\n");
  return [
    "You are an expert OCR reader for Free Fire / Free Fire MAX custom-room result screens.",
    `This is a ${mode || "squad"} match. The screenshot shows the final standings of one match: each team's finishing rank (placement) and each player's kills (eliminations).`,
    "The ONLY teams and players in this match are this lineup — copy team and player names EXACTLY from it, choosing the closest lineup name for anything you read:",
    teams,
    "Return ONLY a JSON object, no markdown, in exactly this shape:",
    '{"is_result_screen": true, "rows": [{"rank": 1, "team": "<lineup team name>", "players": [{"name": "<lineup player name>", "kills": 3}]}], "notes": ""}',
    "Rules:",
    "- rank is the team's finishing placement (1 = Booyah winner).",
    "- kills is a whole number for each player you can read; use null for a player whose kills you cannot read.",
    "- Include every team row visible in the screenshot, even partially visible ones at the edge.",
    "- If the image is NOT a Free Fire match result screen, return {\"is_result_screen\": false, \"rows\": [], \"notes\": \"<why>\"}.",
    "- Never invent teams, players, ranks or kills that are not visible.",
  ].join("\n");
}

module.exports = async (req, res) => {
  if (req.method !== "POST") return send(res, 405, { error: "method_not_allowed" });

  const keys = geminiKeys();
  const openaiKey = String(process.env.OPENAI_API_KEY || "").trim();
  if (!keys.length && !openaiKey) return send(res, 500, { error: "not_configured", message: "No vision API key is set: add VISION_API_KEY (Gemini) and/or OPENAI_API_KEY in the Vercel project environment variables." });

  const adminHash = req.headers["x-admin-hash"] || "";
  const required = process.env.ADMIN_PASSCODE_SHA256 || "";
  if (required) {
    if (adminHash !== required) return send(res, 401, { error: "admin_required" });
  } else if (typeof adminHash !== "string" || adminHash.length < 16) {
    return send(res, 401, { error: "admin_required" });
  }

  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (e) { body = null; } }
  if (!body) return send(res, 400, { error: "bad_request" });

  const mimeType = String(body.mimeType || "image/jpeg");
  if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType)) return send(res, 400, { error: "bad_image_type" });
  const imageBase64 = String(body.imageBase64 || "").replace(/^data:[^,]*,/, "");
  if (!imageBase64 || imageBase64.length > 6_000_000) return send(res, 400, { error: "bad_image" });
  const lineup = Array.isArray(body.lineup) ? body.lineup.filter((lu) => lu && lu.team && Array.isArray(lu.players) && lu.players.length).slice(0, 48) : [];
  if (!lineup.length) return send(res, 400, { error: "no_lineup" });

  const prompt = buildPrompt(lineup, String(body.mode || ""));
  const t0 = Date.now();
  const overBudget = () => Date.now() - t0 > 50000;

  let text = null, usedModel = null, provider = null, lastFail = null;

  // 1) Gemini — each key in order, each model in order.
  for (const key of keys) {
    if (text || overBudget()) break;
    let keyFatal = false;
    for (const model of MODELS) {
      if (text || keyFatal || overBudget()) break;
      for (let attempt = 0; attempt < 2; attempt++) {
        const out = await callGemini(key, model, prompt, mimeType, imageBase64);
        if (out.ok) { text = out.text; usedModel = model; provider = "gemini"; break; }
        lastFail = out;
        if (out.status === 400 || out.status === 401 || out.status === 403) { keyFatal = true; break; }
        if (attempt === 0 && (out.status === 429 || out.status === 503)) { await sleep(1200); continue; }
        break;
      }
    }
  }

  // 2) OpenAI — only when Gemini produced nothing.
  if (!text && openaiKey && !overBudget()) {
    const oaModel = String(process.env.OPENAI_MODEL || "gpt-4o-mini");
    for (let attempt = 0; attempt < 2; attempt++) {
      const out = await callOpenAI(openaiKey, oaModel, prompt, mimeType, imageBase64);
      if (out.ok) { text = out.text; usedModel = oaModel; provider = "openai"; break; }
      lastFail = out;
      if (attempt === 0 && (out.status === 429 || out.status >= 500)) { await sleep(1200); continue; }
      break;
    }
  }

  if (text == null) {
    if (lastFail && lastFail.unreachable) return send(res, 502, { error: "vision_unreachable" });
    return send(res, 502, { error: "vision_failed", status: lastFail ? lastFail.status : 0, detail: lastFail ? lastFail.detail : "" });
  }

  let parsed;
  try { parsed = JSON.parse(text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")); }
  catch (e) { return send(res, 502, { error: "vision_bad_json" }); }

  const rows = (Array.isArray(parsed.rows) ? parsed.rows : [])
    .map((row) => ({
      rank: Number.isInteger(row.rank) ? row.rank : null,
      team: String(row.team || ""),
      players: (Array.isArray(row.players) ? row.players : []).map((p) => ({
        name: String((p && p.name) || ""),
        kills: Number.isInteger(p && p.kills) ? p.kills : null,
      })),
    }))
    .filter((row) => row.rank != null && row.team);

  return send(res, 200, {
    is_result_screen: parsed.is_result_screen === true,
    rows,
    notes: String(parsed.notes || ""),
    model: provider === "openai" ? usedModel + " (OpenAI)" : usedModel,
    provider,
  });
};
