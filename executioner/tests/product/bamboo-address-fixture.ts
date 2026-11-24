export const bambooAddressForm = `<!doctype html><title>Fixture engineer</title>
<h1>Fixture engineer</h1><form id="job-application-form">
  <label>First name <input name="firstName.value" required></label>
  <label>Email <input type="email" name="email.value" required></label>
  <label>Street Address <input name="streetAddress.value" value="Owner street"></label>
  <label>City <input name="city.value" value="Owner city"></label>
  <div id="country"></div><div id="region"></div>
  <label><span id="postal-label">ZIP</span> <input name="zip.value" autocomplete="postal-code"></label>
  <button type="submit">Submit application</button>
</form>
<script>
  const form = document.querySelector('form');
  form.dataset.submissions = '0';
  form.onsubmit = event => { event.preventDefault(); form.dataset.submissions++; };
  const countries = [['1', 'United States'], ['2', 'Canada']];
  const us = [['10', 'Alabama'], ['11', 'Colorado']];
  const ca = [['20', 'Alberta'], ['21', 'Ontario']];
  let generation = 0;
  function widget(holder, label, name, options, initial, onChange) {
    const id = 'field-' + ++generation, menuId = 'menu-' + generation;
    holder.innerHTML = '<label for="' + id + '">' + label + ' *</label>' +
      '<div class="fab-Select" data-fabric-component="Select">' +
      '<select tabindex="-1" readonly aria-hidden="true" hidden required id="' + id + '" name="' + name + '"></select>' +
      '<button type="button" aria-required="true" aria-expanded="false" class="fab-SelectToggle" data-menu-id="' + menuId + '"></button>' +
      '<button type="button" class="fab-SelectToggle__clearButton" aria-label="Clear Selection">Clear</button></div>';
    const select = holder.querySelector('select'), [toggle, clear] = holder.querySelectorAll('button');
    select.add(new Option('', ''));
    for (const [value, text] of options) select.add(new Option(text, value));
    function render(value) {
      select.value = value;
      const text = select.selectedOptions[0].text;
      toggle.setAttribute('aria-label', label + ' ' + (text || '–Select–'));
      toggle.innerHTML = text ? '<span class="fab-SelectToggle__content">' + text + '</span>' : '<span class="fab-SelectToggle__placeholder">–Select–</span>';
      clear.hidden = !value;
    }
    function choose(value) {
      document.getElementById(menuId)?.remove();
      toggle.setAttribute('aria-expanded', 'false');
      render(value);
      if (onChange) onChange(value);
    }
    render(initial);
    clear.onclick = () => choose('');
    toggle.onclick = () => {
      const opened = document.getElementById(menuId);
      if (opened) { opened.remove(); toggle.setAttribute('aria-expanded', 'false'); return; }
      const menu = document.createElement('div');
      menu.id = menuId; menu.setAttribute('role', 'menu');
      for (const [value, text] of options) {
        const item = document.createElement('button');
        item.type = 'button'; item.setAttribute('role', 'menuitem'); item.textContent = text;
        item.onclick = () => choose(value);
        menu.append(item);
      }
      holder.append(menu);
      toggle.setAttribute('aria-expanded', 'true');
    };
  }
  function region(value) {
    const canada = value === '2';
    widget(document.getElementById('region'), canada ? 'Province' : 'State', 'state.value', canada ? ca : us, '');
    document.getElementById('postal-label').textContent = canada ? 'Postal Code' : 'ZIP';
  }
  widget(document.getElementById('country'), 'Country', 'countryId.value', countries, '1', value => setTimeout(() => region(value), 35));
  region('1');
</script>`;
