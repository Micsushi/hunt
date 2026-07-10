---
name: Hunt
version: beta
description: Dark olive-green theme derived from coolors.co/474a2c-636940-59a96a-9bdeac-b4e7ce. Operational job pipeline control dashboard. Saturated green accent on deep olive-black surfaces, data-dense layout. Updated 2026-04-25.
palette_source: "https://coolors.co/474a2c-636940-59a96a-9bdeac-b4e7ce"
palette_swatches:
  dark-olive:  "#474a2c"
  olive:       "#636940"
  mid-green:   "#59a96a"
  light-green: "#9bdeac"
  mint:        "#b4e7ce"
colors:
  bg: "#0f1a14"
  bg-gradient-top: "#0f1a14"
  bg-gradient-bottom: "#0b120e"
  panel: "#172212"
  panel-strong: "#1d2b18"
  panel-hover: "#223320"
  text-primary: "#d4f0dc"
  text-secondary: "#9bb69f"
  border: "#2a3f2a"
  border-strong: "#3a5a3a"
  accent: "#59a96a"
  accent-soft: "#1e3a26"
  accent-ink: "#07100a"
  accent-dim: "#4f965f"
  warning: "#f0b429"
  warning-soft: "#2d2410"
  danger: "#f05252"
  danger-soft: "#2d1414"
  positive: "#9bdeac"
  positive-soft: "#1a2e1e"
  info: "#7bc4d8"
  info-soft: "#102030"
chart_colors:
  note: "Charts use a diverse independent palette for readability - not brand colors."
  pie: ["#60a5fa","#34d399","#fbbf24","#f87171","#a78bfa","#fb923c","#38bdf8","#e879f9"]
  source_linkedin: "#60a5fa"
  source_indeed: "#34d399"
  source_unknown: "#6b7280"
typography:
  body-md:
    fontFamily: "Segoe UI, system-ui, -apple-system, sans-serif"
    fontSize: "1rem"
    lineHeight: "1.5"
  body-sm:
    fontFamily: "Segoe UI, system-ui, -apple-system, sans-serif"
    fontSize: "0.875rem"
  mono:
    fontFamily: "Consolas, SFMono-Regular, SF Mono, monospace"
    fontSize: "0.875rem"
    lineHeight: "1.5"
rounded:
  sm: "6px"
  md: "10px"
  lg: "14px"
  xl: "16px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.sm}"
    padding: "8px 16px"
  button-primary-hover:
    backgroundColor: "{colors.accent-dim}"
  button-ghost:
    backgroundColor: "transparent"
    textColor: "{colors.text-primary}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.sm}"
    padding: "7px 14px"
  card:
    backgroundColor: "{colors.panel}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.md}"
    padding: "1.25rem"
    shadow: "0 4px 16px rgba(0,0,0,0.4)"
  input:
    backgroundColor: "{colors.panel-strong}"
    textColor: "{colors.text-primary}"
    border: "1px solid {colors.border}"
    rounded: "{rounded.sm}"
    padding: "0.5rem 0.75rem"
  status-badge-running:
    backgroundColor: "{colors.positive-soft}"
    textColor: "{colors.positive}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  status-badge-error:
    backgroundColor: "{colors.danger-soft}"
    textColor: "{colors.danger}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  status-badge-warning:
    backgroundColor: "{colors.warning-soft}"
    textColor: "{colors.warning}"
    rounded: "{rounded.pill}"
    padding: "2px 10px"
  status-dot:
    size: "7px"
    shape: "circle"
    colors: "green=#59a96a / amber=#f0b429 / red=#f05252 / grey=#474a2c"
---


## Sections
- [Overview](docs/ui-design/overview.md)
- [Colors](docs/ui-design/colors.md)
- [Typography](docs/ui-design/typography.md)
- [Layout](docs/ui-design/layout.md)
- [Elevation & Depth](docs/ui-design/elevation-depth.md)
- [Shapes](docs/ui-design/shapes.md)
- [Components](docs/ui-design/components.md)
- [Nav Status Indicators](docs/ui-design/nav-status-indicators.md)
- [Overview Page - Redesign](docs/ui-design/overview-page-redesign.md)
- [Jobs Table - Cleanup](docs/ui-design/jobs-table-cleanup.md)
- [Change Log](docs/ui-design/change-log.md)
- [Logs Page - Redesign](docs/ui-design/logs-page-redesign.md)
- [Polish Work Checklist](docs/ui-design/polish-work-checklist.md)
- [Out of Scope](docs/ui-design/out-of-scope.md)
- [Do's and Don'ts](docs/ui-design/do-s-and-don-ts.md)

## Rule
- Keep token front matter here. Put detailed rationale in `DESIGN-parts/`.
