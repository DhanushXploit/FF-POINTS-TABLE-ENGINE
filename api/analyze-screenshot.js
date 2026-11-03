// Points Table Engine — screenshot analysis (Vercel serverless function)
// The browser sends a result screenshot + the match lineup. This function
// calls Google Gemini (free tier) with the API key that lives ONLY in the
// Vercel project's Environment Variables (VISION_API_KEY) — never in the
// browser, the repo, or chat. It returns strict JSON rows; the browser then
// matches names against the lineup and lands on the Review step.
//
// Optional lock: set ADMIN_PASSCODE_SHA256 in the environment to the same
// SHA-256 hash the app stores for the admin passcode, and requests must send
// that hash in the x-admin-hash header. Without it, a non-empty hash header
// is still required (the app's logged-in state), which keeps casual abuse out.

const MODEL = process.env.VISION_MODEL || "gemini-3.8-flash";

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

  const key = process.env.VISION_API_KEY;
  if (!key) return send(res, 500, { error: "not_configured", message: "VISION_API_KEY is not set in the Vercel project environment variables." });

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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 60000);
  let gem;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`, {
      method: "POST",
      signal: ctrl.signal,
      headers: { "Content-Type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }, { inline_data: { mime_type: mimeType, data: imageBase64 } }] }],
        generationConfig: { temperature: 0, responseMimeType: "application/json" },
      }),
    });
    if (!r.ok) { let detail = ""; try { const eb = await r.json(); detail = (eb && eb.error && eb.error.message) || ""; } catch (e) {} return send(res, 502, { error: "vision_failed", status: r.status, detail: String(detail).slice(0, 240) }); }
    gem = await r.json();
  } catch (e) {
    return send(res, 502, { error: "vision_unreachable" });
  } finally {
    clearTimeout(timer);
  }

  const text = (((gem || {}).candidates || [])[0] || {}).content?.parts?.map((p) => p.text || "").join("") || "";
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
    model: MODEL,
  });
};
