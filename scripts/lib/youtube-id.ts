// scripts/lib/youtube-id.ts
//
// Server-side YouTube URL → video-ID extractor. Ported verbatim from the
// client-side hugo-apps/src/devtoberfest-schedule-shared/youtube.ts so the
// build pipeline can resolve [AUTOAUTHOR_VIDEO_*] directive URLs without
// pulling in the Vue island bundle. Pure function, no dependency.
//
// Handles watch (?v=), youtu.be/, /embed/, /live/ and /shorts/ URL shapes.
// The /live/ form matters because Devtoberfest session recordings are stored
// as /live/<id> links.

export function youtubeId(url: string): string | null {
  if (!url) return null
  const m = url.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/live\/|\/shorts\/)([\w-]{6,})/)
  return m ? m[1] : null
}
