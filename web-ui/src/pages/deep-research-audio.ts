import * as fs from 'fs';
import * as path from 'path';
import type { APIRoute } from 'astro';

export const GET: APIRoute = async ({ request }) => {
  const url = new URL(request.url);
  const id = url.searchParams.get('id');

  if (!id) {
    return new Response('Missing session id', { status: 400 });
  }

  // Ensure safe file path to prevent directory traversal
  const safeId = path.basename(id);
  const filePath = `/app/data/research_results/${safeId}/podcast.wav`;

  if (!fs.existsSync(filePath)) {
    return new Response('Audio file not found', { status: 404 });
  }

  const fileBuffer = fs.readFileSync(filePath);

  return new Response(fileBuffer, {
    headers: {
      'Content-Type': 'audio/wav',
      'Content-Length': fileBuffer.length.toString(),
    },
  });
};
