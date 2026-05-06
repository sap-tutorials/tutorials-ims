#!/usr/bin/env node
/**
 * Match published content slugs to database legacyIds by comparing
 * which tutorials each mission contains.
 *
 * Flow:
 * 1. Fetch build/catalog → missionImsId → tutorialSlugs (from DB via CompletionPathItems)
 * 2. Fetch each published mission HTML → extract tutorial hrefs
 * 3. Match by tutorial set overlap (Jaccard similarity)
 * 4. Output mapping: { publishedSlug → legacyId }
 */

const CAP_URL = process.env.CAP_BASE_URL || 'https://developer-destination-ims-dev-tutorials-srv.cfapps.eu10-005.hana.ondemand.com'

async function main() {
  // Step 1: Get published mission/group slugs
  console.log('Fetching published content hashes...')
  const hashesRes = await fetch(`${CAP_URL}/content/hashes`)
  const hashes = await hashesRes.json()
  const publishedMissions = Object.keys(hashes).filter(k => k.startsWith('mission-'))
  const publishedGroups = Object.keys(hashes).filter(k => k.startsWith('group-'))
  console.log(`  Found ${publishedMissions.length} missions, ${publishedGroups.length} groups`)

  // Step 2: Get build catalog (missionImsId → groups → tutorialSlugs)
  console.log('Fetching build/catalog...')
  const catalogRes = await fetch(`${CAP_URL}/build/catalog`)
  const catalog = await catalogRes.json()

  // Build DB mission → tutorial set map
  // Tutorial slugs from catalog end with .md, strip that
  const dbMissionTutorials = new Map() // legacyId → Set<tutorialSlug>
  const dbGroupTutorials = new Map() // groupLegacyId → Set<tutorialSlug>
  const dbGroupToMission = new Map() // groupLegacyId → missionLegacyId

  for (const h of catalog.hierarchies) {
    const missionTuts = new Set()
    for (const g of h.groups) {
      const groupTuts = new Set()
      for (const t of g.tutorialSlugs) {
        const slug = t.replace(/\.md$/, '')
        missionTuts.add(slug)
        groupTuts.add(slug)
      }
      if (groupTuts.size > 0) {
        dbGroupTutorials.set(g.imsId, groupTuts)
      }
      dbGroupToMission.set(g.imsId, h.missionImsId)
    }
    if (missionTuts.size > 0) {
      dbMissionTutorials.set(h.missionImsId, missionTuts)
    }
  }
  console.log(`  DB missions with tutorials: ${dbMissionTutorials.size}`)
  console.log(`  DB groups with tutorials: ${dbGroupTutorials.size}`)

  // Step 3: Fetch published mission HTML pages and extract tutorial refs
  console.log('Fetching published mission HTML pages...')
  const publishedMissionTutorials = new Map() // publishedSlug → Set<tutorialSlug>
  const publishedMissionGroups = new Map() // publishedSlug → Set<groupSlug>

  const BATCH_SIZE = 10
  for (let i = 0; i < publishedMissions.length; i += BATCH_SIZE) {
    const batch = publishedMissions.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(async slug => {
      const res = await fetch(`${CAP_URL}/content/tutorials/${slug}`)
      if (!res.ok) return { slug, tutorials: [], groups: [] }
      const html = await res.text()
      // Extract tutorial hrefs: /tutorials/<slug> (not mission- or group-)
      const tutRefs = [...html.matchAll(/href="\/tutorials\/([^"]+)"/g)]
        .map(m => m[1])
        .filter(s => !s.startsWith('mission-') && !s.startsWith('group-'))
      // Extract group refs
      const groupRefs = [...html.matchAll(/href="\/tutorials\/(group-[^"]+)"/g)]
        .map(m => m[1])
      return { slug, tutorials: [...new Set(tutRefs)], groups: [...new Set(groupRefs)] }
    }))
    for (const r of results) {
      if (r.tutorials.length > 0) publishedMissionTutorials.set(r.slug, new Set(r.tutorials))
      if (r.groups.length > 0) publishedMissionGroups.set(r.slug, new Set(r.groups))
    }
    process.stdout.write(`  ${Math.min(i + BATCH_SIZE, publishedMissions.length)}/${publishedMissions.length}\r`)
  }
  console.log(`\n  Published missions with tutorial refs: ${publishedMissionTutorials.size}`)

  // Step 4: Match by tutorial overlap
  console.log('Matching missions by tutorial overlap...')
  const missionMapping = new Map() // publishedSlug → legacyId

  for (const [pubSlug, pubTuts] of publishedMissionTutorials) {
    let bestMatch = null
    let bestScore = 0

    for (const [legacyId, dbTuts] of dbMissionTutorials) {
      const intersection = new Set([...pubTuts].filter(t => dbTuts.has(t)))
      const union = new Set([...pubTuts, ...dbTuts])
      const jaccard = intersection.size / union.size
      if (jaccard > bestScore) {
        bestScore = jaccard
        bestMatch = { legacyId, score: jaccard, overlap: intersection.size, pubSize: pubTuts.size, dbSize: dbTuts.size }
      }
    }

    if (bestMatch && bestMatch.score > 0.3) {
      missionMapping.set(pubSlug, bestMatch)
    }
  }
  console.log(`  Matched ${missionMapping.size} missions`)

  // Step 5: Match groups via published group pages
  console.log('Fetching published group HTML pages...')
  const publishedGroupTutorials = new Map()

  for (let i = 0; i < publishedGroups.length; i += BATCH_SIZE) {
    const batch = publishedGroups.slice(i, i + BATCH_SIZE)
    const results = await Promise.all(batch.map(async slug => {
      const res = await fetch(`${CAP_URL}/content/tutorials/${slug}`)
      if (!res.ok) return { slug, tutorials: [] }
      const html = await res.text()
      const tutRefs = [...html.matchAll(/href="\/tutorials\/([^"]+)"/g)]
        .map(m => m[1])
        .filter(s => !s.startsWith('mission-') && !s.startsWith('group-'))
      return { slug, tutorials: [...new Set(tutRefs)] }
    }))
    for (const r of results) {
      if (r.tutorials.length > 0) publishedGroupTutorials.set(r.slug, new Set(r.tutorials))
    }
    process.stdout.write(`  ${Math.min(i + BATCH_SIZE, publishedGroups.length)}/${publishedGroups.length}\r`)
  }
  console.log(`\n  Published groups with tutorial refs: ${publishedGroupTutorials.size}`)

  // Match groups
  const groupMapping = new Map()
  for (const [pubSlug, pubTuts] of publishedGroupTutorials) {
    let bestMatch = null
    let bestScore = 0

    for (const [legacyId, dbTuts] of dbGroupTutorials) {
      const intersection = new Set([...pubTuts].filter(t => dbTuts.has(t)))
      const union = new Set([...pubTuts, ...dbTuts])
      const jaccard = intersection.size / union.size
      if (jaccard > bestScore) {
        bestScore = jaccard
        bestMatch = { legacyId, score: jaccard, overlap: intersection.size, pubSize: pubTuts.size, dbSize: dbTuts.size }
      }
    }

    if (bestMatch && bestMatch.score > 0.3) {
      groupMapping.set(pubSlug, bestMatch)
    }
  }
  console.log(`  Matched ${groupMapping.size} groups`)

  // Output results
  console.log('\n=== MISSION MAPPING ===')
  const missionResult = {}
  for (const [slug, match] of [...missionMapping].sort((a, b) => b[1].score - a[1].score)) {
    missionResult[slug] = { legacyId: match.legacyId, score: Math.round(match.score * 100) / 100, overlap: match.overlap }
    if (match.score < 1.0) {
      console.log(`  ${slug} → ${match.legacyId} (score: ${match.score.toFixed(2)}, overlap: ${match.overlap}/${match.pubSize} pub, ${match.dbSize} db)`)
    }
  }

  console.log('\n=== GROUP MAPPING ===')
  const groupResult = {}
  for (const [slug, match] of [...groupMapping].sort((a, b) => b[1].score - a[1].score)) {
    groupResult[slug] = { legacyId: match.legacyId, score: Math.round(match.score * 100) / 100, overlap: match.overlap }
    if (match.score < 1.0) {
      console.log(`  ${slug} → ${match.legacyId} (score: ${match.score.toFixed(2)}, overlap: ${match.overlap}/${match.pubSize} pub, ${match.dbSize} db)`)
    }
  }

  // Save full mapping
  const output = { missions: missionResult, groups: groupResult }
  const { writeFileSync } = await import('fs')
  writeFileSync('.migration-data/slug-id-mapping.json', JSON.stringify(output, null, 2))
  console.log(`\nSaved to .migration-data/slug-id-mapping.json`)
  console.log(`Total: ${Object.keys(missionResult).length} missions, ${Object.keys(groupResult).length} groups mapped`)

  // Show perfect matches
  const perfectMissions = Object.values(missionResult).filter(m => m.score === 1).length
  const perfectGroups = Object.values(groupResult).filter(g => g.score === 1).length
  console.log(`Perfect matches: ${perfectMissions} missions, ${perfectGroups} groups`)
}

main().catch(console.error)
