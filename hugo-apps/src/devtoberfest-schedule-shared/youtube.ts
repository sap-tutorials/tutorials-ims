export function youtubeId(url: string): string | null {
  if (!url) return null;
  const m = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/)([\w-]{6,})/);
  return m ? m[1] : null;
}
