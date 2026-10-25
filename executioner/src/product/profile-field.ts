/** Shared exact identity aliases; never infer an answer from an unrelated question. */
export function profileFieldValue(label: string, facts: readonly {factId:string;value:unknown}[]) {
  const key=label.normalize('NFKC').toLowerCase().replace(/[✱*]/g,'').replace(/\s+/g,' ').trim();
  const fact=(id:string)=>facts.find(f=>f.factId===id)?.value;
  if (/^(full name|name|first (?:&|and) last name|first and last names)$/.test(key)) {
    const first=fact('given_name'),last=fact('family_name');
    return typeof first==='string'&&typeof last==='string'?`${first} ${last}`:undefined;
  }
  const ids:Record<string,string>={'first name':'given_name','given name':'given_name','last name':'family_name','family name':'family_name','email':'email_address','email address':'email_address','e-mail':'email_address','phone':'phone_number','phone number':'phone_number','mobile phone':'phone_number','city':'city','current location':'city','postal code':'postal_code','zip code':'postal_code','current company':'current_company','current title':'current_title','preferred name':'preferred_name'};
  const value=fact(ids[key]??'');
  return typeof value==='string'?value:undefined;
}
