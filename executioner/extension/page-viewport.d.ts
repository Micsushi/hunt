export const viewportUnavailable:string;
export const pagePreparationUnavailable:string;
export const viewportCleanupPending:string;
export interface ViewportOwnership {has():Promise<boolean>;claim():Promise<void>;release():Promise<void>;rendering?:{has():Promise<boolean>;claim():Promise<void>;release():Promise<void>}}
export function viewportOwnership(targetId:string,storage?:{get(key:string):Promise<Record<string,unknown>>;set(value:Record<string,unknown>):Promise<void>;remove(key:string):Promise<void>}):ViewportOwnership;
export function preparePageViewport(send:(method:string,params?:Record<string,unknown>)=>Promise<any>,ownership?:ViewportOwnership,options?:{renderHidden?:boolean}):Promise<()=>Promise<void>>;
