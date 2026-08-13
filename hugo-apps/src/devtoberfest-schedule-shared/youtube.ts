export function youtubeId(url: string): string | null {
  if (!url) return null;
  // Handles watch (?v=), youtu.be/, /embed/, /live/ and /shorts/ URL shapes.
  // Devtoberfest session recordings are stored as /live/<id> links, so that
  // form must resolve or thumbnails, the embedded player and transcript all break.
  const m = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/live\/|\/shorts\/)([\w-]{6,})/);
  return m ? m[1] : null;
}

export function youtubeEmbedUrl(url: string): string {
  const id = youtubeId(url);
  return id ? `https://www.youtube.com/embed/${id}` : '';
}
