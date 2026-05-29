import * as fs from "fs";
import * as path from "path";
import { retryWithBackoff } from "./utils.js";

interface MattermostFileResponse {
  file_infos: {
    id: string;
    name: string;
    extension: string;
    size: number;
  }[];
}

interface MattermostPostResponse {
  id: string;
  channel_id: string;
  message: string;
}

interface MattermostChannel {
  id: string;
  name: string;
  display_name: string;
  type: string;
}

/**
 * Dynamically resolves a Mattermost channel ID by its name (slug) or display name.
 * Falls back to a default ID if the channel is not found.
 */
export async function resolveChannelIdByName(
  channelName: string,
  apiUrl: string,
  token: string,
  fallbackId: string
): Promise<string> {
  const url = `${apiUrl}/api/v4/users/me/channels`;

  try {
    return await retryWithBackoff(async () => {
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      if (!response.ok) {
        throw new Error(`Failed to list channels: HTTP ${response.status}`);
      }

      const channels = (await response.json()) as MattermostChannel[];
      const matched = channels.find(
        (c) =>
          c.name.toLowerCase() === channelName.toLowerCase() ||
          c.display_name.toLowerCase() === channelName.toLowerCase()
      );

      if (matched) {
        console.error(`Successfully resolved channel '${channelName}' to ID: ${matched.id}`);
        return matched.id;
      }

      console.error(`Channel '${channelName}' not found in user channels. Using fallback ID.`);
      return fallbackId;
    });
  } catch (error) {
    console.error(`Error resolving channel ID by name: ${error}. Using fallback ID.`);
    return fallbackId;
  }
}

export async function uploadFileToMattermost(
  filePath: string,
  channelId: string,
  apiUrl: string,
  token: string
): Promise<string> {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const file = new File([fileBuffer], fileName, { type: "audio/wav" });

  const formData = new FormData();
  formData.append("channel_id", channelId);
  formData.append("files", file);

  return retryWithBackoff(async () => {
    const response = await fetch(`${apiUrl}/api/v4/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Mattermost file upload failed with status ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as MattermostFileResponse;
    if (!data.file_infos || data.file_infos.length === 0) {
      throw new Error("Mattermost upload succeeded but returned no file info");
    }

    return data.file_infos[0].id;
  });
}

export async function uploadImageToMattermost(
  filePath: string,
  channelId: string,
  apiUrl: string,
  token: string
): Promise<string> {
  const fileName = path.basename(filePath);
  const fileBuffer = fs.readFileSync(filePath);
  const file = new File([fileBuffer], fileName, { type: "image/jpeg" });

  const formData = new FormData();
  formData.append("channel_id", channelId);
  formData.append("files", file);

  return retryWithBackoff(async () => {
    const response = await fetch(`${apiUrl}/api/v4/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
      },
      body: formData,
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Mattermost image upload failed with status ${response.status}: ${errorText}`);
    }

    const data = (await response.json()) as MattermostFileResponse;
    if (!data.file_infos || data.file_infos.length === 0) {
      throw new Error("Mattermost upload succeeded but returned no file info");
    }

    return data.file_infos[0].id;
  });
}

export async function sendPostToMattermost(
  channelId: string,
  message: string,
  fileIds: string[],
  apiUrl: string,
  token: string
): Promise<MattermostPostResponse> {
  return retryWithBackoff(async () => {
    const response = await fetch(`${apiUrl}/api/v4/posts`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        channel_id: channelId,
        message: message,
        file_ids: fileIds,
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Mattermost post failed with status ${response.status}: ${errorText}`);
    }

    return (await response.json()) as MattermostPostResponse;
  });
}
