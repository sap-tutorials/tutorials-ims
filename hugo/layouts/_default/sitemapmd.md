{{- /* /sitemap.md — human + AI navigable map of the site, mirroring CAP/Capire's sitemap.md.
     Navigation is built from the verb section pages (always present at build).
     Missions are expanded from hugo/data/sitemap_catalog.json (fetch-sitemap-catalog.ts);
     when that data is absent (plain build / no CAP_BASE_URL) the Missions section
     falls back to linking the /missions/ index, like llms.txt. */ -}}
# SAP Developers Tutorials — Site Map

> Official tutorial platform for SAP technologies. Step-by-step tutorials, missions (multi-tutorial learning paths), and reference content for SAP BTP, ABAP Cloud, CAP, Fiori, HANA Cloud, and integration.

Semantic site map mirroring the site's navigation, with missions expanded to their ordered tutorials.

Content policy: Citation in AI search and answer use cases is welcome. Use for model training is not.
See {{ "AGENTS.md" | absURL }}.

## Navigation

{{- $verbKeys := slice "LEARN" "BUILD" "INTEGRATE" "OPERATE" "CONNECT" "AI" }}
{{- $shelfDefs := slice }}
{{- with .Site.Data.shelf_definitions }}{{ $shelfDefs = .shelves }}{{ end }}
{{- range $key := $verbKeys }}
{{- range $.Site.Sections }}
{{- if eq (.Params.verbKey) $key }}
### [{{ .Title }}]({{ .Permalink }})
{{ with .Params.description }}{{ . | plainify | chomp }}{{ end }}
{{- range $shelfDefs }}
{{- if eq .verb $key }}
- [{{ .title }}]({{ .url }}){{ with .description }}: {{ . | plainify | chomp }}{{ end }}
{{- end }}
{{- end }}
{{ end }}
{{- end }}
{{- end }}

## Missions

{{- $missions := slice }}
{{- with .Site.Data.sitemap_catalog }}{{ $missions = .missions }}{{ end }}
{{- if $missions }}
{{- range $missions }}
- [{{ .title }}]({{ (printf "missions/%s/" .slug) | absURL }}){{ with .description }}: {{ . | plainify | chomp }}{{ end }}
{{- range .tutorials }}
  - [{{ .title }}]({{ (printf "tutorials/%s/" .slug) | absURL }})
{{- end }}
{{- end }}
{{ else }}
Missions are multi-tutorial learning paths served dynamically from the catalog.
Browse the full, up-to-date list at the mission index: {{ "missions/" | absURL }}
{{- end }}

## Topics

{{ range first 30 .Site.Taxonomies.tags.ByCount }}
- [{{ .Page.Title }}]({{ .Page.Permalink }}) — {{ .Count }} tutorials
{{- end }}

## Reference

- Tutorial index: {{ "tutorials/" | absURL }}
- Mission index: {{ "missions/" | absURL }}
- Curated AI index: {{ "llms.txt" | absURL }}
- Full machine-readable catalog: {{ "llms-full.txt" | absURL }}
- XML sitemap: {{ "sitemap.xml" | absURL }}
- Agent guidance: {{ "AGENTS.md" | absURL }}
