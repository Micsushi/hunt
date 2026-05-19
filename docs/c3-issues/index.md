# C3 Issue Registry

Durable issue ledger generated from C3 live-smoke audits. Use this to promote unknown questions into the catalog, identify common UI gaps, and keep page-walk failures out of chat-only memory.

## Known Error Types
- `unknown_question_defaulted`: C3 selected a fallback for an unmapped question. Review selected option and add a catalog mapping when reusable.
- `unknown_question_unresolved`: C3 could not safely resolve an unmapped question.
- `unsupported_or_empty_option_set`: C3 saw an option control but no usable options or an already-committed value without options.
- `required_field_unfilled`: A required field remained empty after fill.
- `no_safe_next_button`: Page-walk could not find a safe Next/Continue action.
- `auth_primary_action_not_found`: Auth page had no safe sign-in/create-account action.
- `posting_not_found`: Workday says the posting or apply URL does not exist.
- `commit_not_verified`: UI showed a value but C3 could not verify React/Workday commit.
- `final_visible_errors`: Final inspected page still had visible error-like text.

## Latest Issues

### field_review_warning : Profile value derived from another saved field.
- count: 3
- firstSeen: 2026-05-19T00:35:36.658Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://amgen.wd1.myworkdayjobs.com/Careers/job/Germany---Munich-Research/Scientist--m-w-d----unbefristet_R-244770-1
- step: My Information -> Review
- question: First Name* First Name* name--legalName--firstName legalName--firstName text legalname--firstname name--legalname--firstname first name* legal name first name* last name* i have a
- valueSource: derived:firstName
- audits: logs\live_amgen_scientist_r244770_1_authwaitfix_20260518.audit.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### field_review_warning : Profile value derived from another saved field.
- count: 3
- firstSeen: 2026-05-19T00:35:36.658Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://amgen.wd1.myworkdayjobs.com/Careers/job/Germany---Munich-Research/Scientist--m-w-d----unbefristet_R-244770-1
- step: My Information -> Review
- question: Last Name* Last Name* name--legalName--lastName legalName--lastName text legalname--lastname name--legalname--lastname last name* legal name first name* last name* i have a preferr
- valueSource: derived:lastName
- audits: logs\live_amgen_scientist_r244770_1_authwaitfix_20260518.audit.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### field_review_warning : Profile value derived from another saved field.
- count: 3
- firstSeen: 2026-05-19T00:35:36.658Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://amgen.wd1.myworkdayjobs.com/Careers/job/Germany---Munich-Research/Scientist--m-w-d----unbefristet_R-244770-1
- step: My Information -> Review
- question: First Name* First Name* name--preferredName--firstName preferredName--firstName text preferredname--firstname name--preferredname--firstname first name* preferred name first name*
- valueSource: derived:firstName
- audits: logs\live_amgen_scientist_r244770_1_authwaitfix_20260518.audit.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### field_review_warning : Profile value derived from another saved field.
- count: 3
- firstSeen: 2026-05-19T00:35:36.658Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://amgen.wd1.myworkdayjobs.com/Careers/job/Germany---Munich-Research/Scientist--m-w-d----unbefristet_R-244770-1
- step: My Information -> Review
- question: Last Name* Last Name* name--preferredName--lastName preferredName--lastName text preferredname--lastname name--preferredname--lastname last name* preferred name first name* last na
- valueSource: derived:lastName
- audits: logs\live_amgen_scientist_r244770_1_authwaitfix_20260518.audit.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### page_walk_stopped : already_on_application_step
- count: 3
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step:  -> 
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### page_walk_stopped : fill_not_ready_for_next
- count: 3
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: Next skipped because fill still needs review.
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 2
- firstSeen: 2026-05-19T02:05:27.725Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn
- step: My Information -> My Information
- question: First Name* First Name* name--preferredName--firstName preferredName--firstName text preferredname--firstname name--preferredname--firstname first name* preferred name first name* last name*
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 2
- firstSeen: 2026-05-19T02:05:27.725Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn
- step: My Information -> My Information
- question: Last Name* Last Name* name--preferredName--lastName preferredName--lastName text preferredname--lastname name--preferredname--lastname last name* preferred name first name* last name*
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json, C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T02:06:04.870Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: First Name* First Name* name--legalName--firstName legalName--firstName text legalname--firstname name--legalname--firstname first name* legal name first name* last name* i have a preferred name preferred name first name* last name*
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T02:06:04.870Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: Last Name* Last Name* name--legalName--lastName legalName--lastName text legalname--lastname name--legalname--lastname last name* legal name first name* last name* i have a preferred name preferred name first name* last name*
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### unsupported_or_empty_option_set : No selectable option was available.
- count: 1
- firstSeen: 2026-05-19T02:06:04.870Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: Province or Territory* Alberta Province or Territory*Alberta address--countryRegion countryRegion Province or Territory Alberta Required button countryregion address--countryregion province or territory alberta required province or territory* address address line 1* address line 2 city* province or territory* alberta postal code*
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### unsupported_or_empty_option_set : No selectable option was available.
- count: 1
- firstSeen: 2026-05-19T02:06:04.870Z
- lastSeen: 2026-05-19T02:06:04.870Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: Province or Territory* Alberta Province or Territory*Alberta address--countryRegion countryRegion Province or Territory Alberta Required button countryregion address--countryregion
- valueSource: profile:province
- options: Province or Territory Alberta Required Alberta
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-39-267Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T02:05:27.725Z
- lastSeen: 2026-05-19T02:05:27.725Z
- job: https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn
- step: My Information -> My Information
- question: First Name* First Name* name--legalName--firstName legalName--firstName text legalname--firstname name--legalname--firstname first name* legal name first name* last name* i have a preferred name
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T02:05:27.725Z
- lastSeen: 2026-05-19T02:05:27.725Z
- job: https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn
- step: My Information -> My Information
- question: Last Name* Last Name* name--legalName--lastName legalName--lastName text legalname--lastname name--legalname--lastname last name* legal name first name* last name* i have a preferred name
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T02:05:27.725Z
- lastSeen: 2026-05-19T02:05:27.725Z
- job: https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn
- step: My Information -> My Information
- question: I have a preferred name I have a preferred name name--preferredCheck preferredCheck checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last name* i have a preferred name
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json

