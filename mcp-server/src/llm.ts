import * as crypto from "crypto";
import { retryWithBackoff } from "./utils.js";

export interface SynthesisResult {
  summary: string;
  mindmap: string;
  podcastScript: string;
}

// Google Vertex AI Token Exchange using native Node.js Crypto RS256
async function getGCPToken(saKey: any): Promise<string> {
  const header = { alg: "RS256", typ: "JWT" };
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + 3600;
  const payload = {
    iss: saKey.client_email,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: saKey.token_uri,
    exp,
    iat,
  };

  const base64UrlEncode = (obj: any) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/=/g, "")
      .replace(/\+/g, "-")
      .replace(/\//g, "_");

  const unsignedToken = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

  const sign = crypto.createSign("RSA-SHA256");
  sign.update(unsignedToken);
  const signature = sign
    .sign(saKey.private_key, "base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");

  const signedJwt = `${unsignedToken}.${signature}`;

  const response = await fetch(saKey.token_uri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`,
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Failed to exchange JWT for Google access token: ${text}`);
  }

  const data = await response.json() as any;
  return data.access_token;
}

// Call Google Vertex AI Gemini 3.5 Flash directly
async function callVertexAI(prompt: string, systemPrompt: string, saKey: any): Promise<string> {
  const token = await getGCPToken(saKey);
  const url = `https://aiplatform.googleapis.com/v1/projects/${saKey.project_id}/locations/global/publishers/google/models/gemini-3.5-flash:generateContent`;

  return retryWithBackoff(async () => {
    const r = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        contents: [
          {
            role: "user",
            parts: [{ text: `${systemPrompt}\n\nUser Request: ${prompt}` }],
          },
        ],
        generationConfig: {
          temperature: 0.7,
        },
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      throw new Error(`Vertex AI call failed: ${r.status} - ${text}`);
    }

    const data = await r.json() as any;
    if (!data.candidates || data.candidates.length === 0) {
      throw new Error("Empty response from Vertex AI");
    }
    return data.candidates[0].content.parts[0].text;
  });
}

export async function synthesizeResearch(
  query: string,
  searchAnswer: string,
  results: { title: string; url: string; content: string }[],
  saKey: any,
  testMode: boolean = false
): Promise<SynthesisResult> {
  // Truncate raw contents of individual results to 1000 (testMode) or 4000 characters to safeguard the token context and reduce cost
  const maxContentLength = testMode ? 1000 : 4000;
  const processedResults = results.map(r => ({
    ...r,
    content: r.content && r.content.length > maxContentLength ? r.content.slice(0, maxContentLength) + "... [Content Truncated for token optimization]" : r.content
  }));

  // Format the search results as context for the LLM
  const context = `
Topic: ${query}
Summary: ${searchAnswer}
Results:
${processedResults.map((r, i) => `[Source ${i + 1}] ${r.title} (${r.url}):\n${r.content}\n===`).join("\n")}
`;

  const summarySystem = testMode
    ? "You are a professional research analyst. CRITICAL: Write an extremely brief, lightweight 2-paragraph executive summary to conserve token usage (maximum 150 words total). Use inline markdown source links."
    : "You are a professional research analyst. Write a highly detailed executive summary with inline markdown source links.";
  const summaryPrompt = `Write a Summary for "${query}":\n\n${context}`;

  const mindmapSystem = "Return ONLY a valid, syntactically correct Mermaid.js mindmap diagram code starting strictly with 'mindmap'. CRITICAL: All nodes containing spaces, colons, numbers, or special characters MUST be wrapped in double quotes (e.g., \"Node Text with spaces\" or branch_name[\"Node Text with spaces\"]). Do not output any markdown code blocks, explanations, or introductory text. Start directly with the word 'mindmap'.";
  const mindmapPrompt = `Create a fully valid Mermaid.js mindmap diagram based on the research context for "${query}". Ensure all nodes with multiple words or spaces are strictly wrapped in double quotes:\n\n${context}`;

  const podcastSystem = "Generate an engaging, natural conversation script between Alex (curious Host, inquisitive) and Sam (domain Expert, detailed explanations). CRITICAL: Each line of dialogue must be very short, snappy, and highly conversational (MAXIMUM 15 words or 120 characters per line). Alex and Sam should have a quick, lively back-and-forth instead of reading long monologues. Format strictly as Alex: ... and Sam: ...";
  const podcastPrompt = `Create a quick, snappy 4-line back-and-forth dialogue script (Alex, Sam, Alex, Sam) discussing "${query}" based on the context. Ensure every line is very short (max 15 words) and natural:\n\n${context}`;

  const [summary, mindmapRaw, podcastScript] = await Promise.all([
    callVertexAI(summaryPrompt, summarySystem, saKey),
    callVertexAI(mindmapPrompt, mindmapSystem, saKey),
    callVertexAI(podcastPrompt, podcastSystem, saKey)
  ]);

  return {
    summary,
    mindmap: mindmapRaw,
    podcastScript
  };
}
