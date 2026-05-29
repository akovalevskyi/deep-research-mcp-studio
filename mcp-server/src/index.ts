import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { execSync } from "child_process";

import { searchTavily } from "./tavily.js";
import { synthesizeResearch } from "./llm.js";
import { generatePodcastAudio } from "./gradium.js";
import {
  uploadFileToMattermost,
  uploadImageToMattermost,
  sendPostToMattermost,
  resolveChannelIdByName,
} from "./mattermost.js";

// Explicitly load API keys from the Hermes .env file
const HERMES_ENV_PATH = "/home/hermes/.hermes/.env";
if (fs.existsSync(HERMES_ENV_PATH)) {
  dotenv.config({ path: HERMES_ENV_PATH });
} else {
  dotenv.config();
}

const TAVILY_API_KEY = process.env.TAVILY_API_KEY || "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";
const GRADIUM_API_KEY = process.env.GRADIUM_API_KEY || "gsk_d7035609a60b89da472bd8a4e1f294dc8311ea1fd247f4ab6d0a8cb2021a37e7";
const MATTERMOST_TOKEN = process.env.MATTERMOST_TOKEN;
const MATTERMOST_URL = process.env.MATTERMOST_URL || "https://chat.andriko.xyz";
const MATTERMOST_CHANNEL_ID = "mz7at3szn3d53kjp75z8fbwska"; // research-agent

// Load Google Vertex Key
const saPath = "/home/hermes/.hermes/vertex_key.json";
if (!fs.existsSync(saPath)) {
  console.error("Warning: Google Service Account key file missing from:", saPath);
}

// Initialize MCP Server
const server = new Server(
  {
    name: "tavily-deep-research-mcp",
    version: "1.0.0",
  },
  {
    capabilities: {
      tools: {},
    },
  }
);

// Define tools
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return {
    tools: [
      {
        name: "deep_research",
        description:
          "Performs a multi-step deep research pipeline on a given topic using Tavily Search API, Google Vertex AI (Gemini 3.5 Flash) synthesis, Gradium Voice TTS, and automatically delivers a high-quality report, cloud-rendered mindmap JPEG, and audio file directly to the Mattermost 'research-agent' channel.",
        inputSchema: {
          type: "object",
          properties: {
            query: {
              type: "string",
              description: "The research topic, question, or domain to explore.",
            },
            deliverToMattermost: {
              type: "boolean",
              description:
                "Whether to automatically publish the summary, mindmap, and podcast audio to the Mattermost 'research-agent' channel. Defaults to true.",
              default: true,
            },
            testMode: {
              type: "boolean",
              description:
                "Whether to run in lightweight, low-cost Test Mode. This limits web sources, truncates contexts, forces concise summaries, and skips Gradium TTS audio generation to save credits. Defaults to false.",
              default: false,
            },
          },
          required: ["query"],
        },
      },
    ],
  };
});

