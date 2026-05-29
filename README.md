# 🔬 Deep Research & Interactive AI Agent Studio (MCP + Astro SSR)

An autonomous, multi-agent-capable deep research pipeline and interactive studio dashboard. It integrates **Tavily Search API**, **Google Vertex AI (Gemini 3.5 Flash)**, and **Gradium.ai Voice AI** to conduct recursive web research, synthesize structured analytical reports, render visual **Mermaid.js mindmaps**, produce natural **2-voice audio podcasts (using Emma & Kent flagship voices)**, and deliver native media attachments directly to **Mattermost**.

Everything is synchronized under a **unified, concurrent SQLite history database**, ensuring a seamless experience across Web UI, Hermes CLI, or Mattermost commands.

---

## 🏗️ Architecture & Component Design

The studio consists of two main, independent components connected to the same core services:

```
[User Query / /research CLI] ──► [Hermes MCP Server]
                                       │ (Pipes SQLite Insert)
                                       ▼
[User Query / Web Browser] ───► [Astro SSR Web UI] ──► [Unified SQLite DB]
                                       │
                                       ├─► [Tavily Search API] (Advanced recursive search)
                                       ├─► [Google Vertex AI] (Parallel Gemini 3.5 Flash)
                                       ├─► [Gradium.ai Voice] (Emma & Kent TTS Dialogue)
                                       └─► [Mattermost REST] (Native Audio + Image Post)
```

---

## 📦 Project Structure

```
deep-research-mcp-studio/
├── mcp-server/           # Custom TypeScript Model Context Protocol (MCP) Server
│   ├── package.json      # Dependencies and compilation rules
│   ├── tsconfig.json     # TypeScript / ES2022 setup
│   └── src/
│       ├── index.ts      # Core MCP server & Stdio JSON-RPC interface
│       ├── utils.ts      # Exponential backoff retry utilities (Fault Tolerance)
│       ├── tavily.ts     # Tavily Advanced Search API client
│       ├── llm.ts        # Direct JWT-authorized Google Vertex AI client
│       ├── gradium.ts    # Gradium.ai TTS client & Pure-TS WAV merger
│       └── mattermost.ts # Mattermost REST API client (Binary uploader)
│
├── web-ui/               # Server-Side Rendered (SSR) Astro.js Dashboard
│   ├── src/pages/
│   │   ├── deep-research.astro       # Interactive dashboard UI, theme switcher, & test mode
│   │   ├── deep-research-api.ts      # High-performance, unblocked POST research handler
│   │   └── deep-research-audio.ts    # Native audio streaming API endpoint
│   ├── scripts/
│   │   ├── insert-history.py         # Python-SQLite insert helper (stdin piped JSON)
│   │   └── get-history.py            # Python-SQLite retrieval helper (ordered JSON)
│   └── public/
│       └── mermaid.min.js            # Locally-hosted Mermaid library (CSP-compliant)
│
└── README.md             # This high-level developer and product guide
```

---

## ⚡ Key Technical Innovations

### 1. Unified SQLite History Synchronization
Whether a research run is launched from the **Web UI**, the **Hermes CLI**, or a **Mattermost command**, it is saved inside a single SQLite database (`research_history.db`).
- To handle concurrent writes from different Docker containers without adding heavy native C++ Node bindings, the system uses a shared host-volume data-lake.
- A tiny Python script `insert-history.py` acts as a unified database driver, accepting JSON payloads over `stdin` to prevent shell-escaping bugs or SQL-injection vulnerabilities, executing row inserts safely.

### 2. Dual-Voice WAV Merger (Pure TS)
To create a high-fidelity 2-person podcast with **Alex** (Host) and **Sam** (Expert) without heavy local dependencies like `ffmpeg` or `sox`, we implemented a **binary WAV concatenator in pure TypeScript** (`src/gradium.ts`).
- It triggers parallel TTS requests to Gradium (Emma and Kent voices) for all dialogue lines concurrently.
- It extracts the raw PCM payload from each WAV chunk (everything after the first 44-byte RIFF header).
- It combines all payloads with a custom `1.0s` breath pause tag `<break time="1.0s" />` appended to each speaker's line.
- It dynamically synthesizes a brand-new 44-byte RIFF/WAVE header with correct file size and writes the file.

### 3. Overcoming Content Security Policy (CSP)
The production host domain enforced a strict `'self'` Content Security Policy, completely blocking external scripts from CDN networks like jsDelivr, which rendered standard Mermaid.js charts as plain text. We resolved this by **hosting the Mermaid library locally** inside `/mermaid.min.js`, allowing full graphical mindmap rendering while strictly complying with enterprise security headers.

### 4. Test Mode (Low Cost, High Speed)
To facilitate rapid testing and protect token/API budgets during development, the system features an optional **Test Mode**:
- Reduces Tavily `max_results` from 8 to 2 and sets depth to `basic`.
- Truncates web content chunks from 4000 to 1000 characters (reducing LLM input tokens by 75%).
- Appends instructions to Gemini 3.5 Flash on Google Vertex AI to write brief 2-paragraph summaries.
- Bypasses Gradium TTS generation entirely (saving 100% of Voice AI costs).
- Completes runs in less than 2 seconds with practically 0 credit costs.

---

## 🛠️ Setup & Local Launch

### 1. Environment Variables
Add these to your environment or `.env` file:
```bash
TAVILY_API_KEY=your_tavily_key
GRADIUM_API_KEY=your_gradium_key
MATTERMOST_TOKEN=your_mattermost_token
MATTERMOST_URL=https://chat.yourdomain.com
```
Save your Google Service Account JSON key as `vertex_key.json` in `/app/data/vertex_key.json` (for the Web UI) or `~/.hermes/vertex_key.json` (for the MCP server).

### 2. Launching the MCP Server
```bash
cd mcp-server
npm install
npm run build
```
Register the server in your active Hermes config:
```yaml
mcp_servers:
  tavily-deep-research:
    command: node
    args:
    - /home/hermes/.hermes/research-agent-mcp/dist/index.js
    enabled: true
```

### 3. Running the Astro Web UI
Copy the `web-ui` files into your Astro.js SSR repository, compile, and run:
```bash
npm run build
npm run start
```
The page is served at `/deep-research` on your domain!

---

## 🏆 Hackathon Value Proposition & Commercial SaaS Potential

This project represents a **production-ready, enterprise-grade Knowledge Hub** that can be commercialized instantly:
- **Private Cloud AI Podcasting**: Directly competes with Google's NotebookLM, but runs fully under your own cloud environment, via direct APIs, and outputs custom brand voices instantly.
- **Enterprise Collaborative Intelligence**: Seamlessly connects workspaces (like Slack or Mattermost) to real-time, deep search capabilities. Teams can collaboratively trigger market analysis inside chats and immediately listen to short audio briefs.
- **Zero-Config Integrations**: By dynamically resolving channel names and utilizing pure, standard-compliant Node APIs, the product scales effortlessly without manual database setup.
