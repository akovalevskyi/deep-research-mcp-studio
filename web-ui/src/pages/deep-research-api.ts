import type { APIRoute } from 'astro';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { execSync } from 'child_process';

export const POST: APIRoute = async ({ request }) => {
  try {
    const body = await request.json();
    const query = body.query;
    const model = body.model || "google/gemini-3.5-flash";
    const deliverToMattermost = body.deliverToMattermost !== false;
    const testMode = body.testMode === true || body.testmode === true || String(body.testMode) === "true" || String(body.testmode) === "true";

    if (!query) {
      return new Response(JSON.stringify({ error: "Query is required" }), {
        status: 400,
        headers: { "Content-Type": "application/json" }
      });
    }

    const sessionId = `research_${Date.now()}`;
    const outputDir = `/app/data/research_results/${sessionId}`;
    const audioPath = path.join(outputDir, "podcast.wav");

    // Load Vertex service account key
    const saPath = "/app/data/vertex_key.json";
    if (!fs.existsSync(saPath)) {
      throw new Error(`Google Cloud Vertex Service Account key not found at ${saPath}`);
    }
    const sa = JSON.parse(fs.readFileSync(saPath, 'utf8'));

    // Load secrets from process.env or .env file
    const envPath = "/app/data/.env";
    if (fs.existsSync(envPath)) {
      const envContent = fs.readFileSync(envPath, 'utf8');
      for (const line of envContent.split("\n")) {
        const trimmed = line.trim();
        if (trimmed && !trimmed.startsWith("#") && trimmed.includes("=")) {
          const [key, ...valParts] = trimmed.split("=");
          const value = valParts.join("=").trim().replace(/^['"]|['"]$/g, "");
          process.env[key.trim()] = value;
        }
      }
    }

    const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "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";
    const GRADIUM_API_KEY = process.env.GRADIUM_API_KEY || "gsk_d7035609a60b89da472bd8a4e1f294dc8311ea1fd247f4ab6d0a8cb2021a37e7";
    const MATTERMOST_TOKEN = process.env.MATTERMOST_TOKEN;
    const MATTERMOST_URL = process.env.MATTERMOST_URL || "https://chat.andriko.xyz";
    const MATTERMOST_CHANNEL_ID = "mz7at3szn3d53kjp75z8fbwska"; // research-agent

    // Helpers
    async function retryWithBackoff(fn, retries = 3, delay = 1000) {
      try { return await fn(); }
      catch (e) {
        if (retries <= 1) throw e;
        await new Promise(r => setTimeout(r, delay));
        return retryWithBackoff(fn, retries - 1, delay * 2);
      }
    }

    // Google Vertex AI Token Exchange using native Node.js Crypto RS256
    async function getGCPToken(saKey) {
      const header = { alg: "RS256", typ: "JWT" };
      const iat = Math.floor(Date.now() / 1000);
      const exp = iat + 3600;
      const payload = {
        iss: saKey.client_email,
        scope: "https://www.googleapis.com/auth/cloud-platform",
        aud: saKey.token_uri,
        exp,
        iat
      };

      const base64UrlEncode = (obj) =>
        Buffer.from(JSON.stringify(obj))
          .toString("base64")
          .replace(/=/g, "")
          .replace(/\+/g, "-")
          .replace(/\//g, "_");

      const unsignedToken = `${base64UrlEncode(header)}.${base64UrlEncode(payload)}`;

      const sign = crypto.createSign("RSA-SHA256");
      sign.update(unsignedToken);
      const signature = sign.sign(saKey.private_key, "base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");

      const signedJwt = `${unsignedToken}.${signature}`;

      const response = await fetch(saKey.token_uri, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${signedJwt}`
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to exchange JWT for Google access token: ${text}`);
      }

      const data = await response.json();
      return data.access_token;
    }

    // Call Google Vertex AI Gemini directly
    async function callVertexAI(prompt, systemPrompt) {
      const token = await getGCPToken(sa);
      const modelName = testMode ? "gemini-3.1-flash-lite" : "gemini-3.5-flash";
      const url = `https://aiplatform.googleapis.com/v1/projects/${sa.project_id}/locations/global/publishers/google/models/${modelName}:generateContent`;

      return retryWithBackoff(async () => {
        const r = await fetch(url, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${token}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            contents: [
              {
                role: "user",
                parts: [
                  { text: `${systemPrompt}\n\nUser Request: ${prompt}` }
                ]
              }
            ],
            generationConfig: {
              temperature: 0.7
            }
          })
        });

        if (!r.ok) {
          const text = await r.text();
          throw new Error(`Vertex AI call failed: ${r.status} - ${text}`);
        }

        const data = await r.json();
        if (!data.candidates || data.candidates.length === 0) {
          throw new Error("Empty response from Vertex AI");
        }
        return data.candidates[0].content.parts[0].text;
      });
    }

    // 1. Search Tavily
    const searchData = await retryWithBackoff(async () => {
      const response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query: query,
          search_depth: testMode ? "basic" : "advanced",
          include_answer: true,
          max_results: testMode ? 2 : 8,
        })
      });
      if (!response.ok) throw new Error(`Tavily failed: ${response.status}`);
      return response.json();
    });

    // 2. Synthesize LLM
    const maxContentLength = testMode ? 1000 : 4000;
    const processedResults = (searchData.results || []).map(r => ({
      title: r.title,
      url: r.url,
      content: r.content && r.content.length > maxContentLength ? r.content.slice(0, maxContentLength) + "... [Truncated for token optimization]" : r.content
    }));

    // Use === instead of --- to prevent Astro from splitting the frontmatter prematurely!
    const context = `
Topic: ${query}
Summary: ${searchData.answer || ""}
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

    // Perform three parallel synthesis calls directly to Gemini 3.5 Flash on Google Vertex AI!
    const [summary, mindmapRaw, podcastScript] = await Promise.all([
      callVertexAI(summaryPrompt, summarySystem),
      callVertexAI(mindmapPrompt, mindmapSystem),
      callVertexAI(podcastPrompt, podcastSystem)
    ]);

    // Process and turn a simple indented outline into a perfect, flawless, 100% sanitized Mermaid mindmap!
    const mindmapLines = mindmapRaw.replace(/^```mermaid\s*/i, "").replace(/^```\s*/, "").replace(/```\s*$/, "").trim().split("\n");
    const formattedLines = ["mindmap"];
    let hasRootBeenAdded = false;
    let rootIndentLength = 0;

    // Standard text sanitization helper for Mermaid mindmaps
    function sanitizeMermaidText(text) {
      return text
        .replace(/&/g, "and")
        .replace(/%/g, " percent")
        .replace(/\$/g, "")
        .replace(/[()\[\]{}]/g, " ") // replace all brackets/parentheses with spaces
        .replace(/:/g, " -")         // replace colons with hyphens
        .replace(/~/g, "")           // remove tilde
        .replace(/"/g, "")           // remove any nested quotes
        .trim();
    }

    for (let i = 0; i < mindmapLines.length; i++) {
      const line = mindmapLines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "mindmap") continue;

      const leadingSpaces = line.length - line.trimStart().length;

      // Extract the raw text from any complex node shapes or quotes if already formatted
      let rawText = trimmed
        .replace(/^[a-zA-Z0-9_-]+(\(\(\"|\[\"|\(\"|\(\(|\[|\()/, "") // strip leading IDs and brackets
        .replace(/(\"\)\)|\"\\]|\"\)|\"\)|\]|\)\)|\))$/, "")          // strip trailing brackets and quotes
        .replace(/^root\s*/i, "")
        .replace(/^[\-\*\+]\s*/, "") // remove bullets
        .replace(/^\"/, "").replace(/\"$/, "") // remove wrapping quotes
        .trim();

      const cleanText = sanitizeMermaidText(rawText);

      if (!hasRootBeenAdded || trimmed.startsWith("root")) {
        // First actual non-empty node is always the root node at 0 indent!
        rootIndentLength = leadingSpaces;
        formattedLines.push(`  root(("${cleanText}"))`);
        hasRootBeenAdded = true;
      } else {
        // Shift indentation relative to the root node
        const shiftedIndent = Math.max(0, leadingSpaces - rootIndentLength);
        const indentStr = " ".repeat(shiftedIndent);
        // All nodes are regular indented nodes, cleanly wrapped in double quotes
        formattedLines.push(`  ${indentStr}"${cleanText}"`);
      }
    }
    const mindmap = formattedLines.join("\n");

    // Download the Mindmap Image from mermaid.ink in the cloud
    let mindmapImgGenerated = false;
    const imgPath = path.join(outputDir, "mindmap.jpg");
    try {
      const b64Code = Buffer.from(mindmap).toString('base64');
      const imgRes = await fetch(`https://mermaid.ink/img/${b64Code}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" }
      });
      if (imgRes.ok) {
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
        fs.writeFileSync(imgPath, imgBuffer);
        mindmapImgGenerated = true;
        console.log("Mindmap image compiled successfully via mermaid.ink!");
      } else {
        console.error(`Mermaid.ink image compilation failed with status ${imgRes.status}`);
      }
    } catch (imgCompileErr) {
      console.error("Failed to compile mindmap image via mermaid.ink:", imgCompileErr);
    }

    // 3. Gradium TTS Audio
    let audioGenerated = false;
    if (GRADIUM_API_KEY && !testMode) {
      try {
        const lines = [];
        const splitLines = podcastScript.split("\n");
        for (const line of splitLines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          
          // Strip out markdown bold asterisks to ensure perfect matching
          const cleanLine = trimmed.replace(/\*/g, "").trim();
          
          if (cleanLine.startsWith("Alex:") || cleanLine.startsWith("Host A:")) {
            lines.push({ speaker: "Alex", text: cleanLine.replace(/^(Alex|Host A):\s*/, "").trim() });
          } else if (cleanLine.startsWith("Sam:") || cleanLine.startsWith("Host B:")) {
            lines.push({ speaker: "Sam", text: cleanLine.replace(/^(Sam|Host B):\s*/, "").trim() });
          }
        }

        if (lines.length === 0) {
          throw new Error("Could not parse any valid dialogue lines from script.");
        }

        const SPEAKER_VOICES = { Alex: "YTpq7expH9539ERJ", Sam: "LFZvm12tW_z0xfGo" };

        const wavBuffers = await Promise.all(
          lines.map(async (line) => {
            return retryWithBackoff(async () => {
              const res = await fetch("https://api.gradium.ai/api/post/speech/tts", {
                method: "POST",
                headers: {
                  "x-api-key": GRADIUM_API_KEY,
                  "Content-Type": "application/json"
                },
                body: JSON.stringify({
                  // Clean text for TTS: strip asterisks, parentheses, brackets, double/single quotes and any unsupported characters
                  text: `${line.text.replace(/\*/g, "").replace(/[()\[\]]/g, " ").replace(/"/g, "").replace(/'/g, "").replace(/[^a-zA-Z0-9\s.,?!'-]/g, "").trim()} <break time="1.0s" />`,
                  voice_id: SPEAKER_VOICES[line.speaker],
                  output_format: "wav",
                  only_audio: true,
                  json_config: JSON.stringify({ rewrite_rules: "en" })
                })
              });
              if (!res.ok) throw new Error(`Gradium failed: ${res.status}`);
              const ab = await res.arrayBuffer();
              return Buffer.from(ab);
            });
          })
        );

        // Concatenate WAV buffers
        const totalDataSize = wavBuffers.reduce((acc, buf) => acc + (buf.length - 44), 0);
        const firstWav = wavBuffers[0];
        const numChannels = firstWav.readUInt16LE(22);
        const sampleRate = firstWav.readUInt32LE(24);
        const bitsPerSample = firstWav.readUInt16LE(34);

        const header = Buffer.alloc(44);
        header.write("RIFF", 0, "ascii");
        header.writeUInt32LE(totalDataSize + 36, 4);
        header.write("WAVE", 8, "ascii");
        header.write("fmt ", 12, "ascii");
        header.writeUInt32LE(16, 16);
        header.writeUInt16LE(1, 20);
        header.writeUInt16LE(numChannels, 22);
        header.writeUInt32LE(sampleRate, 24);
        header.writeUInt32LE((sampleRate * numChannels * bitsPerSample) / 8, 28);
        header.writeUInt16LE((numChannels * bitsPerSample) / 8, 32);
        header.writeUInt16LE(bitsPerSample, 34);
        header.write("data", 36, "ascii");
        header.writeUInt32LE(totalDataSize, 40);

        const payloads = wavBuffers.map(buf => buf.subarray(44));
        const finalWav = Buffer.concat([header, ...payloads]);

        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        fs.writeFileSync(audioPath, finalWav);
        audioGenerated = true;
      } catch (e) {
        console.error("Gradium audio generation failed:", e);
      }
    }

    // 4. Publish to Mattermost
    let publishedToMattermost = false;
    let finalChannelId = MATTERMOST_CHANNEL_ID;
    if (deliverToMattermost && MATTERMOST_TOKEN && MATTERMOST_URL) {
      try {
        // Resolve channel ID
        try {
          const r = await fetch(`${MATTERMOST_URL}/api/v4/users/me/channels`, {
            method: "GET",
            headers: { "Authorization": `Bearer ${MATTERMOST_TOKEN}` }
          });
          if (r.ok) {
            const chans = await r.json();
            const matched = chans.find(c => c.name === "research-agent" || c.display_name === "research-agent");
            if (matched) finalChannelId = matched.id;
          }
        } catch (_) {}

        // Gather all uploaded file IDs
        const fileIds = [];

        // Upload Audio (safely isolated)
        if (audioGenerated && fs.existsSync(audioPath)) {
          try {
            const fileName = "podcast.wav";
            const fileBuffer = fs.readFileSync(audioPath);
            const file = new File([fileBuffer], fileName, { type: "audio/wav" });
            const fd = new FormData();
            fd.append("channel_id", finalChannelId);
            fd.append("files", file);

            const fileRes = await fetch(`${MATTERMOST_URL}/api/v4/files`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${MATTERMOST_TOKEN}` },
              body: fd
            });
            if (fileRes.ok) {
              const fileData = await fileRes.json();
              const fileId = fileData.file_infos[0].id;
              fileIds.push(fileId);
              console.log("Audio file uploaded to Mattermost. ID:", fileId);
            } else {
              const errBody = await fileRes.text();
              console.error(`Mattermost file upload failed: HTTP ${fileRes.status} - ${errBody}`);
            }
          } catch (audioErr) {
            console.error("Mattermost file upload threw exception:", audioErr);
          }
        }

        // Upload Mindmap Jpeg (safely isolated)
        if (mindmapImgGenerated && fs.existsSync(imgPath)) {
          try {
            const imgBuffer = fs.readFileSync(imgPath);
            const imgFile = new File([imgBuffer], "mindmap.jpg", { type: "image/jpeg" });
            const fdImg = new FormData();
            fdImg.append("channel_id", finalChannelId);
            fdImg.append("files", imgFile);

            const imgRes = await fetch(`${MATTERMOST_URL}/api/v4/files`, {
              method: "POST",
              headers: { "Authorization": `Bearer ${MATTERMOST_TOKEN}` },
              body: fdImg
            });
            if (imgRes.ok) {
              const imgData = await imgRes.json();
              const imgFileId = imgData.file_infos[0].id;
              fileIds.push(imgFileId);
              console.log("Mindmap image uploaded to Mattermost. ID:", imgFileId);
            } else {
              const errBody = await imgRes.text();
              console.error(`Mattermost mindmap image upload failed: HTTP ${imgRes.status} - ${errBody}`);
            }
          } catch (imgErr) {
            console.error("Failed to upload mindmap image to Mattermost:", imgErr);
          }
        }

        // Post (safely truncated if total combined length exceeds Mattermost 16384 character limit)
        let fullMessage = `
# 🔍 Deep Research: ${query}

## 📋 Executive Summary
${summary}

## 🗺️ Mindmap (Mermaid)
\`\`\`mermaid
${mindmap}
\`\`\`

## 🎙️ Podcast Audio Transcript
${podcastScript.split("\n").map(l => `> ${l}`).join("\n")}
`;

        if (fullMessage.length > 15000) {
          console.error(`Mattermost post payload length (${fullMessage.length}) exceeds 15000 limit. Truncating summary...`);
          const overflow = fullMessage.length - 15000;
          const safeSummary = summary.slice(0, Math.max(1000, summary.length - overflow - 500)) + "\n\n... [Executive Summary Truncated due to Mattermost post size limits. View the full extensive report on your web UI!]\n";
          
          fullMessage = `
# 🔍 Deep Research: ${query}

## 📋 Executive Summary
${safeSummary}

## 🗺️ Mindmap (Mermaid)
\`\`\`mermaid
${mindmap}
\`\`\`

## 🎙️ Podcast Audio Transcript
${podcastScript.split("\n").map(l => `> ${l}`).join("\n")}
`;
        }

        const postRes = await fetch(`${MATTERMOST_URL}/api/v4/posts`, {
          method: "POST",
          headers: {
            "Authorization": `Bearer ${MATTERMOST_TOKEN}`,
            "Content-Type": "application/json"
          },
          body: JSON.stringify({
            channel_id: finalChannelId,
            message: fullMessage,
            file_ids: fileIds
          })
        });
        if (postRes.ok) {
          publishedToMattermost = true;
        } else {
          const errText = await postRes.text();
          console.error(`Mattermost post request failed: HTTP ${postRes.status} - ${errText}`);
        }
      } catch (e) {
        console.error("Mattermost upload/post failed:", e);
      }
    }

    // Save outputs locally as backup
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(path.join(outputDir, "summary.md"), summary);
    fs.writeFileSync(path.join(outputDir, "mindmap.mermaid"), mindmap);
    fs.writeFileSync(path.join(outputDir, "transcript.txt"), podcastScript);

    // Save to unified SQLite history database via our python helper
    try {
      const payload = {
        id: sessionId,
        query: query,
        timestamp: Math.floor(Date.now() / 1000),
        summary: summary,
        mindmap: mindmap,
        podcastScript: podcastScript,
        audioGenerated: audioGenerated,
        publishedToMattermost: publishedToMattermost,
        source: "web_ui"
      };
      
      const child = execSync("python3 /app/scripts/insert-history.py", {
        input: JSON.stringify(payload),
        encoding: 'utf8'
      });
      console.log("Astro Web UI saved history successfully:", child);
    } catch (historyErr) {
      console.error("Astro Web UI failed to save history:", historyErr);
    }

    return new Response(JSON.stringify({
      success: true,
      sessionId,
      summary,
      mindmap,
      podcastScript,
      audioGenerated,
      publishedToMattermost
    }), {
      status: 200,
      headers: { "Content-Type": "application/json" }
    });

  } catch (error: any) {
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" }
    });
  }
};