// Implement tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;

  if (name !== "deep_research") {
    throw new Error(`Tool not found: ${name}`);
  }

  const query = args?.query as string;
  const deliverToMattermost = args?.deliverToMattermost !== false;
  const testMode = args?.testMode === true;

  if (!query) {
    return {
      content: [
        {
          type: "text",
          text: "Error: The 'query' argument is required.",
        },
      ],
      isError: true,
    };
  }

  if (!fs.existsSync(saPath)) {
    return {
      content: [
        {
          type: "text",
          text: `Error: Google Vertex Service Account key not found at ${saPath}`,
        },
      ],
      isError: true,
    };
  }

  const saKey = JSON.parse(fs.readFileSync(saPath, "utf8"));
  const sessionId = `research_${Date.now()}`;
  const outputDir = `/home/hermes/research_results/${sessionId}`;
  const audioPath = path.join(outputDir, "podcast.wav");
  const imgPath = path.join(outputDir, "mindmap.jpg");

  try {
    // 1. Search Phase
    const searchData = await searchTavily(query, TAVILY_API_KEY, testMode ? "basic" : "advanced");

    // 2. Synthesis Phase
    const synthesis = await synthesizeResearch(
      query,
      searchData.answer || "",
      searchData.results || [],
      saKey,
      testMode
    );

    // Process and turn a simple indented outline into a perfect, flawless, 100% sanitized Mermaid mindmap!
    const mindmapLines = synthesis.mindmap
      .replace(/^```mermaid\s*/i, "")
      .replace(/^```\s*/, "")
      .replace(/```\s*$/, "")
      .trim()
      .split("\n");
    const formattedLines = ["mindmap"];
    let hasRootBeenAdded = false;
    let rootIndentLength = 0;

    const sanitizeMermaidText = (text: string) => {
      return text
        .replace(/&/g, "and")
        .replace(/%/g, " percent")
        .replace(/\$/g, "")
        .replace(/[()\[\]{}]/g, " ")
        .replace(/:/g, " -")
        .replace(/~/g, "")
        .replace(/"/g, "")
        .trim();
    }

    for (let i = 0; i < mindmapLines.length; i++) {
      const line = mindmapLines[i];
      const trimmed = line.trim();
      if (!trimmed) continue;
      if (trimmed === "mindmap") continue;

      const leadingSpaces = line.length - line.trimStart().length;

      let rawText = trimmed
        .replace(/^[a-zA-Z0-9_-]+(\(\(\"|\[\"|\(\"|\(\(|\[|\()/, "")
        .replace(/(\"\)\)|\"\\]|\"\)|\"\)|\]|\)\)|\))$/, "")
        .replace(/^root\s*/i, "")
        .replace(/^[\-\*\+]\s*/, "")
        .replace(/^\"/, "")
        .replace(/\"$/, "")
        .trim();

      const cleanText = sanitizeMermaidText(rawText);

      if (!hasRootBeenAdded || trimmed.startsWith("root")) {
        rootIndentLength = leadingSpaces;
        formattedLines.push(`  root(("${cleanText}"))`);
        hasRootBeenAdded = true;
      } else {
        const shiftedIndent = Math.max(0, leadingSpaces - rootIndentLength);
        const indentStr = " ".repeat(shiftedIndent);
        formattedLines.push(`  ${indentStr}"${cleanText}"`);
      }
    }
    const mindmap = formattedLines.join("\n");

    // Download the Mindmap Image from mermaid.ink in the cloud
    let mindmapImgGenerated = false;
    try {
      const b64Code = Buffer.from(mindmap).toString("base64");
      const imgRes = await fetch(`https://mermaid.ink/img/${b64Code}`, {
        headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" },
      });
      if (imgRes.ok) {
        if (!fs.existsSync(outputDir)) {
          fs.mkdirSync(outputDir, { recursive: true });
        }
        const imgBuffer = Buffer.from(await imgRes.arrayBuffer());
        fs.writeFileSync(imgPath, imgBuffer);
        mindmapImgGenerated = true;
        console.log("Mindmap image compiled successfully via mermaid.ink!");
      }
    } catch (imgCompileErr) {
      console.error("Failed to compile mindmap image via mermaid.ink:", imgCompileErr);
    }

    // 3. Audio Generation Phase (Gradium TTS)
    let audioGenerated = false;
    let audioMessage = "";
    if (GRADIUM_API_KEY && !testMode) {
      try {
        await generatePodcastAudio(synthesis.podcastScript, GRADIUM_API_KEY, audioPath);
        audioGenerated = true;
        audioMessage = `✅ Audio podcast generated successfully at: ${audioPath}`;
      } catch (err: any) {
        audioMessage = `⚠️ Gradium TTS generation failed: ${err.message}. Proceeding without audio.`;
      }
    } else {
      audioMessage = "⚠️ GRADIUM_API_KEY is missing. Skipping Gradium TTS podcast generation.";
    }

    // 4. Mattermost Publication Phase
    let mattermostMessage = "";
    if (deliverToMattermost && MATTERMOST_TOKEN && MATTERMOST_URL) {
      try {
        const finalChannelId = await resolveChannelIdByName(
          "research-agent",
          MATTERMOST_URL,
          MATTERMOST_TOKEN,
          MATTERMOST_CHANNEL_ID
        );

        const fileIds: string[] = [];

        // Upload Audio (safely isolated)
        if (audioGenerated && fs.existsSync(audioPath)) {
          try {
            const fileName = "podcast.wav";
            const fileId = await uploadFileToMattermost(
              audioPath,
              finalChannelId,
              MATTERMOST_URL,
              MATTERMOST_TOKEN
            );
            fileIds.push(fileId);
          } catch (audioErr) {
            console.error("Failed to upload audio to Mattermost:", audioErr);
          }
        }

        // Upload Mindmap Jpeg (safely isolated)
        if (mindmapImgGenerated && fs.existsSync(imgPath)) {
          try {
            const imgFileId = await uploadImageToMattermost(
              imgPath,
              finalChannelId,
              MATTERMOST_URL,
              MATTERMOST_TOKEN
            );
            fileIds.push(imgFileId);
          } catch (imgErr) {
            console.error("Failed to upload mindmap image to Mattermost:", imgErr);
          }
        }

        // Post
        let fullMessage = `
# 🔍 Deep Research: ${query}

## 📋 Executive Summary
${synthesis.summary}

## 🗺️ Mindmap (Mermaid)
\`\`\`mermaid
${mindmap}
\`\`\`

## 🎙️ Podcast Audio Transcript
${synthesis.podcastScript.split("\n").map((l) => `> ${l}`).join("\n")}
`;

        if (fullMessage.length > 15000) {
          const overflow = fullMessage.length - 15000;
          const safeSummary =
            synthesis.summary.slice(0, Math.max(1000, synthesis.summary.length - overflow - 500)) +
            "\n\n... [Executive Summary Truncated due to Mattermost post size limits. View the full extensive report on your web UI!]\n";

          fullMessage = `
# 🔍 Deep Research: ${query}

## 📋 Executive Summary
${safeSummary}

## 🗺️ Mindmap (Mermaid)
\`\`\`mermaid
${mindmap}
\`\`\`

## 🎙️ Podcast Audio Transcript
${synthesis.podcastScript.split("\n").map((l) => `> ${l}`).join("\n")}
`;
        }

        await sendPostToMattermost(
          finalChannelId,
          fullMessage,
          fileIds,
          MATTERMOST_URL,
          MATTERMOST_TOKEN
        );
        mattermostMessage = `✅ Published report and podcast audio to Mattermost channel 'research-agent' (ID: ${finalChannelId})!`;
      } catch (err: any) {
        mattermostMessage = `⚠️ Mattermost publication failed: ${err.message}`;
      }
    } else if (deliverToMattermost) {
      mattermostMessage =
        "⚠️ Mattermost credentials (MATTERMOST_TOKEN or MATTERMOST_URL) are missing. Skipping automatic publication.";
    }

    // Save outputs locally as backup
    if (!fs.existsSync(outputDir)) {
      fs.mkdirSync(outputDir, { recursive: true });
    }
    fs.writeFileSync(path.join(outputDir, "summary.md"), synthesis.summary);
    fs.writeFileSync(path.join(outputDir, "mindmap.mermaid"), mindmap);
    fs.writeFileSync(path.join(outputDir, "transcript.txt"), synthesis.podcastScript);

    // 5. Save to unified SQLite history database inside the andriko-hub container!
    try {
      const payload = {
        id: sessionId,
        query: query,
        timestamp: Math.floor(Date.now() / 1000),
        summary: synthesis.summary,
        mindmap: mindmap,
        podcastScript: synthesis.podcastScript,
        audioGenerated: audioGenerated,
        publishedToMattermost: deliverToMattermost && MATTERMOST_TOKEN && MATTERMOST_URL,
        source: testMode ? "mcp_cli (Test Mode)" : "mcp_cli"
      };
      
      const child = execSync(`docker exec -i andriko-hub python3 /app/scripts/insert-history.py`, {
        input: JSON.stringify(payload),
        encoding: 'utf8'
      });
      console.error("MCP CLI saved history successfully:", child);
    } catch (historyErr) {
      console.error("MCP CLI failed to save history:", historyErr);
    }

    const responseContent = `
=========================================
🔬 RESEARCH PIPELINE COMPLETED (NATIVE VERTEX AI)
=========================================
Session ID: ${sessionId}
Query: ${query}
Local Directory: ${outputDir}

${audioMessage}
${mattermostMessage}

=========================================
📋 EXECUTIVE SUMMARY
=========================================
${synthesis.summary}

=========================================
🗺️ MERMAID MINDMAP
=========================================
\`\`\`mermaid
${mindmap}
\`\`\`
`;

    return {
      content: [
        {
          type: "text",
          text: responseContent,
        },
      ],
    };
  } catch (error: any) {
    return {
      content: [
        {
          type: "text",
          text: `Error during deep research execution: ${error.message}`,
        },
      ],
      isError: true,
    };
  }
});

// Run server using StdIO transport
async function run() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Tavily Deep Research MCP Server running on StdIO");
}

run().catch((error) => {
  console.error("Fatal error running MCP server:", error);
  process.exit(1);
});
