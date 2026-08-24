export async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  return data;
}

export async function patchJson(url, body) {
  const response = await fetch(url, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  return data;
}

export async function putJson(url, body) {
  const response = await fetch(url, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  return data;
}

export async function fetchJsonOrNull(url) {
  const response = await fetch(url);
  if (response.status === 404) return null;
  const data = await response.json();
  if (!response.ok) throw new Error(`${data.code}: ${data.message}`);
  return data;
}

export function reviewProjectApiUrl(seriesId, reviewProjectId, route) {
  return `/api/series/${encodeURIComponent(seriesId)}/review-projects/${encodeURIComponent(reviewProjectId)}/${route}`;
}

export function storyApiUrl(channelId, route) {
  return `/api/series/${encodeURIComponent(channelId)}/${route}`;
}

export function seriesFileUrl(seriesId, relativePath) {
  return `/api/projects/${encodeURIComponent(seriesId)}/files/${encodeURIComponent(relativePath)}`;
}
