// BambooHR changes both the regional menu and postal field when Country changes.
// Resolve those controls again after each change, including during Undo and Redo.
export function createBambooAddress({fabricWidget, fabricState, fabricMenu, fabricClear, editable, write, checkDeadline, norm}) {
  if (window !== window.top || !location.hostname.endsWith('.bamboohr.com') || !/^\/careers\/\d+\/?$/.test(location.pathname)) return null;
  const forms = document.querySelectorAll('form#job-application-form');
  if (forms.length !== 1 || forms[0].querySelector('input[type=password]')) return null;
  const form = forms[0], url = location.href;
  const current = () => form.isConnected && location.href === url && document.querySelector('form#job-application-form') === form;
  const widget = name => {
    if (!current()) return null;
    const controls = form.querySelectorAll(`select[name="${name}.value"]`);
    if (controls.length !== 1) return null;
    const button = controls[0].closest('.fab-Select')?.querySelector('button.fab-SelectToggle');
    const menu = button && editable(button) && fabricWidget(button);
    return menu?.backing === controls[0] && menu.region === form ? menu : null;
  };
  const choice = menu => menu && JSON.parse(fabricState(menu));
  const postal = () => {
    const fields = form.querySelectorAll('input[name="zip.value"]');
    return fields.length === 1 && fields[0].type === 'text' && fields[0].form === form && editable(fields[0]) ? fields[0] : null;
  };
  const regionName = country => country === 'Canada' ? 'Province' : country === 'United States' ? 'State' : null;
  const read = () => {
    const country = choice(widget('countryId')), menu = widget('state'), region = choice(menu), field = postal();
    if (!country || !region || !field || !regionName(country.label) || menu.label !== regionName(country.label)) return null;
    const expected = country.label === 'Canada' ? 'postal code' : 'zip';
    if (field.labels.length !== 1 || norm(field.labels[0].textContent) !== expected) return null;
    return {country, region, postal:field.value};
  };
  const same = (a,b) => a?.label === b.label && (b.value === undefined || a.value === b.value);
  const matches = (a,b) => !!a && same(a.country,b.country) && same(a.region,b.region) && a.postal === b.postal;
  const wait = async test => {
    const end = Date.now() + 2200;
    do {
      checkDeadline();
      if (!current()) throw new Error('The BambooHR application changed.');
      const value = test();
      if (value) return value;
      await new Promise(resolve => setTimeout(resolve,40));
    } while (Date.now() < end);
    throw new Error('BambooHR did not confirm the address change.');
  };
  const select = async (name,target,guard) => {
    const menu = widget(name);
    if (!menu || !guard()) throw new Error('The BambooHR address changed during the action.');
    if (same(choice(menu),target)) return;
    if (target.label) {
      const options = await fabricMenu(menu,true);
      const matches = options.filter(option => option.textContent.trim() === target.label);
      if (matches.length !== 1 || !guard()) {
        if (menu.input.getAttribute('aria-expanded') === 'true') menu.input.dispatchEvent(new MouseEvent('click',{bubbles:true,detail:1}));
        throw new Error('BambooHR did not offer the expected address choice.');
      }
      checkDeadline(); matches[0].click();
    } else {
      const clear = fabricClear(menu);
      if (!clear) throw new Error('BambooHR did not offer to clear the regional choice.');
      checkDeadline(); clear.click();
    }
    await wait(() => same(choice(widget(name)),target));
  };
  const transition = async (before,target) => {
    const safePostal = value => value === before.postal || value === '';
    await select('countryId',target.country,() => matches(read(),before));
    const switched = await wait(() => {
      const value = read();
      return value && same(value.country,target.country) && value;
    });
    if (!safePostal(switched.postal) || switched.region.label && !same(switched.region,target.region)) {
      throw new Error('The BambooHR address changed during the action.');
    }
    await select('state',target.region,() => matches(read(),switched));
    const confirmed = read();
    if (!confirmed || !same(confirmed.country,target.country) || !same(confirmed.region,target.region) || !safePostal(confirmed.postal))
      throw new Error('The BambooHR address changed during the action.');
    if (confirmed.postal !== target.postal) write(postal(),target.postal);
    await new Promise(resolve => setTimeout(resolve,120));
    const after = read();
    const accepted = name => {
      const menu = widget(name);
      return menu && menu.backing.validity.valid && menu.input.getAttribute('aria-invalid') !== 'true' && menu.input.getAttribute('aria-expanded') !== 'true';
    };
    if (!matches(after,target) || target.country.label === 'Canada' && (!accepted('countryId') || !accepted('state') ||
      !postal().validity.valid || postal().getAttribute('aria-invalid') === 'true')) throw new Error('BambooHR did not retain the province and postal code.');
    return after;
  };
  const apply = async (before,target) => {
    if (!matches(read(),before)) throw new Error('Fields changed since C3 filled them. Your edits were preserved.');
    try { return await transition(before,target); }
    catch (error) {
      if (matches(read(),before)) throw error;
      let now = read();
      if (!now && same(choice(widget('countryId')),target.country)) {
        // The dependent Province/State menu may never mount. Revert the country
        // only while the old dependent data (or BambooHR's reset) is still visible.
        const safe = () => {
          const region = choice(widget('state')), zip = postal()?.value;
          return same(choice(widget('countryId')),target.country) && (!region?.label || same(region,before.region)) &&
            (zip === undefined || zip === '' || zip === before.postal);
        };
        if (safe()) {
          await select('countryId',before.country,safe);
          await new Promise(resolve => setTimeout(resolve,120));
          now = await wait(read);
          if (matches(now,before)) throw error;
          if ((!now.region.label || same(now.region,before.region)) && ['',before.postal].includes(now.postal)) {
            await transition(now,before);
            throw error;
          }
        }
      }
      // Only reverse values the change could have written. A new owner edit wins.
      if (now && same(now.country,target.country) && (!now.region.label || same(now.region,target.region)) &&
          [before.postal,'',target.postal].includes(now.postal)) {
        try { await transition(now,before); }
        catch { throw new Error('BambooHR could not restore the original address. Review the address on the page.'); }
        throw error;
      }
      throw new Error('BambooHR could not confirm the original address. Review the address on the page.');
    }
  };
  const conflict = country => norm(country) === 'canada' && choice(widget('countryId'))?.label === 'United States';
  const protectedControl = e => form.contains(e) && (e.matches('[name="countryId.value"],[name="state.value"],[name="zip.value"],[name="streetAddress.value"],[name="address1.value"],[name="address2.value"],[name="city.value"]') ||
    !!e.closest('.fab-Select')?.querySelector('select[name="countryId.value"],select[name="state.value"]'));
  return {form, url, conflict, protectedControl, read, apply};
}

