# Candidate Profile Template



# HOW TO USE THIS FILE

# ====================

# Copy this file to `fletcher/candidate_profile.md` (gitignored) and fill in YOUR real details.

# C2 (Fletcher) reads this file to get extra bullets and facts beyond what is in main.tex.



# Rules:

# - Keep everything 100% truthful. Never invent metrics, tools, or dates.

# - Entry IDs must match the slugs C2 derives from your main.tex roles.

# Run `fletch context` to see what IDs C2 sees for your current resume.

# - You can add more bullet candidates than will ever appear on one page.

# C2 will pick the most relevant ones per job.

# - Leave fields blank if you don't have data for them.

# - Dates use any human-readable format: "May 2023", "2022-09", "Present", etc.



# ENTRY ID MATCHING

# =================

# C2 matches entries by slug: it lowercases the title + company + location, strips punctuation,

# and joins with underscores.  Example:

# Title: "Software Developer Intern"  Company: "Acme Corp"  Location: "Toronto, ON"

# → entry_id slug: "software_developer_intern_acme_corp_toronto_on"

# Set Entry ID below to the same slug, or run `fletch context` to see exact IDs.



# ROLE-FAMILY TAGS

# ================

# Use one or more of: software, pm, data, general

# These control which job families this entry is surfaced for.



# JOB-LEVEL TAGS

# ==============

# Use one or more of: intern, new_grad, junior, mid, senior, staff, principal, manager, director

## Profile Metadata

- Full name: Michael Shi
- Preferred name: Michael
- Location: Toronto, ON
- Email:
- Website:
- LinkedIn:
- GitHub:

## Targeting Notes

- Preferred role families: software, pm
- Preferred industries: tech, fintech, SaaS
- Preferred job levels: junior, mid
- Hard no-go areas: unpaid internships, roles requiring security clearance
- Notes for PM roles: Emphasize cross-functional work, stakeholder alignment, roadmap experience
- Notes for data roles: Emphasize analytics, SQL, Python data work
- Notes for software roles: Emphasize backend, APIs, deployment pipelines

## Work Authorization

- Country: Canada
- Status: Citizen / Permanent Resident
- Sponsorship needed: No
- Relocation notes: Open to remote; GTA preferred

## Education Facts

- School:
- Degree:
- Program:
- Expected graduation:
- Awards:

## Experience Inventory



# Add one block per role. Duplicate the block as many times as needed.

# The Entry ID should match what `fletch context` shows for your main.tex roles.

# If you add a role NOT in main.tex, C2 may surface it as a supplemental entry.

### Experience Entry

- Entry ID: junior_software_developer_part_time_your_company_city
- Company: Your Company Name
- Title: Junior Software Developer (Part-time)
- Location: Toronto, ON
- Start date: Sep 2023
- End date: Present
- Role-family tags: software
- Job-level tags: junior
- Technology tags: python, fastapi, postgresql, docker
- Leadership tags:
- PM tags:
- Data tags:

#### Immutable facts

# Facts are things that MUST be true and cannot be changed (dates, titles, employers).

# They are used to anchor bullet rewrites.

- Fact ID: jsw_fact_01
  - Text: Worked part-time while completing degree, averaging 20 hours/week.
- Fact ID: jsw_fact_02
  - Text: Maintained a FastAPI service handling internal tooling requests.

#### Bullet candidates

# These are the raw bullet points C2 can choose from and score against the job description.

# Write them in resume style: start with a strong verb, be specific, include metrics where real.

# C2 will pick the highest-scoring ones for the target job.

- Bullet ID: jsw_b01
  - Text: Built and maintained a FastAPI REST service used by 3 internal teams, reducing manual data entry by ~40%.
  - Supported by fact IDs: jsw_fact_02
  - Relevance tags: software, backend, api
- Bullet ID: jsw_b02
  - Text: Wrote automated integration tests (pytest) that caught 12 regressions before production deploys.
  - Supported by fact IDs: jsw_fact_02
  - Relevance tags: software, testing, quality
- Bullet ID: jsw_b03
  - Text: Containerized the service with Docker and deployed to a staging environment, cutting environment setup time from 2 hours to 15 minutes.
  - Supported by fact IDs: jsw_fact_02
  - Relevance tags: software, devops, docker
- Bullet ID: jsw_b04
  - Text: Collaborated with a senior engineer on database schema design (PostgreSQL), improving query performance by ~30%.
  - Supported by fact IDs: jsw_fact_01
  - Relevance tags: software, data, database

#### Extra context

- Systems: FastAPI, PostgreSQL, Docker
- Stakeholders: Internal tooling team, 2 product teams
- Scale: ~500 internal requests/day
- Metrics: 40% reduction in manual entry, 30% query improvement
- Tools: Python, pytest, Docker, GitHub Actions

### Experience Entry

- Entry ID: software_developer_intern_your_other_company_city
- Company: Your Other Company
- Title: Software Developer Intern
- Location: Toronto, ON
- Start date: May 2023
- End date: Aug 2023
- Role-family tags: software
- Job-level tags: intern
- Technology tags: python, react, typescript, aws
- Leadership tags:
- PM tags:
- Data tags:

#### Immutable facts

