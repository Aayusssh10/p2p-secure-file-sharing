// Phase 6: Gemini API auxiliary module. Strictly additive, same philosophy
// as db.js — missing/invalid GEMINI_API_KEY, a slow Gemini response, or an
// API error must never crash the server or block a real transfer. Every
// call here is wrapped so failures just resolve to null; the caller (see
// server.js routes) responds with a fallback instead of throwing.
//
// Only ever sent to Gemini: file metadata (name/size/MIME type) for the
// summary feature, and a short connection-status string for the log
// explainer — never actual file content, preserving the app's "file
// content never touches the server" guarantee (Gemini calls happen
// server-side, but nothing here ever sees file bytes either).

// Aliased to whatever Google currently recommends as its lightweight model
// (resolves to gemini-3.6-flash as of this writing) rather than a pinned
// version — a pinned "gemini-2.5-flash" stopped being available to new API
// keys during this project's development, discovered via a live 404.
const MODEL = "gemini-flash-latest";
const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
const REQUEST_TIMEOUT_MS = 15000;

function isConfigured() {
  return !!process.env.GEMINI_API_KEY;
}

async function generateText(prompt) {
  if (!isConfigured()) return null;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(
      `${API_BASE}/models/${MODEL}:generateContent?key=${process.env.GEMINI_API_KEY}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        // thinkingBudget: 1 is the minimum this model accepts (0 is rejected
        // with a 400) — keeps latency to a few seconds instead of longer for
        // these one-sentence, low-stakes summaries.
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { thinkingConfig: { thinkingBudget: 1 } },
        }),
        signal: controller.signal,
      }
    );

    if (!res.ok) {
      console.error(`Gemini API error: ${res.status} ${res.statusText}`);
      return null;
    }

    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    return typeof text === "string" && text.trim() ? text.trim() : null;
  } catch (err) {
    console.error("Gemini request failed:", err.message);
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

async function summarizeFileMetadata({ fileName, fileSizeBytes, mimeType }) {
  const prompt = `You are a helpful assistant inside a peer-to-peer file sharing app. A user is about to send a file. You are only given its metadata — never its actual content:
- File name: ${fileName}
- Size in bytes: ${fileSizeBytes}
- MIME type: ${mimeType || "unknown"}

In one short sentence (under 25 words), describe the likely file category based only on the name/type, and note anything useful about transferring a file this size peer-to-peer (e.g. roughly how fast it should transfer on a typical connection). Do not claim to know anything about the file's actual content. Respond with only the sentence, no preamble or markdown.`;
  return generateText(prompt);
}

async function explainConnectionIssue({ statusSnippet }) {
  const prompt = `You are translating a WebRTC peer-to-peer connection status into a plain-language message for a non-technical user of a file sharing app. Raw status:
"${statusSnippet}"

In one short, reassuring sentence (under 25 words), explain what's likely happening and what the app is doing about it, if anything is implied by the status. Do not invent details the status doesn't support. Respond with only the sentence, no preamble or markdown.`;
  return generateText(prompt);
}

module.exports = { isConfigured, summarizeFileMetadata, explainConnectionIssue };
