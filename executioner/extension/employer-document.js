// Only Hunt's worker can address this isolated-world receiver. An ordinary
// website can load public JS assets but cannot invoke this message channel.
if (!globalThis.__huntC3EmployerDocument) {
  globalThis.__huntC3EmployerDocument=true;
  chrome.runtime.onMessage.addListener((message,sender,reply)=>{
    if(message.action!=='employerDocument' || sender.id!==chrome.runtime.id ||
        sender.url!==chrome.runtime.getURL('background.js'))return;
    const selected=()=>location.href===message.expectedUrl && top.location.href===message.topUrl;
    try{if(!selected())return;}catch{return;}
    if(message.probe){
      // Keep existing chooser and background-rendering support when Chrome
      // permits it. A protected tab can still inspect ordinary form fields.
      const needsChooser=Array.from(document.querySelectorAll('input[type=file]')).some(input=>
        !input.getClientRects().length || !input.checkVisibility({opacityProperty:true,visibilityProperty:true}));
      // Observe the employer-owned iframe elements only. A hidden tracking
      // pixel is not an uninspected section of the application.
      const slots=[...document.querySelectorAll('iframe,frame')];
      const foreign=slots.filter(el=>!el.contentDocument).map(el=>{
        const box=el.getBoundingClientRect();
        const hidden=!el.checkVisibility({opacityProperty:true,visibilityProperty:true}) ||
          box.width===0 || box.height===0 || box.width<=1 && box.height<=1;
        return {src:el.src,hidden};
      });
      reply({ready:true,preferDebugger:document.hidden || !innerWidth || !innerHeight || needsChooser,
        hiddenSources:foreign.filter(row=>row.hidden && !foreign.some(other=>other.src===row.src && !other.hidden)).map(row=>row.src),
        allForeignHidden:slots.length===window.frames.length && foreign.length>0 && foreign.every(row=>row.hidden)});return;
    }
    const run=async()=>{
      const {runEmployerAction}=await import(chrome.runtime.getURL('page-runtime/employer-action.js'));
      if(!selected() || Date.now()>=message.input.expiresAt)throw new Error();
      return runEmployerAction(message.input);
    };
    run().then(result=>reply({result}),()=>reply({failed:true}));
    return true;
  });
}
