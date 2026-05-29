import * as fs from "fs";
import * as path from "path";
import { retryWithBackoff } from "./utils.js";

export interface ScriptLine {
  speaker: "Alex" | "Sam";
  text: string;
}

const SPEAKER_VOICES = {
  Alex: "YTpq7expH9539ERJ",
  Sam: "LFZvm12tW_z0xfGo"
};

export function parseScript(scriptText: string): ScriptLine[] {
  const lines = scriptText.split("\n");
  const script: ScriptLine[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    
    // Strip out markdown bold asterisks to ensure perfect matching
    const cleanLine = trimmed.replace(/\*/g, "").trim();

    if (cleanLine.startsWith("Alex:") || cleanLine.startsWith("Host A:")) {
      const text = cleanLine.replace(/^(Alex|Host A):\s*/, "").trim();
      if (text) {
        script.push({ speaker: "Alex", text });
      }
    } else if (cleanLine.startsWith("Sam:") || cleanLine.startsWith("Host B:")) {
      const text = cleanLine.replace(/^(Sam|Host B):\s*/, "").trim();
      if (text) {
        script.push({ speaker: "Sam", text });
      }
    }
  }

  return script;
}

async function generateLineAudio(text: string, voiceId: string, apiKey: string): Promise<Buffer> {
  const url = "https://api.gradium.ai/api/post/speech/tts";

  return retryWithBackoff(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        text: text,
        voice_id: voiceId,
        output_format: "wav",
        only_audio: true,
        json_config: JSON.stringify({
          rewrite_rules: "en"
        })
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Gradium TTS API failed with status ${response.status}: ${errorText}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
  });
}

// Conjoin multiple WAV files by extracting their data payloads and recreating a master WAV header
export function concatWavs(wavBuffers: Buffer[]): Buffer {
  if (wavBuffers.length === 0) {
    throw new Error("Cannot concatenate empty WAV buffer array");
  }
  if (wavBuffers.length === 1) {
    return wavBuffers[0];
  }

  const payloads: Buffer[] = [];
  let totalDataSize = 0;

  // Read format details from the first WAV header
  const firstWav = wavBuffers[0];
  const numChannels = firstWav.readUInt16LE(22); // Channels at byte 22
  const sampleRate = firstWav.readUInt32LE(24);   // Sample rate at byte 24
  const bitsPerSample = firstWav.readUInt16LE(34); // Bits per sample at byte 34

  for (const buf of wavBuffers) {
    // Standard WAV header is 44 bytes. Verify it's a RIFF/WAVE file
    if (buf.length < 44 || buf.toString("ascii", 0, 4) !== "RIFF" || buf.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Invalid WAV format encountered during concatenation");
    }
    // Extract payload (everything from byte 44 onwards)
    const payload = buf.subarray(44);
    payloads.push(payload);
    totalDataSize += payload.length;
  }

  const combinedPayload = Buffer.concat(payloads);

  // Generate new 44-byte WAV header
  const header = Buffer.alloc(44);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(totalDataSize + 36, 4); // Chunk size (file size - 8)
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);               // Subchunk 1 size (16 for PCM)
  header.writeUInt16LE(1, 20);                // Audio format (1 for PCM)
  header.writeUInt16LE(numChannels, 22);      // Channels (mono=1, stereo=2)
  header.writeUInt32LE(sampleRate, 24);       // Sample rate (e.g. 48000)
  
  const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
  const blockAlign = (numChannels * bitsPerSample) / 8;
  
  header.writeUInt32LE(byteRate, 28);         // Byte rate
  header.writeUInt16LE(blockAlign, 32);       // Block align
  header.writeUInt16LE(bitsPerSample, 34);    // Bits per sample
  header.write("data", 36, "ascii");
  header.writeUInt32LE(totalDataSize, 40);    // Subchunk 2 size (payload length)

  return Buffer.concat([header, combinedPayload]);
}

export async function generatePodcastAudio(
  scriptText: string,
  apiKey: string,
  outputFilePath: string
): Promise<void> {
  const lines = parseScript(scriptText);
  if (lines.length === 0) {
    throw new Error("Could not parse any valid dialogue lines from script");
  }

  // Generate all individual dialogue audio lines in parallel (saves massive network latency)
  // We append a natural 1.0s breath pause tag to the end of each speaker's line so they don't overlap in the merged file
  const wavBuffers = await Promise.all(
    lines.map((line) => {
      const cleanLineText = line.text
        .replace(/\*/g, "")
        .replace(/[()\[\]]/g, " ")
        .replace(/"/g, "")
        .replace(/'/g, "")
        .replace(/[^a-zA-Z0-9\s.,?!'-]/g, "")
        .trim();
      const textWithPause = `${cleanLineText} <break time="1.0s" />`;
      return generateLineAudio(textWithPause, SPEAKER_VOICES[line.speaker], apiKey);
    })
  );

  // Concatenate WAV buffers into a single master WAV file
  const finalWav = concatWavs(wavBuffers);

  // Ensure output directory exists and write the file
  const dir = path.dirname(outputFilePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  fs.writeFileSync(outputFilePath, finalWav);
}