### v2_permanent_issue : Selected first real non-placeholder option.
- count: 1
- firstSeen: 2026-05-19T02:05:27.725Z
- lastSeen: 2026-05-19T02:05:27.725Z
- job: https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn
- step: My Information -> My Information
- question: I have a preferred name I have a preferred name name--preferredCheck preferredCheck checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last name* i have a preferred name
- options: checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last name* i have a preferred name
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json

### field_review_warning : Profile value derived from another saved field. | max_progress_first_real_option:Selected first real non-placeholder option.
- count: 1
- firstSeen: 2026-05-19T02:05:27.725Z
- lastSeen: 2026-05-19T02:05:27.725Z
- job: https://talentmanagementsolution.wd3.myworkdayjobs.com/en-US/JonasSoftwareCanada/job/Remote---Canada/Junior-AI-Software-Engineer_R50805-1?source=LinkedIn
- step: My Information -> My Information
- question: I have a preferred name I have a preferred name name--preferredCheck preferredCheck checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last
- valueSource: fallback:first_real_option
- options: checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last name* i have a preferred name
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T02-05-00-099Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text legalname--firstname name--legalname--firstname first name* legal name first name* last name* i have a preferred name
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last name* i have a preferred name
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### v2_permanent_issue : Selected first real non-placeholder option.
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last name* i have a preferred name
- options: checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last name* i have a preferred name
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### v2_permanent_issue : commit_failed
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text off phonenumber--countryphonecode search country phone code* phone phone device type* select one country phone code* 1 item selected, canada (+1) canada (+1) phone number* phone extension
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text preferredname--firstname name--preferredname--firstname first name* preferred name first name* last name*
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### derived_profile_pairing : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text preferredname--lastname name--preferredname--lastname last name* preferred name first name* last name*
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### v2_permanent_issue : commit_failed
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text off phonenumber--countryphonecode search country phone code* phone phone device type* mobile country phone code* 1 item selected, canada (+1) canada (+1) phone number* phone extension
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### v2_permanent_issue : commit_failed
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text off searchbox phonenumber--countryphonecode search country phone code* phone phone device type* mobile country phone code* minimized canada (+1) phone number* phone extension
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### field_review_warning : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text legalname--firstname name--legalname--firstname first name* legal name first name* last name* i have a preferred name
- valueSource: derived:firstName
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### field_review_warning : Profile value derived from another saved field. | max_progress_first_real_option:Selected first real non-placeholder option.
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last name* i have a preferred name
- valueSource: fallback:first_real_option
- options: checkbox preferredcheck name--preferredcheck i have a preferred name legal name first name* last name* i have a preferred name
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### required_field_unfilled : commit_failed
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text off phonenumber--countryphonecode search country phone code* phone phone device type* select one country phone code* 1 item selected, canada (+1) canada (+1) phone number* pho
- valueSource: profile:phoneCountryCode
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### field_review_warning : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text preferredname--firstname name--preferredname--firstname first name* preferred name first name* last name*
- valueSource: derived:firstName
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### field_review_warning : Profile value derived from another saved field.
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text preferredname--lastname name--preferredname--lastname last name* preferred name first name* last name*
- valueSource: derived:lastName
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### required_field_unfilled : commit_failed
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text off phonenumber--countryphonecode search country phone code* phone phone device type* mobile country phone code* 1 item selected, canada (+1) canada (+1) phone number* phone e
- valueSource: profile:phoneCountryCode
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### required_field_unfilled : commit_failed
- count: 1
- firstSeen: 2026-05-19T01:47:16.490Z
- lastSeen: 2026-05-19T01:47:16.490Z
- job: https://cox.wd1.myworkdayjobs.com/Cox_External_Career_Site_1/job/Matteson-IL/Detail-Technician--Piece-_R202677318
- step: My Information -> My Information
- question: text off searchbox phonenumber--countryphonecode search country phone code* phone phone device type* mobile country phone code* minimized canada (+1) phone number* phone extension
- valueSource: profile:phoneCountryCode
- audits: C:\Users\sushi\Documents\Github\hunt\logs\c3_workday_audit_2026-05-19T01-46-52-171Z.json

