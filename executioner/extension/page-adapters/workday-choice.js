export function createSearchChoiceReader(regionFor) {
  const sharedChoice = e => {
    const recognized=e.matches?.('input[data-uxi-widget-type="selectinput"]');
    try {
      const result=globalThis.__huntC3ChoiceWidget?.(e);
      if(result)return result;
    }catch {}
    return recognized?{kind:'owned_search_choice',valid:false,reason:'choice_inspector_unavailable',input:e,query:e.value,labels:[],pills:[],options:[],popupStatus:'ambiguous',empty:false}:null;
  };
  const boundChoice = change => {
    const original=change.choiceWidget;
    if(!original?.widget?.isConnected || !original.owner?.isConnected)return null;
    const inputs=[...original.widget.querySelectorAll('input[data-uxi-widget-type="selectinput"]')].filter(input=>input.getAttribute('data-uxi-multiselect-id')===original.widgetId);
    const current=inputs.length===1?sharedChoice(inputs[0]):null;
    return current?.valid && current.widget===original.widget && current.owner===original.owner && current.widgetId===original.widgetId && regionFor(current.input)===change.region?current:null;
  };
  const candidates = region => [...region.querySelectorAll('input[data-uxi-widget-type=selectinput]')];
  return {sharedChoice, boundChoice, candidates};
}
