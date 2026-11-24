/** Shared exact identity aliases; never infer an answer from an unrelated question. */
export function profileFieldValue(label: string, facts: readonly {factId:string;value:unknown}[]) {
  const key=label.normalize('NFKC').toLowerCase().replace(/[✱*]/g,'').replace(/\s+/g,' ').replace(/[:：]\s*$/,'').trim();
  const fact=(id:string)=>facts.find(f=>f.factId===id)?.value;
  if (/^(?:what is your current address\??|full address)$/.test(key)) {
    const [street,unit,city,region,postal,country] = ['address_line1','address_line2','city','region','postal_code','country'].map(fact);
    if ([street,city,region,postal,country].every(value=>typeof value==='string' && value.trim())) {
      return [street,unit,city,`${region} ${postal}`,country].filter(value=>typeof value==='string' && value.trim()).join(', ');
    }
    return undefined;
  }
  if (/^(full name|legal name|full legal name|name|first (?:&|and) last name|first and last names|legal first and last name|nom complet|nom complet \/ name)$/.test(key)) {
    const first=fact('given_name'),last=fact('family_name');
    return typeof first==='string'&&typeof last==='string'?`${first} ${last}`:undefined;
  }
  if(key==='where are you located?') {const parts=['city','region','country'].map(fact);return parts.every(value=>typeof value==='string' && value.trim())?parts.join(', '):undefined;}
  const ids:Record<string,string>={'first name':'given_name','given name':'given_name','prénom':'given_name','last name':'family_name','family name':'family_name','nom de famille':'family_name','legal first name':'given_name','legal last name':'family_name','email':'email_address','email address':'email_address','e-mail':'email_address','adresse e-mail':'email_address','phone':'phone_number','phone number':'phone_number','phone number?':'phone_number','mobile phone':'phone_number','téléphone':'phone_number','telephone':'phone_number','telephone number':'phone_number','mobile number':'phone_number','city':'city','current location':'current_location','location':'current_location','postal code':'postal_code','zip code':'postal_code','current company':'current_company','current title':'current_title','preferred name':'preferred_name'};
  for (const key of ['linkedin','linkedin url','linkedin profile','linkedin profile url']) ids[key]='linkedin_url';
  for (const key of ['github','github url','github profile','github profile url']) ids[key]='github_url';
  for (const key of ['portfolio','portfolio url','portfolio website','personal website']) ids[key]='portfolio_url';
  ids['adresse courriel / email']='email_address';
  for (const label of ['zip','zip / postal code','zip/postal code']) ids[label]='postal_code';
  ids['numéro de téléphone / phone number']='phone_number';
  Object.assign(ids,{'preferred first name':'preferred_name','ville':'city','code postal':'postal_code','linkedin link':'linkedin_url','website, blog or portfolio':'portfolio_url','website':'portfolio_url','confirm your email':'email_address','address':'address_line1'});
  Object.assign(ids,{'street address':'address_line1','address line 1':'address_line1','address 1':'address_line1','address line 2':'address_line2',
    country:'country',pays:'country',state:'region',province:'region','state/province':'region',region:'region'});
  const value=fact(ids[key]??'');
  return typeof value==='string'?value:undefined;
}