export function createProvinceMenu({regionFor, norm, visible, editable, checkDeadline, deepQuery}) {
  const valueOf = e => e.getAttribute('aria-label') ?? '';
  const provinceContext = e => {
    const region=regionFor(e),container=e.parentElement;
    if (!location.hostname.endsWith('.bamboohr.com') || !region.matches?.('form#job-application-form') ||
        !e.matches('button.fab-SelectToggle[type=button][data-menu-id][aria-label^="Province "]') ||
        !container?.matches('.fab-SelectToggle__container') ||
        container.querySelectorAll('button.fab-SelectToggle[aria-label^="Province "]').length!==1) return null;
    const countries=[...region.querySelectorAll('button.fab-SelectToggle[aria-label="Country Canada"]')].filter(visible);
    if (countries.length!==1) return null;
    const contents=[...e.querySelectorAll('.fab-SelectToggle__content')];
    if (valueOf(e)!=='Province –Select–' && (contents.length!==1 || norm(contents[0].textContent)!==norm(valueOf(e).slice(9)))) return null;
    return {region,container,country:countries[0]};
  };
  const sameContext = (e,expected) => {
    const current=provinceContext(e);
    return !!current && current.region===expected?.region && current.container===expected?.container && current.country===expected?.country;
  };
  const clearSelection = e => {
    if (!provinceContext(e)) return null;
    const matches = [...e.parentElement.querySelectorAll('button.fab-SelectToggle__clearButton[type=button][aria-label="Clear Selection"]')];
    return matches.length === 1 && editable(matches[0]) ? matches[0] : null;
  };
  // The document can outlive an extension reload or rollback. Keep the existing history key.
  const savedContext = change => change.bambooProvince;
  const selectProvince = async (change, value) => {
    const e=change.element,context=savedContext(change),before=valueOf(e);
    // Fabric ignores the zero-detail click generated by HTMLElement.click().
    const toggle = () => e.dispatchEvent(new MouseEvent('click',{bubbles:true,cancelable:true,view:window,detail:1}));
    if (!(editable(e) && sameContext(e,context))) throw new Error('The province control changed. Check the form.');
    if (valueOf(e) === value) return;
    if (value === 'Province –Select–') {
      const clear = clearSelection(e);
      if (!clear) throw new Error('The website no longer exposes the province reset.');
      checkDeadline();clear.click();
    } else {
      if (e.getAttribute('aria-expanded') === 'true') throw new Error('Close the province menu before retrying.');
      const id=e.getAttribute('data-menu-id'),controls=e.getAttribute('aria-controls');
      if (!id || controls && controls!==id) throw new Error('The province menu binding changed.');
      checkDeadline();toggle();
      const menuStarted=Date.now();let options=[];
      do {
        await new Promise(resolve => setTimeout(resolve, 50));checkDeadline();
        if (!sameContext(e,context) || !editable(e) || valueOf(e)!==before || e.getAttribute('data-menu-id')!==id) throw new Error('The province changed while its menu opened. Your edits were preserved.');
        const menus=[...e.getRootNode().querySelectorAll(`[id="${CSS.escape(id)}"]`)];
        if (menus.length>1) break;
        const menu=menus.length===1?menus[0]:null;
        options = menu?.getAttribute('role') === 'menu' && visible(menu) ? [...menu.querySelectorAll('[role=menuitem]')].filter(option =>
          visible(option) && option.getAttribute('aria-disabled') !== 'true' && norm(option.textContent) === norm(value.slice('Province '.length))
        ) : [];
      } while (!options.length && Date.now()-menuStarted<2000);
      if (options.length !== 1) {
        if (e.getAttribute('aria-expanded') === 'true' && valueOf(e)===before && sameContext(e,context)) toggle();
        throw new Error('The saved province is not uniquely available.');
      }
      checkDeadline();
      options[0].click();
    }
    await new Promise(resolve => setTimeout(resolve, 100));
    if (!(editable(e) && sameContext(e,context)) || valueOf(e) !== value || (value !== 'Province –Select–' && !clearSelection(e))) {
      throw new Error('The website did not verify the province choice and reset.');
    }
  };
  const reconcile = async ({fact, matchingPlans, scope, applicationRegions, fabricWidget, observe, reportMatch, isRequired, result, addSkip, changes}) => {
    const savedProvince = fact('region');
    if (matchingPlans !== undefined || typeof savedProvince === 'string' && norm(fact('country')) === 'canada') {
      const province = deepQuery(document,'button.fab-SelectToggle[data-menu-id][aria-label^="Province "]')
        .filter(e => !fabricWidget(e) && editable(e) && provinceContext(e) &&
          (scope === 'page' || applicationRegions.includes(regionFor(e))) && !deepQuery(regionFor(e),'input[type=password]').some(visible));
      if (province.length === 1) {
        const e = province[0], before = valueOf(e), context = provinceContext(e);
        const row = observe(e, 'Province');
        const plan = matchingPlans?.find(candidate => candidate.fieldId === row.fieldId);
        const answer = matchingPlans === undefined ? savedProvince : plan?.answer;
        const after = `Province ${answer}`;
        const record = (outcome, reason) => {
          if (plan) reportMatch(row, plan, outcome, reason, valueOf(e));
        };
        if (!isRequired(e)) result.skipped.push({label:'Province',reason:'optional_field'});
        else if (matchingPlans !== undefined && (!plan || plan.signature !== row.signature)) {
          if (plan) addSkip(row.question, 'field_changed_before_fill', 'field_recognition', 'rebind_field', row.fieldId);
          reportMatch(row, plan, 'observed', 'field_changed_or_new');
        }
        else if (!context || typeof answer !== 'string' || !answer.trim()) {
          addSkip('Province', 'choice_requires_mapping', 'answer_matching', 'match_province');
          record('unconfirmed', 'choice_requires_mapping');
        }
        else if (before === 'Province –Select–') {
          const change={element:e,region:context.region,before,after,label:'Province',bambooProvince:context};
          checkDeadline();
          try {
            await selectProvince(change, after);
            changes.push(change);
            result.filled.push('Province');
            record('verified', 'product_readback_confirmed');
          } catch (error) {
            if (sameContext(e,context) && valueOf(e) === after && clearSelection(e)) await selectProvince(change, before).catch(()=>{});
            const reason=error instanceof Error ? ({
              'The province control changed. Check the form.':'province_control_changed',
              'The province menu binding changed.':'province_menu_binding_changed',
              'The province changed while its menu opened. Your edits were preserved.':'province_menu_open_changed',
              'The saved province is not uniquely available.':'province_option_not_unique',
              'The website did not verify the province choice and reset.':'province_selection_not_verified',
            })[error.message] : undefined;
            const failure = valueOf(e) === before ? reason ?? 'value_not_accepted' : 'province_change_requires_review';
            addSkip('Province', failure, 'browser_interaction', 'verify_selection');
            record('unconfirmed', failure);
          }
        } else if (norm(before) !== norm(after)) {
          result.skipped.push({label:'Province',reason:'saved_value_conflict'});
          record('unconfirmed', 'saved_value_conflict');
        } else record('verified', 'existing_value_confirmed');
      }
    }
  };
  return {context:provinceContext, savedContext, same:sameContext, value:valueOf, select:selectProvince, reconcile};
}
