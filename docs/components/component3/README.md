# Component 3 : Application Automation

## Goal

Automate stable external job application flows using:
- the external application URL from Component 1
- the tailored resume from Component 2
- stored candidate profile and preference data

The purpose of this component is to automate eligible external applications, not LinkedIn Easy Apply.

## Desired Workflow

1. Receive a job that is marked ready for automation.
2. Open the external `apply_url`.
3. Determine whether the user already has an account for the target site.
4. Sign in or create an account when appropriate.
5. Fill fields using candidate profile data.
6. Upload the tailored resume generated for that specific job.
7. Generate paragraph responses when the application asks for free-text questions.
8. Verify the field mappings before submission.
9. Submit the application if the flow is eligible and stable.
10. Save the result, evidence, and any follow-up requirements.

## Eligibility Rules

Only attempt automation when:
- `apply_type = 'external_apply'`
- `auto_apply_eligible = 1`
- a tailored resume exists
- the target flow is stable enough to automate

Do not attempt automation when:
- the job is LinkedIn Easy Apply
- the flow is blocked by CAPTCHA or anti-bot protection
- the site requires unsupported verification steps
- the page is too ambiguous to submit confidently

Protected or blocked flows should be marked for manual review or failure handling.

## Input Data Needed

From Component 1:
- title
- company
- enriched description
- external application URL
- ATS classification

From Component 2:
- tailored LaTeX resume
- compiled PDF
- metadata about what resume version was generated

From user profile storage:
- name and contact info
- work authorization
- education history
- experience facts
- links like GitHub and LinkedIn
- saved answers and writing samples when appropriate

## Planned Capabilities

- account creation and sign-in support for repeated job sites
- browser extension or browser automation support for form filling
- structured field mapping before submission
- generated free-text responses grounded in the job description and candidate facts
- post-submit evidence capture

Possible technical shape:
- browser automation with Playwright or a similar driver
- an autofill extension for common fields
- an agent layer for harder page understanding and response generation

## Proposed Stages

### Stage 1 : site profile and account model

- model account state per target site
- store credentials and verification status securely
- define when account creation is allowed

### Stage 2 : form detection and field mapping

- classify common application fields
- map candidate profile data into those fields
- add review logic before submission

### Stage 3 : resume upload and text generation

- upload the tailored resume for the job
- answer paragraph questions using grounded context
- record which generated answers were used

### Stage 4 : submission and evidence

- capture what was submitted
- save screenshots or structured logs
- mark final DB status

### Stage 5 : recovery and manual handoff

- handle partial submissions
- record why a flow failed
- hand blocked flows to manual review

## Risks And Constraints

- sites vary heavily in structure and required fields
- login and account-creation flows can change without notice
- unsupported verification flows will need manual fallback
- anti-bot and CAPTCHA bypassing are out of scope
- low-confidence field mapping should never auto-submit

## Dependency On Other Components

- depends on Component 1 for trustworthy external application URLs
- depends on Component 2 for a job-specific resume that is ready to upload
