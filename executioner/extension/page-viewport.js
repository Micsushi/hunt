export const viewportUnavailable = 'This tab has no usable page area. Resize or restore its browser window, then retry.';
export const viewportCleanupPending = "Hunt could not restore this tab's page settings. Retry the job or page action to finish cleanup before filling.";

export function viewportOwnership(targetId,storage=chrome.storage.local) {
  if (typeof targetId!=='string' || !targetId) throw new Error(viewportCleanupPending);
  const key=`c3ViewportOverride:${targetId}`,renderingKey=`c3RenderingOverride:${targetId}`;
  return {
    has:async()=>!!(await storage.get(key))[key],
    claim:async()=>{await storage.set({[key]:true});},
    release:async()=>{await storage.remove(key);},
    rendering:{has:async()=>!!(await storage.get(renderingKey))[renderingKey],claim:async()=>{await storage.set({[renderingKey]:true});},release:async()=>{await storage.remove(renderingKey);}},
  };
}

/** Temporarily prepare only the owned page renderer; never activate its tab or window. */
export async function preparePageViewport(send,ownership) {
  let owned=false,renderingOwned=false,framesOwned=false,framesUncertain=false;
  const rendering=ownership?.rendering;
  const restore=async()=>{
    let failed=false;
    if(renderingOwned) {
      try {
        if(framesOwned) {await send('Page.stopScreencast');framesOwned=false;}
        await send('Emulation.setFocusEmulationEnabled',{enabled:false});
        if(framesUncertain)throw new Error(viewportCleanupPending);
        await rendering.release();renderingOwned=false;
      }
      catch {failed=true;}
    }
    if(owned) {
      try {await send('Emulation.clearDeviceMetricsOverride');await ownership?.release();owned=false;}
      catch {failed=true;}
    }
    if(failed)throw new Error(viewportCleanupPending);
  };
  const visibility=async()=> {
    const response=await send('Runtime.evaluate',{expression:'document.visibilityState',returnByValue:true});
    const state=response?.result?.value;
    if(response?.exceptionDetails || !['hidden','visible'].includes(state))throw new Error(viewportUnavailable);
    return state;
  };
  const prepareRendering=async()=> {
    if(!rendering || await visibility()==='visible')return restore;
    // Hidden proves no preexisting visibility/focus emulation is active. Leave
    // visible pages (including another tool's emulation) entirely untouched.
    await rendering.claim();renderingOwned=true;
    await send('Emulation.setFocusEmulationEnabled',{enabled:true});
    if(await visibility()!=='visible')throw new Error(viewportUnavailable);
    // Visibility emulation alone still leaves background compositor frames
    // throttled. Keep the owned renderer producing frames for virtual lists.
    // No acknowledgements: at most three 1px frames are emitted, not retained here.
    framesUncertain=true;
    await send('Page.startScreencast',{format:'jpeg',quality:0,maxWidth:1,maxHeight:1,everyNthFrame:1});
    framesOwned=true;framesUncertain=false;
    return restore;
  };
  if(rendering) {
    try {
      if(await rendering.has()) {
        // Focus emulation is released with its DevTools session. Retire only
        // our stale storage marker; a visible page may belong to the user or
        // another tool, so do not send a cross-session disable command.
        await rendering.release();
      }
    }catch {throw new Error(viewportCleanupPending);}
  }
  const usable=async()=>{
    const metrics=(await send('Page.getLayoutMetrics'))?.cssLayoutViewport;
    const width=metrics?.clientWidth,height=metrics?.clientHeight;
    if (!Number.isFinite(width) || !Number.isFinite(height) || width<0 || height<0) throw new Error(viewportUnavailable);
    return width>0 && height>0;
  };
  let pending;
  try {pending=await ownership?.has();} catch {throw new Error(viewportCleanupPending);}
  // An interrupted worker leaves its marker for the next normally authorized attachment.
  if (pending) {
    owned=true;
    // Clear alone can leave metrics set by a detached session in place.
    try {await send('Emulation.setDeviceMetricsOverride',{width:0,height:0,deviceScaleFactor:0,mobile:false});}
    catch {throw new Error(viewportCleanupPending);}
    await restore();
  }
  try {
    if (await usable()) return await prepareRendering();
    await ownership?.claim();
    owned=true;
    await send('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:0,mobile:false});
    for (let attempt=0;attempt<5;attempt++) {
      if (await usable()) return await prepareRendering();
      await new Promise(resolve=>setTimeout(resolve,50));
    }
    throw new Error(viewportUnavailable);
  } catch {
    await restore();
    throw new Error(viewportUnavailable);
  }
}
