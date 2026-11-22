const normalizeCatalogText = (value:string) => value.normalize('NFKC').toLowerCase().replace(/[\p{P}\p{S}]+/gu,' ').replace(/\s+/gu,' ').trim();

// Equivalent labels are scoped to a fact, never learned from a live attempt.
const groups: Readonly<Record<string,readonly (readonly string[])[]>> = {
  gender_disclosure: [['male','man'],['female','woman'],['nonbinary','non binary']],
  education_field_of_study: [['computer science','computer and information science']],
  education_degree: [['bachelor of science','bachelor of science bs','bsc','b sc','bs','b s'],['bachelor of arts','ba','b a'],['master of science','msc','m sc','ms','m s'],['doctor of philosophy','phd','ph d']],
  phone_device_type: [['mobile','cell','cellular','mobile phone','cell phone']],
  application_source: [['linkedin','linkedin corporate page','linkedin job posting'],['recruiter','recruiter outreach']],
};
const factAliases: Readonly<Record<string,string>> = {
  's1-question-country':'country',
  'owner-question-phone-country-code':'phone_country_code','owner-question-current-location':'current_location',
  'education.degree':'education_degree','education.field_of_study':'education_field_of_study',
  'phone.device_type':'phone_device_type','source.how_did_you_hear':'application_source',
  'workday-question-gender-disclosure':'gender_disclosure','owner-question-education-degree':'education_degree',
  'owner-question-education-field-of-study':'education_field_of_study','workday-placeholder-application-source':'application_source',
};
export function answerEquivalents(value:string, context:string): readonly string[] {
  const normalized=normalizeCatalogText(value);
  return groups[factAliases[context]??context]?.find(group=>group.includes(normalized))??[normalized];
}
const canadianRegions=[['ab','alberta'],['bc','british columbia'],['mb','manitoba'],['nb','new brunswick'],['nl','newfoundland and labrador'],['ns','nova scotia'],['nt','northwest territories'],['nu','nunavut'],['on','ontario'],['pe','prince edward island'],['qc','quebec'],['sk','saskatchewan'],['yt','yukon']];
function dialCountry(value:string) {
  const dial=value.match(/\+(\d{1,3})\b/);if(!dial)return undefined;
  const rest=value.replace(dial[0],'').replace(/[()]/g,'').trim().replace(/^[A-Z]{2}\s*[-–]\s*/, '').trim();
  const country=normalizeCatalogText(rest);return country?{dial:dial[1],country}:undefined;
}
export function phoneCountryName(value:string) { return dialCountry(value)?.country; }
export function equivalentAnswer(actual:string, expected:string, context:string): boolean {
  const fact=factAliases[context]??context;
  if (fact === 'country') {
    const a = dialCountry(actual), b = dialCountry(expected);
    if (a && b) return a.country === b.country && a.dial === b.dial;
    if (a) return a.country === normalizeCatalogText(expected);
    if (b) return b.country === normalizeCatalogText(actual);
  }
  if(fact==='phone_country_code') {
    const a=dialCountry(actual),b=dialCountry(expected);
    if(a && b)return a.dial===b.dial && a.country===b.country;
  }
  if(fact==='current_location') {
    const parts=(text:string)=>text.split(',').map(normalizeCatalogText);
    const a=parts(actual),b=parts(expected);
    const region=(value:string)=>canadianRegions.find(group=>group.includes(value))?.[1]??value;
    if(a.length===2 && b.length===2 && a.every(Boolean) && b.every(Boolean))return a[0]===b[0] && region(a[1]!)===region(b[1]!);
  }
  return answerEquivalents(expected,context).includes(normalizeCatalogText(actual));
}
export function matchesDegreeLevel(observed: string, requested: string): true | undefined {
  if (observed === requested) return true;
  // A degree-level menu can represent a specific bachelor's credential without
  // claiming a different discipline, such as Bachelor of Arts for Science.
  const bachelorLevel = /^bachelor(?:['’]s|s)?(?:\s*\/\s*undergraduate)?(?:\s+degree)?(?:\s*\([±]?\s*\d+\s+years?\))?$/u;
  const bachelorCredential = /^(?:bachelor of (?:science|arts|engineering|commerce|business administration)|b\.?\s?s\.?|bsc|b\.?\s?a\.?|beng)$/u;
  const described = /^([^()]+) \([34](?:\s*[-–]\s*[45])? years? degree equivalent,? e\.g\.,? ([^()]{1,100})\)$/u.exec(observed);
  if (described && bachelorLevel.test(described[1]!)) {
    const examples = described[2]!.replace(/,\s*etc\.?$/u, "").split(",").map(label => label.trim());
    // A catalog listing explicit programs is usable only for a compatible credential.
    if (examples.every(example => /^(?:ba|bs|bsc|beng|bba|bcom|llb)$/u.test(example)) &&
        (bachelorLevel.test(requested) || examples.some(example => equivalentAnswer(example, requested, "education.degree")))) return true;
    return undefined;
  }
  return bachelorLevel.test(observed) &&
    (bachelorLevel.test(requested) || answerEquivalents(requested, "education.degree").some(value => bachelorCredential.test(value))) ? true : undefined;
}

export function answerDictionary() { return groups; }
