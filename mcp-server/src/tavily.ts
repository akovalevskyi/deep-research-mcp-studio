import { retryWithBackoff } from "./utils.js";

export interface TavilyResult {
  title: string;
  url: string;
  content: string;
  score: number;
}

export interface TavilyResponse {
  answer?: string;
  results: TavilyResult[];
}

export async function searchTavily(
  query: string,
  apiKey: string,
  searchDepth: "basic" | "advanced" = "advanced"
): Promise<TavilyResponse> {
  const url = "https://api.tavily.com/search";

  return retryWithBackoff(async () => {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        api_key: apiKey,
        query: query,
        search_depth: searchDepth,
        include_answer: true,
        max_results: 8,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Tavily Search API failed with status ${response.status}: ${errorText}`);
    }

    return (await response.json()) as TavilyResponse;
  });
}