### page_walk_stopped : already_on_auth_step
- count: 2
- firstSeen: 2026-05-19T00:48:01.139Z
- lastSeen: 2026-05-19T01:14:03.275Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step:  -> 
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_20260518.audit.json, C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_authcombine_20260518.audit.json

### v2_permanent_issue : Used catalog default because profile field was blank.
- count: 1
- firstSeen: 2026-05-19T01:14:03.275Z
- lastSeen: 2026-05-19T01:14:03.275Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step: Create Account/Sign In -> 
- question: checkbox createaccountcheckbox input-9 by creating an account, i consent to the thermo fisher scientific privacy notice.
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_authcombine_20260518.audit.json

### field_review_warning : Used catalog default because profile field was blank.
- count: 1
- firstSeen: 2026-05-19T01:14:03.275Z
- lastSeen: 2026-05-19T01:14:03.275Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step: Create Account/Sign In -> 
- question: checkbox createaccountcheckbox input-9 by creating an account, i consent to the thermo fisher scientific privacy notice.
- valueSource: default:terms_acceptance
- options: checkbox createaccountcheckbox input-9 by creating an account, i consent to the thermo fisher scientific privacy notice.
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_authcombine_20260518.audit.json

### manual_review_reason : page_walk:auth_action_did_not_advance
- count: 1
- firstSeen: 2026-05-19T01:14:03.275Z
- lastSeen: 2026-05-19T01:14:03.275Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step: Create Account/Sign In -> 
- question: page_walk:auth_action_did_not_advance
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_authcombine_20260518.audit.json

### final_visible_errors : final_page_reported_visible_errors
- count: 1
- firstSeen: 2026-05-19T01:14:03.275Z
- lastSeen: 2026-05-19T01:14:03.275Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step: Create Account/Sign In -> 
- question: Error: Please check the box to continue
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_authcombine_20260518.audit.json

### final_visible_errors : final_page_reported_visible_errors
- count: 1
- firstSeen: 2026-05-19T00:51:32.010Z
- lastSeen: 2026-05-19T00:51:32.010Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step: Create Account/Sign In -> 
- question: Verify your account before you sign in or request a verification email.
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_20260518.audit.json

### v2_permanent_issue : Used catalog default because profile field was blank.
- count: 1
- firstSeen: 2026-05-19T00:48:01.139Z
- lastSeen: 2026-05-19T00:48:01.139Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step: Create Account/Sign In -> 
- question: By creating an account, I consent to the Thermo Fisher Scientific Privacy Notice. By creating an account, I consent to the Thermo Fisher Scientific Privacy Notice. input-9 checkbox createaccountcheckbox input-9 by creating an account, i consent to the thermo fisher scientific privacy notice.
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_20260518.audit.json

### field_review_warning : Used catalog default because profile field was blank.
- count: 1
- firstSeen: 2026-05-19T00:48:01.139Z
- lastSeen: 2026-05-19T00:48:01.139Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step: Create Account/Sign In -> 
- question: By creating an account, I consent to the Thermo Fisher Scientific Privacy Notice. By creating an account, I consent to the Thermo Fisher Scientific Privacy Notice. input-9 checkbox
- valueSource: default:terms_acceptance
- options: checkbox createaccountcheckbox input-9 by creating an account, i consent to the thermo fisher scientific privacy notice.
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_20260518.audit.json

