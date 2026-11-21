export function createCompositeControlActions({
  phoneState, phoneOptions, changeEditable, checkDeadline, visible, editable, write
}) {
  const selectPhone = async (change,value,rollback=true) => {
    const widget=change.phoneCountry,before=phoneState(widget),target=JSON.parse(value);
    if (!before || !changeEditable(widget.input,change)) throw new Error('The phone country control changed. Check the form.');
    const original=JSON.parse(before);
    let owned=before,opened=false;
    try {
      if (original.code!==target.code || original.dial!==target.dial) {
        const options=phoneOptions(widget).filter(option=>option.code===target.code && option.dial===target.dial);
        if (options.length!==1 || widget.button.getAttribute('aria-expanded')==='true') throw new Error('The phone country cannot be changed reversibly.');
        checkDeadline();widget.button.click();opened=true;await new Promise(resolve=>setTimeout(resolve,100));
        if (!changeEditable(widget.input,change) || phoneState(widget)!==owned || !visible(widget.menu) || !visible(options[0].element)) throw new Error('The phone country menu or number changed.');
        owned=JSON.stringify({code:target.code,dial:target.dial,number:original.number});
        checkDeadline();options[0].element.click();opened=false;await new Promise(resolve=>setTimeout(resolve,100));
        if (phoneState(widget)!==owned) throw new Error('The phone or country changed during selection. Your edits were preserved.');
      }
      if (phoneState(widget)!==owned) throw new Error('The phone or country changed. Your edits were preserved.');
      checkDeadline();const priorToNumber=owned;write(widget.input,target.number);
      const immediate=phoneState(widget);owned=immediate===priorToNumber ? priorToNumber : value;
      await new Promise(resolve=>setTimeout(resolve,100));
      if (phoneState(widget)!==value || value===change.after && (!widget.input.validity.valid || widget.input.getAttribute('aria-invalid')==='true')) throw new Error('The website did not keep the phone and country together.');
    } catch (error) {
      const current=phoneState(widget);
      if (opened && current===owned && widget.button.getAttribute('aria-expanded')==='true' && editable(widget.button)) widget.button.click();
      if (rollback && current===owned && current!==before) {
        await selectPhone(change,before,false).catch(()=>{});
      }
      throw error;
    }
  };
  return { selectPhone };
}
