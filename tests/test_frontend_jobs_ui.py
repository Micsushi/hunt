from pathlib import Path
import re


ROOT = Path(__file__).resolve().parents[1]


def read(relative: str) -> str:
    return (ROOT / relative).read_text(encoding="utf-8")


def test_jobs_filters_do_not_expose_operator_tag_filter():
    filters = read("frontend/src/components/Filters/index.tsx")

    assert "Tag filter" not in filters
    assert "tagInput" not in filters
    assert "Filter by tag" not in filters


def test_jobs_table_keeps_id_on_one_line_and_truncates_long_titles():
    page = read("frontend/src/pages/Jobs/index.tsx")
    styles = read("frontend/src/pages/Jobs/Jobs.module.css")

    assert "Tag:" not in page
    assert "styles.tagCell" not in page
    assert "className={styles.idCell}" in page
    assert "className={styles.titleCell}" in page
    assert ".idCell" in styles and "white-space: nowrap" in styles
    id_link_block = re.search(r"\.idCell a \{(?P<body>.*?)\}", styles, re.S)
    assert id_link_block is not None
    assert "text-overflow" not in id_link_block.group("body")
    assert ".titleCell" in styles and "text-overflow: ellipsis" in styles


def test_dark_theme_controls_keep_readable_text_colors():
    filters = read("frontend/src/components/Filters/Filters.module.css")
    jobs = read("frontend/src/pages/Jobs/Jobs.module.css")

    assert "color: var(--ink);" in re.search(r"\.limitBtn \{(?P<body>.*?)\}", filters, re.S).group("body")
    assert "color: var(--ink);" in re.search(r"\.advSummary \{(?P<body>.*?)\}", jobs, re.S).group("body")
    assert "color: var(--accent-ink);" in re.search(r"\.advBtn\.advBtnPrimary \{(?P<body>.*?)\}", jobs, re.S).group("body")


def test_job_detail_dark_theme_does_not_use_light_theme_text_assumptions():
    detail = read("frontend/src/pages/Jobs/JobDetail.module.css")

    assert "background: #faf5ec" not in detail
    assert "color: white" not in detail
    assert "color: var(--accent-ink);" not in re.search(r"\.backBtn \{(?P<body>.*?)\}", detail, re.S).group("body")
    assert "color: var(--accent-ink);" not in re.search(r"\.tab\.tabActive \{(?P<body>.*?)\}", detail, re.S).group("body")
    assert "color: var(--accent-ink);" not in re.search(r"\.artifactBtn \{(?P<body>.*?)\}", detail, re.S).group("body")


def test_dark_theme_accent_uses_muted_green_instead_of_bright_neon():
    tokens = read("frontend/src/styles/tokens.css")

    assert "--accent:         #59a96a;" in tokens
    assert "#3ecf6e" not in tokens
