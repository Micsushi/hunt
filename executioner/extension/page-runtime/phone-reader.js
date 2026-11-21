export function createPhoneReader({ editable, norm }) {
  const phoneWidget = input => {
    if (!input.matches('input.iti__tel-input[data-intl-tel-input-id]')) return null;
    const group=input.closest('.iti'),id=input.getAttribute('data-intl-tel-input-id');
    if (!group || !/^\d+$/.test(id??'') || group.querySelectorAll('input.iti__tel-input').length!==1) return null;
    const buttons=[...group.querySelectorAll('button.iti__selected-country[type=button][role=combobox][aria-label="Selected country"]')];
    if (buttons.length!==1 || !editable(buttons[0])) return null;
    const button=buttons[0],menuId=button.getAttribute('aria-controls');
    if (menuId!==`iti-${id}__dropdown-content`) return null;
    const menus=[...input.getRootNode().querySelectorAll(`[id="${CSS.escape(menuId)}"]`)];
    if (menus.length!==1 || !group.contains(menus[0]) || menus[0].querySelectorAll('[role=listbox]').length!==1) return null;
    return {input,group,button,menu:menus[0]};
  };
  const phoneOptions = widget => [...widget.menu.querySelectorAll('.iti__country[role=option][data-country-code][data-dial-code]')]
    .filter(option=>option.getAttribute('aria-disabled')!=='true').map(element=>({element,
      code:element.getAttribute('data-country-code'),dial:element.getAttribute('data-dial-code'),
      name:element.querySelector('.iti__country-name')?.textContent?.trim()}));
  const phoneState = widget => {
    if (!widget.input.isConnected || !widget.group.isConnected || !widget.button.isConnected || !widget.menu.isConnected ||
        !widget.group.contains(widget.input) || !widget.group.contains(widget.button)) return null;
    const flags=[...widget.button.querySelectorAll('.iti__flag')],dials=[...widget.button.querySelectorAll('.iti__selected-dial-code')];
    if (flags.length!==1 || dials.length!==1) return null;
    const codes=[...flags[0].classList].filter(value=>/^iti__[a-z]{2}$/.test(value));
    const code=codes.length===1?codes[0].slice(5):'',dial=(dials[0].textContent??'').trim().replace(/^\+/,'');
    const options=phoneOptions(widget).filter(option=>option.code===code && option.dial===dial && norm(option.name)===norm(widget.button.title));
    return options.length===1 && /^[a-z]{2}$/.test(code) && /^\d+$/.test(dial)
      ? JSON.stringify({code,dial,number:widget.input.value}) : null;
  };
  return { phoneWidget, phoneOptions, phoneState };
}