- Fact ID: sdi_fact_01
  - Text: 4-month internship on the platform team.
- Fact ID: sdi_fact_02
  - Text: Contributed to a React + TypeScript frontend dashboard.

#### Bullet candidates

- Bullet ID: sdi_b01
  - Text: Developed 3 new dashboard views in React/TypeScript, adopted by the customer success team within the first sprint after launch.
  - Supported by fact IDs: sdi_fact_02
  - Relevance tags: software, frontend, react
- Bullet ID: sdi_b02
  - Text: Integrated an AWS S3 file-upload flow into the existing API, enabling customers to attach documents to support tickets.
  - Supported by fact IDs: sdi_fact_01
  - Relevance tags: software, aws, backend
- Bullet ID: sdi_b03
  - Text: Participated in daily standups and sprint planning; shipped 2 features in a 2-week sprint cycle.
  - Supported by fact IDs: sdi_fact_01
  - Relevance tags: software, agile, pm

#### Extra context

- Systems: React, TypeScript, AWS S3, REST API
- Stakeholders: Platform team, customer success team
- Scale: Used by ~200 external customers
- Metrics: 3 dashboard views shipped, 2 features per sprint
- Tools: React, TypeScript, Python, AWS, Jira

## Project Inventory



# Add one block per project. These appear in the Projects section of the resume.

### Project Entry

- Entry ID: hunt_job_agent
- Project name: Hunt — Automated Job Agent
- URL: [https://github.com/Micsushi/hunt](https://github.com/Micsushi/hunt)
- Role-family tags: software, pm
- Technology tags: python, fastapi, playwright, sqlite, docker, ollama
- Relevance notes: End-to-end job discovery, enrichment, and resume tailoring system

#### Immutable facts

- Fact ID: hunt_fact_01
  - Text: Personal project built from scratch; all code written by me.

#### Bullet candidates

- Bullet ID: hunt_p01
  - Text: Designed and built a multi-component job agent (C1–C4) that scrapes LinkedIn/Indeed, enriches postings with Playwright, and generates tailored resumes via a local LLM (Ollama).
  - Supported by fact IDs: hunt_fact_01
  - Relevance tags: software, pm, automation
- Bullet ID: hunt_p02
  - Text: Implemented a FastAPI review webapp with job queue management, resume diff view, and keyword highlighting panels.
  - Supported by fact IDs: hunt_fact_01
  - Relevance tags: software, frontend, fullstack
- Bullet ID: hunt_p03
  - Text: Deployed the full stack to a home server using Ansible playbooks with systemd timers for automated scraping and resume generation.
  - Supported by fact IDs: hunt_fact_01
  - Relevance tags: software, devops, ansible

### Project Entry

- Entry ID: your_other_project
- Project name: Your Other Project
- URL: [https://github.com/yourhandle/project](https://github.com/yourhandle/project)
- Role-family tags: software
- Technology tags: python, react
- Relevance notes: Brief description of what the project does

#### Immutable facts

- Fact ID: proj2_fact_01
  - Text: Built solo as a learning project.

#### Bullet candidates

- Bullet ID: proj2_b01
  - Text: Replace this with a real bullet point about what you built and its impact.
  - Supported by fact IDs: proj2_fact_01
  - Relevance tags: software

## Skills Inventory



# List your actual skills. C2 uses these to augment the skills section of the resume

# when a job description mentions matching technologies.

### Languages

- Skill ID: lang_python
  - Name: Python
  - Where used: All personal projects, internship backend work
  - Strength of evidence: strong
  - Related role families: software, data
- Skill ID: lang_typescript
  - Name: TypeScript
  - Where used: Internship frontend dashboard
  - Strength of evidence: moderate
  - Related role families: software
- Skill ID: lang_sql
  - Name: SQL
  - Where used: PostgreSQL at part-time job, SQLite in Hunt project
  - Strength of evidence: moderate
  - Related role families: software, data

### Frameworks

- Skill ID: fw_fastapi
  - Name: FastAPI
  - Where used: Part-time job backend service, Hunt project
  - Strength of evidence: strong
  - Related role families: software
- Skill ID: fw_react
  - Name: React
  - Where used: Internship frontend dashboard
  - Strength of evidence: moderate
  - Related role families: software
- Skill ID: fw_pytest
  - Name: pytest
  - Where used: Part-time job automated tests
  - Strength of evidence: moderate
  - Related role families: software

### Developer Tools

- Skill ID: tool_docker
  - Name: Docker
  - Where used: Part-time job containerization, Hunt project
  - Strength of evidence: moderate
  - Related role families: software
- Skill ID: tool_git
  - Name: Git / GitHub
  - Where used: All projects
  - Strength of evidence: strong
  - Related role families: software, pm, data
- Skill ID: tool_ansible
  - Name: Ansible
  - Where used: Hunt project server deployment
  - Strength of evidence: moderate
  - Related role families: software

## Leadership Examples

- Example 1:
- Example 2:

## PM Examples

- Example 1:
- Example 2:

## Data Examples

- Example 1:
- Example 2:

## Truth Constraints

- Never invent tools or metrics that did not happen.
- Never change dates, titles, employers, education, or contact info.
- If a detail is uncertain, leave it blank or mark it for review.