### manual_review_reason : page_walk:timeout
- count: 1
- firstSeen: 2026-05-19T00:48:01.139Z
- lastSeen: 2026-05-19T00:48:01.139Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step: Create Account/Sign In -> 
- question: page_walk:timeout
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_20260518.audit.json

### final_visible_errors : final_page_reported_visible_errors
- count: 1
- firstSeen: 2026-05-19T00:48:01.139Z
- lastSeen: 2026-05-19T00:48:01.139Z
- job: https://thermofisher.wd5.myworkdayjobs.com/ThermoFisherCareers/job/Shanghai-China/Sr-Manager--Finance_R-01353639-1
- step: Create Account/Sign In -> 
- question: An email has been sent to you. Please verify your account.
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_thermofisher_sr_manager_finance_r01353639_20260518.audit.json

### posting_not_found : posting_not_found
- count: 1
- firstSeen: 2026-05-19T00:44:16.072Z
- lastSeen: 2026-05-19T00:44:16.072Z
- job: https://lowes.wd5.myworkdayjobs.com/LWS_External_CS/job/Bengaluru/IND-Analyst-Digital-Chat-and-Agentic-Support_JR-02482775-1
- step:  -> 
- question: Workday says this job posting page does not exist.
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_lowes_analyst_digital_chat_agentic_support_jr02482775_notfound_20260518.audit.json

### manual_review_reason : page_walk:no_safe_next_button
- count: 1
- firstSeen: 2026-05-19T00:41:04.839Z
- lastSeen: 2026-05-19T00:41:04.839Z
- job: https://lowes.wd5.myworkdayjobs.com/LWS_External_CS/job/Bengaluru/IND-Analyst-Digital-Chat-and-Agentic-Support_JR-02482775-1
- step:  -> 
- question: page_walk:no_safe_next_button
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_lowes_analyst_digital_chat_agentic_support_jr02482775_20260518.audit.json

### no_safe_next_button : no_safe_next_button
- count: 1
- firstSeen: 2026-05-19T00:41:04.839Z
- lastSeen: 2026-05-19T00:41:04.839Z
- job: https://lowes.wd5.myworkdayjobs.com/LWS_External_CS/job/Bengaluru/IND-Analyst-Digital-Chat-and-Agentic-Support_JR-02482775-1
- step:  -> 
- question: No safe Next or Continue button was found.
- audits: C:\Users\sushi\Documents\Github\hunt\logs\live_lowes_analyst_digital_chat_agentic_support_jr02482775_20260518.audit.json

### unsupported_or_empty_option_set : No selectable option was available.
- count: 1
- firstSeen: 2026-05-19T00:35:36.658Z
- lastSeen: 2026-05-19T00:35:36.658Z
- job: https://amgen.wd1.myworkdayjobs.com/Careers/job/Germany---Munich-Research/Scientist--m-w-d----unbefristet_R-244770-1
- step: My Information -> Review
- question: Country / Territory* Canada Country / Territory*Canada country--country country Country / Territory Canada Required button country country--country country / territory canada requi
- valueSource: profile:country
- options: Country / Territory Canada Required Canada
- audits: logs\live_amgen_scientist_r244770_1_authwaitfix_20260518.audit.json

### unsupported_or_empty_option_set : No selectable option was available.
- count: 1
- firstSeen: 2026-05-19T00:35:36.658Z
- lastSeen: 2026-05-19T00:35:36.658Z
- job: https://amgen.wd1.myworkdayjobs.com/Careers/job/Germany---Munich-Research/Scientist--m-w-d----unbefristet_R-244770-1
- step: My Information -> Review
- question: Province or Territory Alberta Province or TerritoryAlberta address--countryRegion countryRegion Province or Territory Alberta button countryregion address--countryregion province o
- valueSource: profile:province
- options: Province or Territory Alberta Alberta
- audits: logs\live_amgen_scientist_r244770_1_authwaitfix_20260518.audit.json

### unsupported_or_empty_option_set : No selectable option was available.
- count: 1
- firstSeen: 2026-05-19T00:35:36.658Z
- lastSeen: 2026-05-19T00:35:36.658Z
- job: https://amgen.wd1.myworkdayjobs.com/Careers/job/Germany---Munich-Research/Scientist--m-w-d----unbefristet_R-244770-1
- step: My Information -> Review
- question: Phone Device Type* Mobile Phone Device Type*Mobile phoneNumber--phoneType phoneType Phone Device Type Mobile Required button phonetype phonenumber--phonetype phone device type mobi
- valueSource: profile:phoneDeviceType
- options: Phone Device Type Mobile Required Mobile
- audits: logs\live_amgen_scientist_r244770_1_authwaitfix_20260518.audit.json

