export function createLegacyAnswerReader({
  facts, norm
}) {
  const choiceAliases = {
    'will you now or in the future require sponsorship?': 'sponsorship_required',
    'do you require employment sponsorship now or in the future?': 'sponsorship_required',
    'how did you hear about us?': 'application_source',
  };
  const aliases = {
    'first name': 'given_name', 'given name': 'given_name', 'legal first name': 'given_name', 'prénom': 'given_name',
    'last name': 'family_name', 'family name': 'family_name', 'legal last name': 'family_name', 'nom de famille': 'family_name',
    'preferred name': 'preferred_name', 'preferred first name':'preferred_name', 'email': 'email_address', 'email address': 'email_address', 'e-mail': 'email_address', 'adresse e-mail': 'email_address',
    'phone': 'phone_number', 'phone number': 'phone_number', 'phone number?': 'phone_number', 'mobile phone': 'phone_number', 'téléphone': 'phone_number',
    'adresse courriel / email': 'email_address', 'numéro de téléphone / phone number': 'phone_number',
    'city': 'city', 'ville': 'city', 'postal code': 'postal_code', 'zip code': 'postal_code', 'code postal': 'postal_code',
    'country': 'country', 'pays': 'country', 'state': 'region', 'province': 'region', 'state/province': 'region',
    'current company': 'current_company', 'current title': 'current_title',
    'linkedin link':'linkedin_url', 'linkedin': 'linkedin_url', 'linkedin profile': 'linkedin_url', 'linkedin profile url': 'linkedin_url', 'linkedin url': 'linkedin_url',
    'github': 'github_url', 'github profile': 'github_url', 'github url': 'github_url', 'github profile url': 'github_url',
    'portfolio': 'portfolio_url', 'portfolio url': 'portfolio_url', 'portfolio website': 'portfolio_url',
    'website, blog or portfolio':'portfolio_url', 'website':'portfolio_url', 'confirm your email':'email_address',
    'address': 'address_line1', 'street address': 'address_line1', 'address line 1': 'address_line1', 'address line 2': 'address_line2',
    'when are you looking to start?': 'earliest_start_date', 'when are you available to start?': 'earliest_start_date',
    'earliest start date': 'earliest_start_date', 'available start date': 'earliest_start_date',
    'date available':'earliest_start_date', 'desired pay':'salary_expectations', 'desired salary':'salary_expectations',
    'what salary range are you targeting?': 'salary_expectations', 'salary expectations': 'salary_expectations',
    'what would be your salary expectations for the position?':'salary_expectations',
  };
  const fact = id => facts.find(f => f.factId === id)?.value;
  const canadaEligibility = label => {
    if (norm(label)!=='are you legally eligible to work in canada without sponsorship?') return undefined;
    const authorized=fact('work_authorization_canada'),sponsorship=fact('sponsorship_required_canada');
    return typeof authorized==='boolean' && typeof sponsorship==='boolean' ? authorized && !sponsorship : undefined;
  };
  const answer = label => {
    const key = norm(label);
    const eligible=canadaEligibility(label);
    if (eligible!==undefined) return eligible?'Yes':'No';
    if (key==='where are you located?') {
      const parts=['city','region','country'].map(fact);
      return parts.every(value=>typeof value==='string' && value.trim()) ? parts.join(', ') : undefined;
    }
    if (/^(full name|legal name|full legal name|name|first (?:&|and) last name|legal first and last name|nom complet|nom complet \/ name)$/.test(key)) {
      return typeof fact('given_name') === 'string' && typeof fact('family_name') === 'string' ? `${fact('given_name')} ${fact('family_name')}` : undefined;
    }
    if (key === 'full address') {
      const required = ['address_line1', 'city', 'region', 'postal_code', 'country'].map(fact);
      if (required.some(value => typeof value !== 'string' || !value.trim())) return undefined;
      const [street, city, region, postal, country] = required;
      return [street, fact('address_line2'), city, `${region} ${postal}`, country].filter(Boolean).join(', ');
    }
    return fact(aliases[key]);
  };
  return { choiceAliases, fact, canadaEligibility, answer };
}
